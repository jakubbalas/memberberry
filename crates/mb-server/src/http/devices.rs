//! Device sign-in on the user's server (`SPEC.md` §6.8.1, E36).
//!
//! The approval page a signed-in user sees in their browser, the exchange a device makes for
//! its token, and the routes a device uses to learn who it is and to disconnect. A device
//! token acts as its user on content routes through [`AppState::device_user`], and nowhere
//! else: administration authenticates signed sessions only.

use super::*;

/// How many code exchanges one address may attempt per minute.
const MAX_DEVICE_EXCHANGES_PER_MINUTE: u32 = 10;

/// The authorization request, as it arrives in the approval page's query or form.
#[derive(Debug, Default, Deserialize)]
pub(super) struct AuthorizeRequest {
    #[serde(default)]
    redirect_uri: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    code_challenge: String,
    #[serde(default)]
    code_challenge_method: String,
    #[serde(default)]
    name: String,
    /// `approve` or `deny`, on the form only.
    #[serde(default)]
    decision: String,
}

impl AuthorizeRequest {
    fn is_valid(&self) -> bool {
        mb_auth::valid_redirect_uri(&self.redirect_uri)
            && mb_auth::valid_pkce_value(&self.state)
            && mb_auth::valid_pkce_value(&self.code_challenge)
            && self.code_challenge_method == "S256"
            && mb_auth::valid_device_name(&self.name)
    }

    /// The approval page's own address, for returning to after signing in.
    fn path(&self) -> String {
        let mut out = String::from("/devices/authorize?redirect_uri=");
        push_query_component(&mut out, &self.redirect_uri);
        out.push_str("&state=");
        push_query_component(&mut out, &self.state);
        out.push_str("&code_challenge=");
        push_query_component(&mut out, &self.code_challenge);
        out.push_str("&code_challenge_method=S256&name=");
        push_query_component(&mut out, &self.name);
        out
    }
}

/// Whether `next` may follow a sign-in: only back to a device approval, so the sign-in form
/// cannot be made into an open redirect.
pub(super) fn valid_login_next(next: &str) -> bool {
    next.starts_with("/devices/authorize?")
        && next
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'\\' && b != b'"')
}

/// `GET /devices/authorize`: the approval page, or sign-in first.
pub(super) async fn authorize_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(request): Query<AuthorizeRequest>,
) -> Response {
    if !request.is_valid() {
        return invalid_request();
    }
    let Some(user) = state.signed_in_user(&headers) else {
        return page_with(
            PagePolicy::SignIn,
            "Sign in",
            &login_form_returning(&state.sign_in_options(), None, "", &request.path()),
        )
        .into_response();
    };
    page_with(
        PagePolicy::DeviceApproval,
        "Connect a device",
        &approval_form(&request, &user),
    )
    .into_response()
}

/// `POST /devices/authorize`: Approve or Deny, then back to the device.
pub(super) async fn authorize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(request): Form<AuthorizeRequest>,
) -> Response {
    if !request.is_valid() || !onboarding::same_origin(&headers) {
        return invalid_request();
    }
    let Some(user) = state.signed_in_user(&headers) else {
        return invalid_request();
    };
    let location = match request.decision.as_str() {
        "approve" => {
            let code = {
                let Ok(auth) = state.security.auth.lock() else {
                    return server_error(&Error::Auth("authentication lock poisoned".into()));
                };
                match auth.approve_device(mb_auth::DeviceApproval {
                    user_id: user.id,
                    device_name: &request.name,
                    redirect_uri: &request.redirect_uri,
                    code_challenge: &request.code_challenge,
                }) {
                    Ok(code) => code,
                    Err(error) => return server_error(&Error::Auth(error.to_string())),
                }
            };
            if let Err(error) = state.audit_device(&user.username, "approved", AuditResult::Success)
            {
                return server_error(&error);
            }
            format!(
                "{}?code={}&state={}",
                request.redirect_uri,
                code.expose_secret(),
                request.state
            )
        }
        "deny" => format!(
            "{}?error=access_denied&state={}",
            request.redirect_uri, request.state
        ),
        _ => return invalid_request(),
    };
    // why: every part of `location` was validated to URL-safe characters above, so nothing
    // here needs encoding and nothing from the request can add a header or a second URL.
    (StatusCode::SEE_OTHER, [(header::LOCATION, location)]).into_response()
}

/// The device's half of the exchange.
#[derive(Debug, Deserialize)]
pub(super) struct TokenRequest {
    code: String,
    code_verifier: String,
    redirect_uri: String,
}

#[derive(Debug, Serialize)]
struct TokenResponse<'a> {
    token: &'a str,
    device_id: i64,
    username: &'a str,
    display_name: &'a str,
}

/// `POST /api/v1/devices/token`: a code and its verifier for a device token.
pub(super) async fn token(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(request): Json<TokenRequest>,
) -> Response {
    if !state.allow_device_exchange(peer.ip()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "slow_down"})),
        )
            .into_response();
    }
    let Some(code) = mb_auth::DeviceCode::from_secret(&request.code) else {
        return invalid_grant();
    };
    let grant = {
        let Ok(mut auth) = state.security.auth.lock() else {
            return server_error(&Error::Auth("authentication lock poisoned".into()));
        };
        match auth.exchange_device_code(&code, &request.code_verifier, &request.redirect_uri) {
            Ok(grant) => grant,
            Err(error) => return server_error(&Error::Auth(error.to_string())),
        }
    };
    let Some(grant) = grant else {
        return invalid_grant();
    };
    if let Err(error) =
        state.audit_device(&grant.user.username, "token issued", AuditResult::Success)
    {
        return server_error(&error);
    }
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(TokenResponse {
            token: grant.token.expose_secret(),
            device_id: grant.device_id.get(),
            username: &grant.user.username,
            display_name: &grant.user.display_name,
        }),
    )
        .into_response()
}

#[derive(Debug, Serialize)]
struct DeviceSelf<'a> {
    username: &'a str,
    display_name: &'a str,
    device_id: i64,
    device_name: &'a str,
}

/// `GET /api/v1/devices/self`: who this device token acts as.
pub(super) async fn whoami(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(identity) = state.device_identity(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    Json(DeviceSelf {
        username: &identity.user.username,
        display_name: &identity.user.display_name,
        device_id: identity.device_id.get(),
        device_name: &identity.device_name,
    })
    .into_response()
}

/// `DELETE /api/v1/devices/self`: the device disconnects itself.
pub(super) async fn revoke_self(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let Some(identity) = state.device_identity(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(token) = bearer_token(&headers).and_then(mb_auth::DeviceToken::from_secret) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let revoked = state
        .security
        .auth
        .lock()
        .map_err(|_| Error::Auth("authentication lock poisoned".into()))
        .and_then(|auth| {
            auth.revoke_device_token(&token)
                .map_err(|error| Error::Auth(error.to_string()))
        });
    if let Err(error) = revoked {
        return server_error(&error);
    }
    if let Err(error) = state.audit_device(&identity.user.username, "revoked", AuditResult::Success)
    {
        return server_error(&error);
    }
    StatusCode::NO_CONTENT.into_response()
}

impl AppState {
    /// The user a device token acts as, for content routes only.
    pub(super) fn device_user(&self, headers: &HeaderMap) -> Option<Username> {
        let identity = self.device_identity(headers)?;
        Username::parse(&identity.user.username).ok()
    }

    fn device_identity(&self, headers: &HeaderMap) -> Option<mb_auth::DeviceIdentity> {
        let token = mb_auth::DeviceToken::from_secret(bearer_token(headers)?)?;
        let auth = self.security.auth.lock().ok()?;
        auth.authenticate_device_token(&token).ok()?
    }

    /// The signed-in browser user, by session cookie only.
    fn signed_in_user(&self, headers: &HeaderMap) -> Option<mb_auth::User> {
        let username = self.authenticated_user(headers)?;
        let auth = self.security.auth.lock().ok()?;
        auth.user_by_username(username.as_str())
            .ok()
            .flatten()
            .filter(|user| !user.disabled)
    }

    fn allow_device_exchange(&self, peer: IpAddr) -> bool {
        let Ok(mut budgets) = self.device_budgets.lock() else {
            return false;
        };
        let now = std::time::Instant::now();
        budgets.retain(|_, budget| {
            now.duration_since(budget.window) < std::time::Duration::from_secs(60)
        });
        let budget = budgets.entry(peer).or_insert_with(ClipBudget::new);
        if budget.used >= MAX_DEVICE_EXCHANGES_PER_MINUTE {
            return false;
        }
        budget.used += 1;
        true
    }

    fn audit_device(&self, actor: &str, what: &str, result: AuditResult) -> Result<(), Error> {
        let Some(audit) = &self.security.audit else {
            return Ok(());
        };
        let targets = [what.to_string()];
        audit
            .append(&AuditEvent {
                timestamp: &crate::audit::unix_seconds().to_string(),
                actor: Some(actor),
                source_ip: None,
                vault: None,
                action: AuditAction::Device,
                targets: &targets,
                result,
            })
            .map_err(|error| Error::Auth(format!("writing audit log: {error}")))
    }
}

fn approval_form(request: &AuthorizeRequest, user: &mb_auth::User) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str("<form class=\"mb-form\" method=\"post\" action=\"/devices/authorize\">");
    out.push_str("<p><strong>");
    push_escaped_text(&mut out, &request.name);
    out.push_str("</strong> wants to connect to your account, <strong>");
    push_escaped_text(&mut out, &user.display_name);
    out.push_str("</strong> (");
    push_escaped_text(&mut out, &user.username);
    out.push_str(
        ").</p><p>It will be able to read and edit every note you can, from that device, \
                  until you disconnect it.</p><p class=\"mb-empty\">If you did not just start \
                  connecting a device from the Memberberry app, choose Deny.</p>",
    );
    for (name, value) in [
        ("redirect_uri", request.redirect_uri.as_str()),
        ("state", request.state.as_str()),
        ("code_challenge", request.code_challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("name", request.name.as_str()),
    ] {
        out.push_str("<input type=\"hidden\" name=\"");
        out.push_str(name);
        out.push_str("\" value=\"");
        push_escaped_attr(&mut out, value);
        out.push_str("\" />");
    }
    out.push_str(
        "<div class=\"mb-actions\">\
         <button class=\"mb-button mb-action\" type=\"submit\" name=\"decision\" value=\"approve\" autofocus>Approve</button>\
         <button class=\"mb-button mb-quiet mb-action\" type=\"submit\" name=\"decision\" value=\"deny\">Deny</button>\
         </div></form>",
    );
    out
}

fn invalid_request() -> Response {
    (
        StatusCode::BAD_REQUEST,
        page(
            "Connect a device",
            "<p class=\"mb-empty\">This link to connect a device is not valid. Start again from \
             the Memberberry app.</p>",
        ),
    )
        .into_response()
}

fn invalid_grant() -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"error": "invalid_grant"})),
    )
        .into_response()
}

/// Percent-encodes everything outside RFC 3986's unreserved set.
fn push_query_component(out: &mut String, value: &str) {
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
}
