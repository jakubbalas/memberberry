//! Signed-session administration of the MCP transport and personal tokens.

use std::collections::BTreeSet;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use mb_auth::{AuthDb, User, mcp::TokenUpdate};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{
    AppState, Arc, AuthorizedVault, PagePolicy, json_no_store, json_no_store_status, mcp,
    onboarding, page_with, workspace_denied,
};

const HTML: &str = include_str!("../../../../web/src/admin/mcp-settings.html");
const SCRIPT: &str = include_str!("../../../../web/src/admin/mcp-settings.js");

fn admin(state: &AppState, headers: &HeaderMap) -> Option<User> {
    let cookie = super::session_cookie(headers)?;
    state
        .security
        .auth
        .lock()
        .ok()?
        .authenticate_signed_session_cookie(cookie)
        .ok()?
        .filter(|user| user.is_admin && !user.disabled)
}

pub(super) async fn page(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if admin(&state, &headers).is_none() {
        return workspace_denied();
    }
    let mut response = page_with(PagePolicy::McpSettings, "MCP access", HTML).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(super) async fn script() -> Response {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
        SCRIPT,
    )
        .into_response()
}

fn unavailable() -> Response {
    json_no_store_status(
        StatusCode::SERVICE_UNAVAILABLE,
        &json!({"error":"Settings are unavailable."}),
    )
}

fn bad_request(message: &str) -> Response {
    json_no_store_status(StatusCode::BAD_REQUEST, &json!({"error":message}))
}

fn conflict() -> Response {
    json_no_store_status(
        StatusCode::CONFLICT,
        &json!({"error":"Settings changed in another window."}),
    )
}

#[derive(Serialize)]
struct VaultEntry {
    id: String,
    name: String,
    #[serde(skip)]
    key: String,
}

fn eligible(state: &AppState, user: &User) -> Option<Vec<VaultEntry>> {
    let username = mb_core::Username::parse(&user.username).ok()?;
    let mut entries = Vec::new();
    for vault in state.vault_snapshot() {
        let Some(access) = state.access_for(vault.slug()) else {
            continue;
        };
        let view = AuthorizedVault::new(&vault, &access, username.clone());
        if !view.has_any_access().unwrap_or(false) {
            continue;
        }
        let Some(key) = mcp::registration_key(&vault) else {
            continue;
        };
        entries.push(VaultEntry {
            id: vault.slug().to_string(),
            name: vault.name().to_owned(),
            key,
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Some(entries)
}

fn resolve_vault_keys(vaults: &[VaultEntry], ids: &BTreeSet<String>) -> Option<BTreeSet<String>> {
    if ids.is_empty() {
        return None;
    }
    let keys: BTreeSet<_> = vaults
        .iter()
        .filter(|vault| ids.contains(&vault.id))
        .map(|vault| vault.key.clone())
        .collect();
    // why: unknown and unreadable vault slugs both fail the length check identically,
    // preserving the invisibility rule (§6.5).
    (keys.len() == ids.len()).then_some(keys)
}

fn snapshot(state: &AppState, auth: &AuthDb, user: &User, vaults: &[VaultEntry]) -> Response {
    let (Ok(settings), Ok(tokens)) = (auth.mcp_settings(), auth.list_mcp_tokens(user.id)) else {
        return unavailable();
    };
    let tokens: Vec<_> = tokens
        .into_iter()
        .map(|token| {
            // Only emit vault IDs this administrator can currently discover, in display order.
            let assigned: Vec<_> = vaults
                .iter()
                .filter(|vault| token.vaults.contains(&vault.key))
                .map(|vault| vault.id.as_str())
                .collect();
            json!({
                "id": token.id,
                "name": token.name,
                "created_at": token.created_at,
                "last_used_at": token.last_used_at,
                "revoked_at": token.revoked_at,
                "vaults": assigned,
            })
        })
        .collect();
    json_no_store(&json!({
        "endpoint": state.mcp.as_ref().map(|listener| listener.endpoint.as_str()),
        "enabled": settings.enabled,
        "revision": settings.revision,
        "vaults": vaults,
        "tokens": tokens,
    }))
}

pub(super) async fn load(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let Some(user) = admin(&state, &headers) else {
        return workspace_denied();
    };
    let Some(vaults) = eligible(&state, &user) else {
        return unavailable();
    };
    let Ok(auth) = state.security.auth.lock() else {
        return unavailable();
    };
    snapshot(&state, &auth, &user, &vaults)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Update {
    revision: i64,
    enabled: bool,
}

pub(super) async fn change(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(update): Json<Update>,
) -> Response {
    let Some(user) = admin(&state, &headers).filter(|_| onboarding::same_origin(&headers)) else {
        return workspace_denied();
    };
    if state.mcp.is_none() {
        return unavailable();
    }
    let Some(vaults) = eligible(&state, &user) else {
        return unavailable();
    };
    let Ok(mut auth) = state.security.auth.lock() else {
        return unavailable();
    };
    match auth.set_mcp_enabled(update.revision, update.enabled) {
        Ok(true) => snapshot(&state, &auth, &user, &vaults),
        Ok(false) => conflict(),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    name: String,
    vaults: BTreeSet<String>,
}

pub(super) async fn create(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(create): Json<Create>,
) -> Response {
    let Some(user) = admin(&state, &headers).filter(|_| onboarding::same_origin(&headers)) else {
        return workspace_denied();
    };
    if state.mcp.is_none() {
        return unavailable();
    }
    let name = create.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return bad_request("Enter a name of up to 80 characters.");
    }
    let Some(vaults) = eligible(&state, &user) else {
        return unavailable();
    };
    let Some(keys) = resolve_vault_keys(&vaults, &create.vaults) else {
        return bad_request("Select at least one vault.");
    };
    let Ok(mut auth) = state.security.auth.lock() else {
        return unavailable();
    };
    match auth.create_mcp_token(user.id, name, &keys) {
        Ok((id, token)) => json_no_store_status(
            StatusCode::CREATED,
            &json!({"id": id, "secret": token.expose_secret()}),
        ),
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateToken {
    revision: i64,
    vaults: BTreeSet<String>,
}

pub(super) async fn update_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(update): Json<UpdateToken>,
) -> Response {
    let Some(user) = admin(&state, &headers).filter(|_| onboarding::same_origin(&headers)) else {
        return workspace_denied();
    };
    if state.mcp.is_none() {
        return unavailable();
    }
    let Some(vaults) = eligible(&state, &user) else {
        return unavailable();
    };
    let Some(keys) = resolve_vault_keys(&vaults, &update.vaults) else {
        return bad_request("Select at least one vault.");
    };
    let Ok(mut auth) = state.security.auth.lock() else {
        return unavailable();
    };
    match auth.update_mcp_token_vaults(user.id, &id, update.revision, &keys) {
        Ok(TokenUpdate::Updated) => snapshot(&state, &auth, &user, &vaults),
        Ok(TokenUpdate::Conflict) => conflict(),
        Ok(TokenUpdate::NotFound) => workspace_denied(),
        Err(_) => unavailable(),
    }
}

pub(super) async fn revoke(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let Some(user) = admin(&state, &headers).filter(|_| onboarding::same_origin(&headers)) else {
        return workspace_denied();
    };
    let Ok(mut auth) = state.security.auth.lock() else {
        return unavailable();
    };
    if auth.revoke_mcp_token(user.id, &id).is_err() {
        return unavailable();
    }
    (
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response()
}
