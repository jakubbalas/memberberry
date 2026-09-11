//! Browser-first server setup and administrator-owned vault creation (§6.1, §6.8).

use std::io::Write;
use std::path::Path;

use super::*;

#[derive(Debug)]
pub(super) struct VaultManagement {
    pub(super) root: PathBuf,
    config: PathBuf,
    allow_setup: bool,
    writer: Mutex<()>,
}

impl AppState {
    /// Enables UI vault creation beside this configuration file.
    ///
    /// First-account setup must only be enabled for a loopback-bound listener.
    /// Existing registered vaults and their policies are never changed.
    pub fn with_vault_management(
        mut self,
        config: PathBuf,
        allow_setup: bool,
    ) -> Result<Self, Error> {
        let config = std::path::absolute(config).map_err(management_error)?;
        let parent = config.parent().ok_or(Error::NotFound)?;
        let root = parent.join("vaults");
        std::fs::create_dir_all(&root).map_err(management_error)?;
        self.management = Some(VaultManagement {
            root: root.canonicalize().map_err(management_error)?,
            config,
            allow_setup,
            writer: Mutex::new(()),
        });
        Ok(self)
    }
}

fn management_error(error: impl std::fmt::Display) -> Error {
    Error::Config(format!("vault management: {error}"))
}

pub(super) fn needs_setup(state: &AppState) -> bool {
    state
        .security
        .auth
        .lock()
        .is_ok_and(|auth| auth.needs_setup().unwrap_or(false))
}

fn local_setup(state: &AppState, headers: &HeaderMap, peer: Option<IpAddr>) -> bool {
    state
        .management
        .as_ref()
        .is_some_and(|management| management.allow_setup)
        && peer.is_some_and(|address| address.is_loopback())
        && headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            .and_then(|host| reqwest::Url::parse(&format!("http://{host}")).ok())
            .is_some_and(|url| matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(origin) = reqwest::Url::parse(origin) else {
        return false;
    };
    let Ok(expected) = reqwest::Url::parse(&format!("{}://{host}", origin.scheme())) else {
        return false;
    };
    matches!(origin.scheme(), "http" | "https")
        && origin.origin() == expected.origin()
        && headers
            .get("sec-fetch-site")
            .is_none_or(|value| value != "cross-site")
}

fn form_page(title: &str, body: &str) -> Response {
    let mut response = page_with(PagePolicy::SignIn, title, body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(super) async fn setup_page(
    State(state): State<Arc<AppState>>,
    PeerIp(peer): PeerIp,
    headers: HeaderMap,
) -> Response {
    if !needs_setup(&state) {
        return not_found_page();
    }
    if !local_setup(&state, &headers, peer) {
        return (StatusCode::FORBIDDEN, page("Set up on this computer",
            "<p class=\"mb-empty\">For your security, create the first account from localhost with a loopback-bound server, before exposing Memberberry to a network. Remote administrators can also use the existing user setup command.</p>")).into_response();
    }
    setup_form(None)
}

fn setup_form(error: Option<&str>) -> Response {
    let mut body = String::from(
        "<p class=\"mb-empty\">Welcome to your notebook. First, make an account just for you. Next, create a vault for your notes.</p>",
    );
    append_error(&mut body, error);
    body.push_str(r#"<form class="mb-form" method="post" action="/setup">
<label class="mb-field">Your name<input name="display_name" autocomplete="name" maxlength="120" required /></label>
<label class="mb-field">Username<input name="username" autocomplete="username" maxlength="64" required aria-describedby="username-help" /></label>
<p id="username-help" class="mb-empty">Use lower-case letters, numbers, hyphens or underscores.</p>
<label class="mb-field">Password<input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="1024" required /></label>
<label class="mb-field">Confirm password<input type="password" name="confirmation" autocomplete="new-password" minlength="12" maxlength="1024" required /></label>
<button class="mb-button" type="submit">Create account</button>
</form><p class="mb-empty">Your account stays on this server. No cloud account or telemetry.</p>"#);
    form_page("Make yourself at home", &body)
}

#[derive(Deserialize)]
pub(super) struct SetupForm {
    display_name: String,
    username: String,
    password: String,
    confirmation: String,
}

pub(super) async fn setup(
    State(state): State<Arc<AppState>>,
    PeerIp(peer): PeerIp,
    headers: HeaderMap,
    Form(form): Form<SetupForm>,
) -> Response {
    if !needs_setup(&state) {
        return not_found_page();
    }
    if !local_setup(&state, &headers, peer) || !same_origin(&headers) {
        return workspace_denied();
    }
    if form.password != form.confirmation {
        return (
            StatusCode::BAD_REQUEST,
            setup_form(Some("The passwords do not match. Please try again.")),
        )
            .into_response();
    }
    let created = {
        let Ok(mut auth) = state.security.auth.lock() else {
            return workspace_denied();
        };
        auth.setup_first_user(mb_auth::NewUser {
            username: form.username.trim(),
            display_name: form.display_name.trim(),
            password: &form.password,
        })
    };
    match created {
        Ok(_) => {
            login(
                State(state),
                Form(LoginForm {
                    username: form.username.trim().to_string(),
                    password: form.password,
                }),
            )
            .await
        }
        Err(mb_auth::Error::SetupAlreadyComplete) => not_found_page(),
        Err(error) => {
            eprintln!("memberberry setup: {error}");
            (StatusCode::BAD_REQUEST, setup_form(Some("Could not create the account. Check your name and username, and use a password of at least 12 characters."))).into_response()
        }
    }
}

fn append_error(body: &mut String, error: Option<&str>) {
    if let Some(error) = error {
        body.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(body, error);
        body.push_str("</p>");
    }
}

pub(super) async fn new_vault_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if !state.is_server_admin(&headers) {
        return workspace_denied();
    }
    new_vault_form(&state, None, "", "")
}

fn new_vault_form(state: &AppState, error: Option<&str>, name: &str, slug: &str) -> Response {
    let Some(management) = &state.management else {
        return (StatusCode::SERVICE_UNAVAILABLE, form_page("New vault", "<p class=\"mb-empty\">Vault creation is not configured on this server. Ask your administrator to enable it.</p>")).into_response();
    };
    let mut body = String::from(
        "<p class=\"mb-empty\">Think of a vault as a notebook: a home for related notes, with its own settings and sharing.</p>",
    );
    append_error(&mut body, error);
    body.push_str(r#"<form class="mb-form" method="post" action="/vaults/new">
<label class="mb-field">Vault name<input name="name" autocomplete="off" maxlength="120" placeholder="Personal notebook" required value=""#);
    push_escaped_attr(&mut body, name);
    body.push_str(r#"" /></label>
<label class="mb-field">Vault address<input name="slug" autocomplete="off" maxlength="64" placeholder="personal" required aria-describedby="address-help" value=""#);
    push_escaped_attr(&mut body, slug);
    body.push_str(r#"" /></label>
<p id="address-help" class="mb-empty">A short, unique address. Use lower-case letters, numbers and hyphens, for example personal or work-notes.</p>
<button class="mb-button" type="submit">Create vault</button>
<a href="/">Back to your vaults</a>
</form><p class="mb-empty">Only you can access this vault until you share it. Notes are plain Markdown files, stored on this server in <code>"#);
    push_escaped_text(&mut body, &management.root.display().to_string());
    body.push_str("/&lt;vault-address&gt;/notes</code>. You can read and back them up without Memberberry.</p>");
    form_page("Start a new notebook", &body)
}

#[derive(Deserialize)]
pub(super) struct VaultForm {
    name: String,
    slug: String,
}

pub(super) async fn create_vault(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<VaultForm>,
) -> Response {
    if !state.is_server_admin(&headers) || !same_origin(&headers) {
        return workspace_denied();
    }
    let Some(actor) = state.authenticated_user(&headers) else {
        return workspace_denied();
    };
    let name = form.name.trim();
    let slug = form.slug.trim();
    if name.is_empty()
        || name.chars().count() > 120
        || name.chars().any(char::is_control)
        || Slug::parse(slug).is_err()
    {
        return (StatusCode::BAD_REQUEST, new_vault_form(&state, Some("Add a name and a valid vault address, without spaces or a leading or trailing hyphen."), name, slug)).into_response();
    }
    let created = register_vault(&state, &actor, name, slug);
    match created {
        Ok(()) => axum::response::Redirect::to(&format!("/v/{slug}")).into_response(),
        Err(error) => {
            eprintln!("memberberry vault creation: {error}");
            (StatusCode::CONFLICT, new_vault_form(&state, Some("Could not create this vault. Try a different address. If it still fails, check the server's storage permissions and logs."), name, slug)).into_response()
        }
    }
}

fn register_vault(
    state: &AppState,
    actor: &Username,
    name: &str,
    raw_slug: &str,
) -> Result<(), Error> {
    let management = state.management.as_ref().ok_or(Error::NotFound)?;
    let _writer = management.writer.lock().map_err(management_error)?;
    let mut registered = state.vaults.write().map_err(management_error)?;
    let mut policies = state.security.access.write().map_err(management_error)?;
    let slug = Slug::parse(raw_slug)?;
    let mut config = crate::ServerConfig::load(&management.config)?;
    if registered.contains_key(&slug) || config.vaults.iter().any(|entry| entry.slug == raw_slug) {
        return Err(Error::NotFound);
    }
    let root = management.root.join(raw_slug);
    std::fs::create_dir(&root).map_err(management_error)?;
    let prepared = (|| {
        std::fs::create_dir(root.join("notes")).map_err(management_error)?;
        let policy = mb_core::Access::new(
            vec![mb_core::Member {
                user: actor.clone(),
                role: mb_core::Role::Owner,
            }],
            vec![],
        )
        .map_err(management_error)?;
        AccessFile::from_access(policy.clone())
            .save(&root)
            .map_err(management_error)?;
        let vault = Vault::open(slug.clone(), name, &root)?;
        config.vaults.push(crate::config::VaultEntry {
            slug: raw_slug.to_string(),
            name: Some(name.to_string()),
            path: root.to_str().ok_or(Error::NotFound)?.to_string(),
            media: crate::MediaBackendConfig::Local,
        });
        save_config(&management.config, &config)?;
        Ok::<_, Error>((vault, policy))
    })();
    let (vault, policy) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            if let Err(cleanup) = std::fs::remove_dir_all(&root) {
                eprintln!("memberberry vault rollback: {cleanup}");
            }
            return Err(error);
        }
    };
    policies.insert(
        slug.clone(),
        VaultAccess {
            policy: Arc::new(policy),
            source: FileStamp::of(&root.join("access.toml")),
        },
    );
    registered.insert(slug, Arc::new(vault.clone()));
    drop(policies);
    drop(registered);
    state.audit_note(AuditAction::VaultCreated, actor, &vault, raw_slug)?;
    Ok(())
}

fn save_config(path: &Path, config: &crate::ServerConfig) -> Result<(), Error> {
    use rand_core::RngCore;
    let mut random = [0_u8; 16];
    rand_core::OsRng
        .try_fill_bytes(&mut random)
        .map_err(management_error)?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = path.with_extension(format!("{suffix}.tmp"));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(management_error)?;
        file.write_all(config.to_toml()?.as_bytes())
            .map_err(management_error)?;
        file.sync_all().map_err(management_error)?;
        std::fs::rename(&temporary, path).map_err(management_error)
    })();
    if result.is_err()
        && temporary.exists()
        && let Err(error) = std::fs::remove_file(&temporary)
    {
        eprintln!("memberberry config cleanup: {error}");
    }
    result
}
