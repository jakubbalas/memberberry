//! E29 HTML entry; the static bundle is public, administrator intent/data are not.
use super::*;
pub(super) fn administrator(state: &AppState, headers: &HeaderMap) -> bool {
    #[cfg(target_os = "linux")]
    {
        vault_registration::administrator(state, headers)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, headers);
        false
    }
}
#[cfg(test)]
static BUNDLE_READS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(test)]
static AFTER_READ: Mutex<
    Option<(
        tokio::sync::oneshot::Sender<()>,
        std::sync::mpsc::Receiver<()>,
    )>,
> = Mutex::new(None);
// why: neutral fallback pages include the shared inline design tokens; no inline script.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
fn response(status: StatusCode, body: Html<String>) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
}
fn denied() -> Response {
    response(
        StatusCode::NOT_FOUND,
        super::page("Not found", "<p class=\"mb-empty\">No such page.</p>"),
    )
}
fn bundle(state: &AppState) -> Option<String> {
    use std::io::Read;
    let file = {
        let path = state.web_root.as_ref()?.join("add-vault.html");
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // why: an operator's accidental FIFO/symlink must not hang or escape this read.
            options.custom_flags(
                i32::try_from((rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOFOLLOW).bits())
                    .ok()?,
            );
        }
        #[cfg(test)]
        BUNDLE_READS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        options.open(path).ok()?
    };
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > 262_144 {
        return None;
    }
    let mut html = String::new();
    file.take(262_145).read_to_string(&mut html).ok()?;
    (html.len() <= 262_144).then_some(html)
}
pub(super) async fn page(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    form_page(State(state), headers, None, "", "").await
}

pub(super) async fn form_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    error: Option<&str>,
    name: &str,
    slug: &str,
) -> Response {
    // why: HTML is a protected entry, not the public static asset route. No bundle/config
    // or project metadata lookup may run before current signed-admin authorization.
    if !administrator(&state, &headers) {
        return denied();
    }
    let worker = state.clone();
    let worker_headers = headers.clone();
    let html = tokio::task::spawn_blocking(move || {
        if !administrator(&worker, &worker_headers) {
            return None;
        }
        let html = bundle(&worker);
        #[cfg(test)]
        if let Ok(mut pause) = AFTER_READ.lock()
            && let Some((ready, release)) = pause.take()
        {
            let _ = ready.send(());
            let _ = release.recv();
        }
        html
    })
    .await
    .ok()
    .flatten();
    if !administrator(&state, &headers) {
        return denied();
    }
    match html {
        Some(html) => {
            let mut escaped_name = String::new();
            let mut escaped_slug = String::new();
            let mut escaped_error = String::new();
            let mut error_text = String::new();
            let mut escaped_root = String::new();
            push_escaped_attr(&mut escaped_name, name);
            push_escaped_attr(&mut escaped_slug, slug);
            push_escaped_attr(&mut escaped_error, error.unwrap_or(""));
            push_escaped_text(&mut error_text, error.unwrap_or(""));
            if let Some(management) = &state.management {
                push_escaped_text(&mut escaped_root, &management.root.display().to_string());
            }
            // why: substitute only trusted, unique markup anchors; user text is escaped first.
            let html = html
                .replace(
                    "id=\"vault-name\"",
                    &format!("value=\"{escaped_name}\" id=\"vault-name\""),
                )
                .replace(
                    "id=\"vault-slug\"",
                    &format!("value=\"{escaped_slug}\" id=\"vault-slug\""),
                )
                .replace(
                    "data-server-error=\"\"",
                    &format!("data-server-error=\"{escaped_error}\""),
                )
                .replace("<!-- server-error -->", &error_text)
                .replace("<!-- managed-root -->", &escaped_root);
            response(StatusCode::OK, Html(html))
        }
        None => response(
            StatusCode::SERVICE_UNAVAILABLE,
            super::page(
                "New vault unavailable",
                "<p class=\"mb-empty\">The folder interface is unavailable. <a href=\"/\">Back to your vaults</a>.</p>",
            ),
        ),
    }
}
#[cfg(all(test, target_os = "linux"))]
mod tests;
