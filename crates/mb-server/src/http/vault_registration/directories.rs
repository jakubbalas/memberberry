//! E31 immediate directory creation; registration/policy/index/watch state is untouched.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryInput {
    path: String,
    directory: String,
}

struct DirectorySelection {
    id: VaultLocationId,
    path: RelativeDirectoryPath,
    child: DirectoryName,
}

pub(in crate::http) async fn create(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Response {
    let (parts, body) = request.into_parts();
    if registration_cookie(&parts.headers).is_err() || !origin(&parts.headers) {
        return Refusal::NotFound.response();
    }
    let slot = match state.registration.reserve() {
        Ok(slot) => slot,
        Err(_) => return Refusal::NotFound.response(),
    };
    let worker = state.clone();
    let headers = parts.headers.clone();
    let authorized =
        match tokio::task::spawn_blocking(move || (actor(&worker, &headers), slot)).await {
            Ok((Ok(actor), slot)) => (actor, slot),
            _ => return Refusal::NotFound.response(),
        };
    if single_header(&parts.headers, header::CONTENT_TYPE) != Some("application/json")
        || parts.headers.contains_key(header::TRANSFER_ENCODING)
    {
        return Refusal::Invalid.response();
    }
    if let Err(error) = state.registration.charge() {
        return error.response();
    }
    let bytes = match axum::body::to_bytes(body, 8192).await {
        Ok(bytes) => bytes,
        Err(_) => return Refusal::Limit.response(),
    };
    let selection = match parse_directory(&parts.uri, &bytes) {
        Ok(selection) => selection,
        Err(error) => return error.response(),
    };
    let cancel = Cancel(Arc::new(AtomicBool::new(false)));
    let flag = cancel.0.clone();
    let headers = parts.headers;
    let result = tokio::task::spawn_blocking(move || {
        let (authorized, _slot) = authorized;
        let result = mkdir(&state, &headers, &authorized, &selection, &flag);
        #[cfg(test)]
        state.registration.hooks.pause(tests::Phase::Finished);
        if !authorized.same(&actor(&state, &headers)?) {
            return Err(Refusal::NotFound);
        }
        result
    })
    .await;
    match result {
        Ok(Ok(value)) => reply(StatusCode::CREATED, value),
        Ok(Err(error)) => error.response(),
        Err(_) => Refusal::Residual.response(),
    }
}

fn parse_directory(uri: &axum::http::Uri, bytes: &[u8]) -> Result<DirectorySelection, Refusal> {
    if uri.path().len() > 256 || bytes.len() > 8192 {
        return Err(Refusal::Limit);
    }
    if uri.query().is_some() {
        return Err(Refusal::Invalid);
    }
    let raw = uri
        .path()
        .strip_prefix("/api/v1/vault-locations/")
        .and_then(|s| s.strip_suffix("/directories"))
        .ok_or(Refusal::Invalid)?;
    let input: DirectoryInput = serde_json::from_slice(bytes).map_err(|_| Refusal::Invalid)?;
    if !limits::token(&input.path) || input.directory.len() > 255 {
        return Err(Refusal::Limit);
    }
    let path = RelativeDirectoryPath::for_browse(&input.path).map_err(|_| Refusal::Invalid)?;
    let child = DirectoryName::parse(&input.directory).map_err(|_| Refusal::Invalid)?;
    if !limits::token(path.child(&child).as_str()) {
        return Err(Refusal::Limit);
    }
    Ok(DirectorySelection {
        id: VaultLocationId::parse(raw).map_err(|_| Refusal::Invalid)?,
        path,
        child,
    })
}

fn mkdir(
    state: &AppState,
    headers: &HeaderMap,
    authorized: &Actor,
    selection: &DirectorySelection,
    cancel: &AtomicBool,
) -> Result<serde_json::Value, Refusal> {
    let management = state.management.as_ref().ok_or(Refusal::NotFound)?;
    let _writer = management.writer.try_lock().map_err(|_| Refusal::Busy)?;
    let active = || {
        if !authorized.same(&actor(state, headers)?) {
            return Err(Refusal::NotFound);
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(Refusal::Busy);
        }
        Ok(())
    };
    #[cfg(test)]
    state.registration.hooks.pause(tests::Phase::BeforeFs);
    active()?;
    #[cfg(test)]
    state
        .registration
        .hooks
        .before_fs
        .fetch_add(1, Ordering::Relaxed);
    let (parent, name) = config_parent(&management.config)?;
    let (config, stamp, vaults) = checked_config(state, &parent, &name)?;
    let unchanged_config = || {
        let (now_parent, now_name) = config_parent(&management.config)?;
        if now_name != name
            || storage::identity(&now_parent)? != storage::identity(&parent)?
            || !storage::read_optional(&parent, &name, storage::MAX_FILE)?
                .is_some_and(|(s, _)| s == stamp)
        {
            return Err(Refusal::Conflict);
        }
        Ok(())
    };
    // why: reuse descriptor/overlap authority without constructing a registration intent.
    let current = discovery::registration_pin(
        &config,
        &selection.id,
        &selection.path,
        Some(&selection.child),
        &vaults.iter().map(Arc::as_ref).collect::<Vec<_>>(),
    )
    .map_err(discovery_error)?;
    let child = &selection.child;
    #[cfg(test)]
    state.registration.hooks.pause(tests::Phase::BeforeMutation);
    active()?;
    current
        .revalidate(&selection.path)
        .map_err(discovery_error)?;
    unchanged_config()?;
    // why: current enabled-admin authority cannot linearize a revocation before mkdir.
    // No recursive scan, probe, policy write or watcher enrollment happens under this lock.
    let auth = state.security.auth.lock().map_err(|_| Refusal::NotFound)?;
    if !authorized.same(&signed_actor(&auth, registration_cookie(headers)?)?) {
        return Err(Refusal::NotFound);
    }
    let mut created = storage::OwnedDirectory::create(current.fd(), child.as_str())?;
    drop(auth);
    let outcome = (|| {
        #[cfg(test)]
        state.registration.hooks.pause(tests::Phase::AfterCommit);
        // why: after mkdir any failure is potentially created; no 400/409/422/429 rollback claim.
        active()?;
        current
            .revalidate(&selection.path)
            .map_err(discovery_error)?;
        created.verify()?;
        #[cfg(test)]
        let synced = storage::test_io::at_boundary(
            *state
                .registration
                .hooks
                .commit_fault
                .lock()
                .map_err(|_| Refusal::Residual)?,
            || created.sync(),
        );
        #[cfg(not(test))]
        let synced = created.sync();
        created.verify()?;
        current
            .revalidate(&selection.path)
            .map_err(discovery_error)?;
        unchanged_config()?;
        let final_auth = state.security.auth.lock().map_err(|_| Refusal::NotFound)?;
        if !authorized.same(&signed_actor(&final_auth, registration_cookie(headers)?)?) {
            return Err(Refusal::NotFound);
        }
        created.verify()?;
        created.retain();
        Ok(
            serde_json::json!({"path":selection.path.child(child).as_str(),"created":true,"directory_synced":synced}),
        )
    })();
    match outcome {
        Ok(value) => Ok(value),
        Err(error) => {
            let cleaned = created.cleanup().is_ok();
            if matches!(error, Refusal::NotFound) && cleaned {
                Err(Refusal::NotFound)
            } else {
                Err(Refusal::Residual)
            }
        }
    }
}
