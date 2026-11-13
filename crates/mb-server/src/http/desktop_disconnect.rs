//! Disconnecting the desktop app from one server (`SPEC.md` §7.6.11, A50).
//!
//! Two steps, both dialogs over the vault picker. The first says what disconnecting does and
//! changes nothing. Confirming it runs one last pass: when every change made here has reached
//! the server, the device is revoked there, its token forgotten here, and the server's vaults
//! and their folders removed from this computer. When something has not — a held note, a
//! recovered one, or a server that cannot be reached while notes are kept here — nothing is
//! removed; a second dialog names what would be lost and removes it only when the user types
//! "yes".

use axum::extract::{Form, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::sync::Arc;

use super::desktop_connect::{Connect, connect_of, message_page};
use super::desktop_sync::{Unsent, host_of, remove_server_notes, unsent_while_signed_out};
use super::{
    AppState, onboarding, page, push_escaped_attr, push_escaped_text, vaults_home_with_dialog,
};
use crate::desktop::ConnectedServer;

/// The word the user types to remove changes the server does not have.
const CONFIRM_WORD: &str = "yes";

#[derive(Debug, Deserialize)]
pub(super) struct DisconnectQuery {
    #[serde(default)]
    server: String,
}

/// `GET /desktop/disconnect?server=<origin>`: the first dialog. Changes nothing.
pub(super) async fn dialog(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<DisconnectQuery>,
) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(server) = connect.server(&query.server) else {
        return home();
    };
    vaults_home_with_dialog(
        &state,
        &headers,
        StatusCode::OK,
        "Your vaults",
        &first_dialog(&state, connect, &server),
    )
}

#[derive(Debug, Deserialize)]
pub(super) struct DisconnectForm {
    #[serde(default)]
    server: String,
    /// Empty from the first dialog; what the user typed in the second.
    #[serde(default)]
    confirm: Option<String>,
}

/// `POST /desktop/disconnect`: check that nothing is left unsent, then disconnect — or ask
/// for "yes" when something is.
pub(super) async fn disconnect(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<DisconnectForm>,
) -> Response {
    let Some(connect) = connect_of(&state) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !onboarding::same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(server) = connect.server(&form.server) else {
        return home();
    };
    let typed = form.confirm.as_deref().map(str::trim);
    let confirmed = typed.is_some_and(|typed| typed.eq_ignore_ascii_case(CONFIRM_WORD));
    // why: held across the check and the removal, so no pass can write a note into a folder
    // between being found clean and being deleted.
    let _passing = connect.sync.exclusive().await;
    let token = connect.options.secrets.get(&server.origin).ok().flatten();
    let unsent = match (&token, server.signed_out) {
        (Some(token), false) => last_pass(&state, connect, &server, token).await,
        _ => unsent_while_signed_out(&state, connect, &server),
    };
    if !unsent.is_clean() && !confirmed {
        // A wrong word is an error to correct; arriving from the first dialog is not.
        let (status, error) = if typed.is_some() {
            (
                StatusCode::BAD_REQUEST,
                Some("Type yes to remove them, or cancel."),
            )
        } else {
            (StatusCode::OK, None)
        };
        return vaults_home_with_dialog(
            &state,
            &headers,
            status,
            "Your vaults",
            &unsent_dialog(&server, &unsent, error),
        );
    }
    let revoked = match &token {
        Some(token) if !server.signed_out => revoke(connect, &server, token).await,
        _ => true,
    };
    if connect.options.secrets.delete(&server.origin).is_err() {
        return message_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not disconnect",
            "Memberberry could not remove this server's key from the system keychain. Try again.",
        );
    }
    let removed = remove_server_notes(&state, connect, &server.origin);
    connect.sync.wake_now();
    if let Err(error) = removed {
        eprintln!(
            "memberberry: could not remove the notes of {}: {error}",
            server.origin
        );
        return message_page(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not disconnect",
            "Memberberry could not remove this server's notes from this computer. Try again.",
        );
    }
    if revoked {
        return home();
    }
    let mut body = String::from("<p>This app is disconnected from ");
    push_escaped_text(&mut body, &server.origin);
    body.push_str(
        ", but the server could not be reached to revoke its access. Revoke it there with \
         <code>memberberry device revoke</code>.</p><p><a class=\"mb-button mb-action\" \
         href=\"/\">Back to your vaults</a></p>",
    );
    (StatusCode::OK, page("Disconnected", &body)).into_response()
}

/// One last pass over `server`'s vaults, returning what it could not send.
async fn last_pass(
    state: &AppState,
    connect: &Connect,
    server: &ConnectedServer,
    token: &str,
) -> Unsent {
    match crate::replica::upstream::Upstream::new(&server.origin, token) {
        Ok(upstream) => {
            super::desktop_sync::pass_server(state, connect, &server.origin, &upstream).await
        }
        // why: no client means no pass, so nothing here is known to have been sent.
        Err(_) => unsent_while_signed_out(state, connect, server),
    }
}

/// Revokes this device's token on `server`. Whether the server confirmed it (or already
/// refused the token).
async fn revoke(connect: &Connect, server: &ConnectedServer, token: &str) -> bool {
    // why: revoking on the server comes first and failing it is reported, not hidden. A
    // device that forgot its token while the server still honours it is a credential nobody
    // can see or use, but anyone who copies it can.
    connect
        .client()
        .delete(format!("{}/api/v1/devices/self", server.origin))
        .bearer_auth(token)
        .send()
        .await
        .is_ok_and(|response| {
            response.status().is_success() || response.status() == StatusCode::UNAUTHORIZED
        })
}

fn home() -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, "/")]).into_response()
}

/// The first dialog: what disconnecting does, before anything is checked.
fn first_dialog(state: &AppState, connect: &Connect, server: &ConnectedServer) -> String {
    let vaults: Vec<_> = connect
        .sync
        .registered()
        .into_iter()
        .filter(|v| v.origin == server.origin)
        .collect();
    let kept: usize = vaults
        .iter()
        .filter_map(|v| state.replica_notes(&v.local).ok())
        .map(|notes| notes.len())
        .sum();
    let host = host_of(&server.origin);
    let mut out = dialog_open("mb-dialog-title", "warning");
    out.push_str("<h2 id=\"mb-dialog-title\">Disconnect ");
    push_escaped_text(&mut out, host);
    out.push_str(
        "?</h2><p>Memberberry first checks that every change made on this computer \
                  has reached the server. Then it removes the connection and ",
    );
    out.push_str(
        match vaults.len() {
            0 => "this server".to_string(),
            1 => "its vault".to_string(),
            n => format!("its {n} vaults"),
        }
        .as_str(),
    );
    out.push_str(" from this app");
    if kept > 0 {
        out.push_str(", and deletes the ");
        out.push_str(&match kept {
            1 => "note".to_string(),
            n => format!("{n} notes"),
        });
        out.push_str(" kept offline on this computer");
    }
    out.push_str(".</p><p class=\"mb-dialog-quiet\">Your notes on ");
    push_escaped_text(&mut out, host);
    out.push_str(" are not touched. You can connect again at any time.</p>");
    out.push_str("<form method=\"post\" action=\"/desktop/disconnect\">");
    push_server_field(&mut out, server);
    out.push_str(
        "<div class=\"mb-dialog-actions\"><a class=\"mb-button mb-quiet\" href=\"/\" \
         autofocus>Cancel</a><button class=\"mb-button mb-danger\" type=\"submit\">\
         Disconnect</button></div></form>",
    );
    out.push_str(DIALOG_CLOSE);
    out
}

/// The second dialog: what would be lost, and the typed confirmation that loses it.
fn unsent_dialog(server: &ConnectedServer, unsent: &Unsent, error: Option<&str>) -> String {
    let mut out = dialog_open("mb-dialog-title", "danger");
    out.push_str("<h2 id=\"mb-dialog-title\">Changes not synced</h2><p>");
    out.push_str("Some changes on this computer have not reached ");
    push_escaped_text(&mut out, host_of(&server.origin));
    out.push_str(". Disconnecting now deletes them.</p>");
    if let Some(why) = unsent.unconfirmed {
        out.push_str("<p class=\"mb-dialog-quiet\">");
        push_escaped_text(&mut out, why);
        out.push_str("</p>");
    }
    if !unsent.notes.is_empty() {
        out.push_str("<ul class=\"mb-unsent\">");
        for note in &unsent.notes {
            out.push_str("<li><span class=\"mb-unsent-path\">");
            push_escaped_text(&mut out, &note.vault);
            out.push_str(" / ");
            push_escaped_text(&mut out, note.path.trim_end_matches(".md"));
            out.push_str("</span><span class=\"mb-unsent-why\">");
            push_escaped_text(&mut out, &note.why);
            out.push_str("</span></li>");
        }
        out.push_str("</ul>");
    }
    out.push_str(
        "<p class=\"mb-dialog-quiet\">Cancel and let them sync first, or type <strong>yes</strong> \
         to delete them and disconnect.</p>",
    );
    out.push_str("<form method=\"post\" action=\"/desktop/disconnect\">");
    push_server_field(&mut out, server);
    if let Some(error) = error {
        out.push_str("<p class=\"mb-form-error\" role=\"alert\">");
        push_escaped_text(&mut out, error);
        out.push_str("</p>");
    }
    // why: `pattern` keeps the button from submitting anything but "yes" without script; the
    // handler checks again, because a form is only a suggestion to whoever posts it.
    out.push_str(
        "<label class=\"mb-field mb-confirm\">Type yes to confirm<input name=\"confirm\" \
         autocomplete=\"off\" autocapitalize=\"off\" spellcheck=\"false\" required \
         pattern=\"\\s*[Yy][Ee][Ss]\\s*\" title=\"Type yes\" autofocus /></label>\
         <div class=\"mb-dialog-actions\"><a class=\"mb-button mb-quiet\" href=\"/\">Cancel\
         </a><button class=\"mb-button mb-danger\" type=\"submit\">Delete and disconnect\
         </button></div></form>",
    );
    out.push_str(DIALOG_CLOSE);
    out
}

fn dialog_open(labelled_by: &str, tone: &str) -> String {
    let mut out = String::from(
        "<div class=\"mb-modal\"><a class=\"mb-modal-backdrop\" href=\"/\" tabindex=\"-1\" \
         aria-label=\"Cancel\"></a><section class=\"mb-dialog\" role=\"alertdialog\" \
         aria-modal=\"true\" aria-labelledby=\"",
    );
    push_escaped_attr(&mut out, labelled_by);
    out.push_str("\" data-tone=\"");
    push_escaped_attr(&mut out, tone);
    out.push_str("\"><span class=\"mb-dialog-icon\" aria-hidden=\"true\">");
    out.push_str(WARNING_MARK);
    out.push_str("</span>");
    out
}

const DIALOG_CLOSE: &str = "</section></div>";

fn push_server_field(out: &mut String, server: &ConnectedServer) {
    out.push_str("<input type=\"hidden\" name=\"server\" value=\"");
    push_escaped_attr(out, &server.origin);
    out.push_str("\" />");
}

/// A warning triangle, drawn, for the dialogs.
const WARNING_MARK: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" \
    stroke-width=\"1.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path \
    d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z\" />\
    <path d=\"M12 9v4\" /><path d=\"M12 17h.01\" /></svg>";
