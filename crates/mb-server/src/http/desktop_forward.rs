//! Server vaults online in the desktop app: forwarding to the user's server (`SPEC.md`
//! §7.6.10, E37).
//!
//! The window talks to the embedded server for every vault, local or not. For a server vault
//! that is online, the embedded server passes the vault's HTTP routes and its sync frames to
//! the user's server as the device, and hands back what it answers. Upstream decides every
//! permission; nothing is filtered or widened here. When upstream cannot be reached the vault
//! is marked offline and the request is answered locally from its folder instead.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message as UpstreamMessage;

use super::AppState;
use super::desktop_connect::connect_of;
use crate::replica::ReplicaConfig;
use crate::replica::upstream::Upstream;
use crate::replica::wire;
use crate::sync::{ClientFrame, ServerFrame, Wire};

/// The largest request body forwarded: a media upload's ceiling.
const MAX_FORWARDED_BODY: usize = 64 * 1024 * 1024;

/// Response headers handed back to the window. `Set-Cookie` never is (E37).
const RETURNED_RESPONSE_HEADERS: &[header::HeaderName] = &[
    header::CONTENT_TYPE,
    header::CACHE_CONTROL,
    header::ETAG,
    header::LAST_MODIFIED,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::CONTENT_DISPOSITION,
    header::X_CONTENT_TYPE_OPTIONS,
    header::CONTENT_SECURITY_POLICY,
];

impl AppState {
    /// The server vault behind local address `slug`, if it is one.
    pub(super) fn server_vault(&self, slug: &str) -> Option<ReplicaConfig> {
        connect_of(self)?.sync.server_vault(slug)
    }

    /// The server vault behind `slug` if it is one and currently online.
    fn forwarded_vault(&self, slug: &str) -> Option<(ReplicaConfig, Upstream)> {
        let connect = connect_of(self)?;
        let config = connect.sync.server_vault(slug)?;
        if !connect.sync.is_online(slug) {
            return None;
        }
        // why: only the origin this vault came from, and only while signed in there; another
        // server's token never travels with this vault's requests (E37, §7.6.11).
        let server = connect.signed_in_at(&config.origin)?;
        let token = connect.options.secrets.get(&server.origin).ok()??;
        let upstream = connect.sync.upstream_for(&server.origin, &token)?;
        Some((config, upstream))
    }

    fn mark_offline(&self, slug: &str) {
        if let Some(connect) = connect_of(self) {
            connect.sync.set_online(slug, false);
        }
    }
}

/// E37: forwards a server vault's `/api/v1/vaults/{slug}/…` routes while it is online.
pub async fn forward(State(state): State<Arc<AppState>>, request: Request, next: Next) -> Response {
    let Some((slug, tail)) = vault_route(request.uri().path()) else {
        return next.run(request).await;
    };
    // The offline state and recovered notes are this app's own answers, never upstream's.
    if ["offline", "recovered"]
        .iter()
        .any(|own| tail == *own || tail.starts_with(&format!("{own}/")))
    {
        return next.run(request).await;
    }
    let Some((config, upstream)) = state.forwarded_vault(&slug) else {
        return next.run(request).await;
    };
    let (parts, body) = request.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_FORWARDED_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let mut path = format!("/api/v1/vaults/{}/{tail}", encode_segment(&config.upstream));
    if let Some(query) = parts.uri.query() {
        path.push('?');
        path.push_str(query);
    }
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let method_was_get = method == reqwest::Method::GET;
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &parts.headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.insert(name, value);
        }
    }
    match upstream
        .forward(method, &path, &headers, body.clone())
        .await
    {
        // why: a new share link comes back as `/s/<token>`, relative to the server that
        // made it. Here it would resolve against this app's loopback address and be copied
        // as a link nobody else can open; it belongs to the vault's own server.
        Ok(response) if tail == "shares" => {
            into_response(response, |body| absolute_share_url(&config.origin, body)).await
        }
        // why: the note list is upstream's, and a recovered note exists only here; without
        // it the tree would not show the very notes awaiting the user's choice (§7.6.7).
        Ok(response) if tail == "notes" && method_was_get => {
            let recovered = connect_of(&state)
                .map(|c| c.sync.recovered_of(&slug))
                .unwrap_or_default();
            into_response(response, |body| with_recovered(body, &recovered)).await
        }
        Ok(response) => into_response(response, |body| body).await,
        Err(_) => {
            // Unreachable: answer from this device instead, and let the next pass decide
            // when the server is back.
            state.mark_offline(&slug);
            next.run(Request::from_parts(parts, Body::from(body))).await
        }
    }
}

/// `/api/v1/vaults/{slug}/{tail}` → `(slug, tail)`, with a non-empty tail.
fn vault_route(path: &str) -> Option<(String, String)> {
    let rest = path.strip_prefix("/api/v1/vaults/")?;
    let (slug, tail) = rest.split_once('/')?;
    if slug.is_empty() || tail.is_empty() {
        return None;
    }
    let slug = percent_decode(slug)?;
    Some((slug, tail.to_string()))
}

fn percent_decode(segment: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(segment.len());
    let mut chars = segment.bytes();
    while let Some(byte) = chars.next() {
        if byte == b'%' {
            let high = char::from(chars.next()?).to_digit(16)?;
            let low = char::from(chars.next()?).to_digit(16)?;
            bytes.push(u8::try_from(high * 16 + low).ok()?);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A note list's JSON with `recovered` notes added, titled by their file name; anything else
/// as it came.
fn with_recovered(body: Bytes, recovered: &[String]) -> Bytes {
    if recovered.is_empty() {
        return body;
    }
    let Ok(serde_json::Value::Object(mut listing)) = serde_json::from_slice(&body) else {
        return body;
    };
    let Some(serde_json::Value::Array(notes)) = listing.get_mut("notes") else {
        return body;
    };
    for path in recovered {
        let name = path.rsplit('/').next().unwrap_or(path);
        let title = name.strip_suffix(".md").unwrap_or(name);
        notes.push(serde_json::json!({ "path": path, "title": title, "editable": true }));
    }
    serde_json::to_vec(&listing).map_or(body, Bytes::from)
}

/// A created share link's JSON with its `url` made absolute on `origin`; anything else as
/// it came.
fn absolute_share_url(origin: &str, body: Bytes) -> Bytes {
    let Ok(serde_json::Value::Object(mut created)) = serde_json::from_slice(&body) else {
        return body;
    };
    let Some(serde_json::Value::String(url)) = created.get("url") else {
        return body;
    };
    if !url.starts_with('/') || url.starts_with("//") {
        return body;
    }
    let absolute = format!("{}{url}", origin.trim_end_matches('/'));
    created.insert("url".to_string(), serde_json::Value::String(absolute));
    serde_json::to_vec(&created).map_or(body, Bytes::from)
}

async fn into_response(
    response: reqwest::Response,
    rewrite: impl FnOnce(Bytes) -> Bytes,
) -> Response {
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut returned = Vec::new();
    for name in RETURNED_RESPONSE_HEADERS {
        if let Some(value) = response.headers().get(name.as_str())
            && let Ok(value) = HeaderValue::from_bytes(value.as_bytes())
        {
            returned.push((name.clone(), value));
        }
    }
    let Ok(body) = response.bytes().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let mut out = Response::new(Body::from(rewrite(body)));
    *out.status_mut() = status;
    for (name, value) in returned {
        out.headers_mut().insert(name, value);
    }
    out
}

/// One window socket's links to upstream, by local vault address (§7.6.10).
#[derive(Debug, Default)]
pub(super) struct Relays {
    links: HashMap<String, Link>,
}

#[derive(Debug)]
struct Link {
    send: tokio::sync::mpsc::UnboundedSender<UpstreamMessage>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for Relays {
    fn drop(&mut self) {
        for link in self.links.values() {
            link.reader.abort();
        }
    }
}

impl Relays {
    /// Sends `frame` upstream when its vault is a server vault that is online.
    ///
    /// Returns `true` when the frame was relayed; `false` means answer it locally — a local
    /// vault, an offline server vault, or a server that could not be reached just now.
    pub(super) async fn relay(
        &mut self,
        state: &AppState,
        frame: &ClientFrame,
        outbound: &tokio::sync::mpsc::UnboundedSender<ServerFrame>,
    ) -> bool {
        let slug = frame.vault().to_string();
        // why: a recovered note exists only on this device (§7.6.7); upstream has no such
        // note, and must not be asked about it.
        if connect_of(state).is_some_and(|c| c.sync.is_recovered(&slug, frame.note())) {
            return false;
        }
        let Some((config, upstream)) = state.forwarded_vault(&slug) else {
            return false;
        };
        let Some(outgoing) = wire::forward_client(frame, &config.upstream) else {
            return false;
        };
        if !self.links.contains_key(&slug) {
            let Ok(stream) = upstream.connect_stream().await else {
                state.mark_offline(&slug);
                return false;
            };
            self.links
                .insert(slug.clone(), open_link(stream, config, outbound.clone()));
        }
        let message = match outgoing {
            wire::Outgoing::Text(text) => UpstreamMessage::Text(text.into()),
            wire::Outgoing::Binary(bytes) => UpstreamMessage::Binary(bytes.into()),
        };
        match self.links.get(&slug) {
            Some(link) if link.send.send(message).is_ok() => true,
            _ => {
                self.links.remove(&slug);
                false
            }
        }
    }
}

fn open_link(
    stream: crate::replica::upstream::Stream,
    config: ReplicaConfig,
    outbound: tokio::sync::mpsc::UnboundedSender<ServerFrame>,
) -> Link {
    let (mut sink, mut source) = stream.split();
    let (send, mut queued) = tokio::sync::mpsc::unbounded_channel::<UpstreamMessage>();
    tokio::spawn(async move {
        while let Some(message) = queued.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
        drop(sink.close().await);
    });
    let reader = tokio::spawn(async move {
        while let Some(Ok(message)) = source.next().await {
            let wire = match message {
                UpstreamMessage::Text(text) => Some(Wire::Text(wire::relabel_text(
                    &text,
                    &config.upstream,
                    &config.local,
                ))),
                UpstreamMessage::Binary(bytes) => {
                    wire::relabel_binary(&bytes, &config.upstream, &config.local).map(Wire::Binary)
                }
                UpstreamMessage::Close(_) => break,
                _ => None,
            };
            if let Some(wire) = wire
                && outbound.send(ServerFrame::Relay(wire)).is_err()
            {
                return;
            }
        }
        // Upstream went away: end the window's socket so its editor reconnects, and is
        // answered locally if the server is now unreachable.
        drop(outbound.send(ServerFrame::Close));
    });
    Link { send, reader }
}

#[cfg(test)]
// why: a test whose rewritten body is not JSON should fail loudly, not return an error.
#[allow(clippy::expect_used)]
mod tests {
    use super::{Bytes, absolute_share_url, encode_segment, vault_route, with_recovered};

    #[test]
    fn a_created_share_link_is_made_absolute_on_the_vaults_server() {
        let body = Bytes::from_static(br#"{"url":"/s/abc","note":"A.md","expires_at":null}"#);
        let rewritten = absolute_share_url("https://notes.example/", body);
        let value: serde_json::Value = serde_json::from_slice(&rewritten).expect("json");
        assert_eq!(
            value.get("url").and_then(serde_json::Value::as_str),
            Some("https://notes.example/s/abc")
        );
        assert_eq!(
            value.get("note").and_then(serde_json::Value::as_str),
            Some("A.md")
        );
    }

    #[test]
    fn a_note_list_gains_the_recovered_notes() {
        let body =
            Bytes::from_static(br#"{"notes":[{"path":"A.md","title":"A"}],"truncated":false}"#);
        let listed = with_recovered(body, &["Recovered/B (offline edits).md".to_string()]);
        let value: serde_json::Value = serde_json::from_slice(&listed).expect("json");
        let paths: Vec<&str> = value
            .get("notes")
            .and_then(serde_json::Value::as_array)
            .map(|notes| {
                notes
                    .iter()
                    .filter_map(|n| n.get("path")?.as_str())
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(paths, ["A.md", "Recovered/B (offline edits).md"]);
    }

    #[test]
    fn a_note_list_with_nothing_recovered_or_not_json_is_unchanged() {
        let body = Bytes::from_static(br#"{"notes":[]}"#);
        assert_eq!(with_recovered(body.clone(), &[]), body);
        let junk = Bytes::from_static(b"nope");
        assert_eq!(with_recovered(junk.clone(), &["R.md".to_string()]), junk);
    }

    #[test]
    fn a_share_listing_or_an_error_passes_through_unchanged() {
        for body in [
            &br#"[{"id":1,"note":"A.md"}]"#[..],
            br#"{"url":"https://elsewhere.example/s/abc"}"#,
            br#"{"url":"//elsewhere.example/s/abc"}"#,
            b"not json",
            b"",
        ] {
            let body = Bytes::copy_from_slice(body);
            assert_eq!(
                absolute_share_url("https://notes.example", body.clone()),
                body
            );
        }
    }

    #[test]
    fn a_vault_route_names_its_vault_and_the_rest() {
        assert_eq!(
            vault_route("/api/v1/vaults/work/notes/A.md"),
            Some(("work".into(), "notes/A.md".into()))
        );
    }

    #[test]
    fn the_vault_list_itself_is_not_a_vault_route() {
        assert_eq!(vault_route("/api/v1/vaults"), None);
        assert_eq!(vault_route("/api/v1/vaults/work"), None);
    }

    #[test]
    fn an_encoded_slug_is_decoded() {
        assert_eq!(
            vault_route("/api/v1/vaults/w%6Frk/notes"),
            Some(("work".into(), "notes".into()))
        );
    }

    #[test]
    fn a_slug_is_encoded_for_the_upstream_path() {
        assert_eq!(encode_segment("my vault"), "my%20vault");
    }
}
