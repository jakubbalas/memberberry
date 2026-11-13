//! A replica's link to the user's server: the HTTP routes a person's client uses, and one
//! §7.1 sync socket, all carrying the device token (§6.8.1, E36).

use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

use super::ReplicaError;
use super::plan::UpstreamNote;
use super::wire::{self, Incoming, Outgoing};

/// How long upstream has to answer one sync frame before the pass gives up.
const FRAME_TIMEOUT: Duration = Duration::from_secs(20);

/// A vault on the user's server the device's user can read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct UpstreamVault {
    /// Its address.
    pub slug: String,
    /// Its display name.
    pub name: String,
}

/// The user's server, as the device's user.
#[derive(Debug, Clone)]
pub struct Upstream {
    origin: String,
    token: String,
    client: reqwest::Client,
}

/// What upstream said to a create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Created {
    /// The note exists upstream now.
    Yes,
    /// Upstream refused: no write access there, or the path is taken.
    Refused,
}

impl Upstream {
    /// A client for `origin` (`scheme://host[:port]`) holding `token`.
    ///
    /// # Errors
    ///
    /// Fails if the HTTP client cannot be built.
    pub fn new(origin: &str, token: &str) -> Result<Self, ReplicaError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        Ok(Self {
            origin: origin.trim_end_matches('/').to_string(),
            token: token.to_string(),
            client,
        })
    }

    fn url(&self, segments: &[&str]) -> Result<reqwest::Url, ReplicaError> {
        let mut url =
            reqwest::Url::parse(&self.origin).map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        url.path_segments_mut()
            .map_err(|()| ReplicaError::Upstream("server address cannot take a path".into()))?
            .extend(segments);
        Ok(url)
    }

    fn note_url(&self, slug: &str, path: &str) -> Result<reqwest::Url, ReplicaError> {
        let mut segments = vec!["api", "v1", "vaults", slug, "notes"];
        segments.extend(path.split('/'));
        self.url(&segments)
    }

    async fn get_text(&self, url: reqwest::Url) -> Result<String, ReplicaError> {
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        match response.status() {
            status if status.is_success() => response
                .text()
                .await
                .map_err(|e| ReplicaError::Upstream(e.to_string())),
            reqwest::StatusCode::UNAUTHORIZED => Err(ReplicaError::Unauthorized),
            // why: content routes deny uniformly with 404 (§6.5), so a revoked token and a
            // vault this user can no longer read look alike. Asking who the device is tells
            // them apart without the server revealing anything about the vault.
            reqwest::StatusCode::NOT_FOUND if !self.still_accepted().await? => {
                Err(ReplicaError::Unauthorized)
            }
            reqwest::StatusCode::NOT_FOUND => Err(ReplicaError::Unavailable),
            status => Err(ReplicaError::Upstream(format!(
                "the server answered {status}"
            ))),
        }
    }

    /// Whether the server still accepts this device's token.
    async fn still_accepted(&self) -> Result<bool, ReplicaError> {
        let response = self
            .client
            .get(self.url(&["api", "v1", "devices", "self"])?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        Ok(response.status() != reqwest::StatusCode::UNAUTHORIZED)
    }

    /// The vaults the device's user can read.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable or no longer accepts the token.
    pub async fn vaults(&self) -> Result<Vec<UpstreamVault>, ReplicaError> {
        let text = self.get_text(self.url(&["api", "v1", "vaults"])?).await?;
        serde_json::from_str(&text).map_err(|e| ReplicaError::Upstream(e.to_string()))
    }

    /// Every readable note in `slug`, and whether the list is complete.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable, refuses, or answers something unreadable.
    pub async fn notes(&self, slug: &str) -> Result<(Vec<UpstreamNote>, bool), ReplicaError> {
        #[derive(serde::Deserialize)]
        struct Listed {
            path: String,
            #[serde(default)]
            id: Option<String>,
            #[serde(default)]
            version: String,
            #[serde(default)]
            editable: bool,
            #[serde(default)]
            title: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Listing {
            notes: Vec<Listed>,
            #[serde(default)]
            truncated: bool,
        }
        let text = self
            .get_text(self.url(&["api", "v1", "vaults", slug, "notes"])?)
            .await?;
        let listing: Listing =
            serde_json::from_str(&text).map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        let notes = listing
            .notes
            .into_iter()
            .map(|note| UpstreamNote {
                path: note.path,
                id: note.id,
                version: note.version,
                editable: note.editable,
                title: note.title,
            })
            .collect();
        Ok((notes, !listing.truncated))
    }

    /// Creates `path` upstream from this device's history of it.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable; a refusal is [`Created::Refused`].
    pub async fn create(
        &self,
        slug: &str,
        path: &str,
        state: &[u8],
    ) -> Result<Created, ReplicaError> {
        let body = serde_json::json!({
            "path": path,
            "state": base64::engine::general_purpose::STANDARD.encode(state),
        });
        let response = self
            .client
            .post(self.url(&["api", "v1", "vaults", slug, "notes"])?)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        match response.status() {
            status if status.is_success() => Ok(Created::Yes),
            reqwest::StatusCode::UNAUTHORIZED => Err(ReplicaError::Unauthorized),
            status if status.is_client_error() => Ok(Created::Refused),
            status => Err(ReplicaError::Upstream(format!(
                "the server answered {status}"
            ))),
        }
    }

    /// A media object, as the device's user may see it: `None` when upstream does not
    /// show it to them (no readable note references it, or it is gone).
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable or no longer accepts this device.
    pub async fn media(&self, slug: &str, path: &str) -> Result<Option<Vec<u8>>, ReplicaError> {
        // The route's parameter is the object path itself, which starts with `media/`.
        let mut segments = vec!["api", "v1", "vaults", slug, "media"];
        segments.extend(path.split('/'));
        let response = self
            .client
            .get(self.url(&segments)?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        match response.status() {
            status if status.is_success() => response
                .bytes()
                .await
                .map(|bytes| Some(bytes.to_vec()))
                .map_err(|e| ReplicaError::Upstream(e.to_string())),
            reqwest::StatusCode::UNAUTHORIZED => Err(ReplicaError::Unauthorized),
            reqwest::StatusCode::NOT_FOUND => Ok(None),
            status => Err(ReplicaError::Upstream(format!(
                "the server answered {status}"
            ))),
        }
    }

    /// Uploads a media object, returning the path upstream stored it at; `None` when
    /// refused (this user may write nowhere in the vault, or the bytes are not an accepted
    /// kind).
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable or no longer accepts this device.
    pub async fn upload_media(
        &self,
        slug: &str,
        bytes: &[u8],
        extension: &str,
    ) -> Result<Option<String>, ReplicaError> {
        #[derive(serde::Deserialize)]
        struct Stored {
            path: String,
        }
        let response = self
            .client
            .post(self.url(&["api", "v1", "vaults", slug, "media"])?)
            .bearer_auth(&self.token)
            .header("x-memberberry-filename", format!("media.{extension}"))
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        match response.status() {
            status if status.is_success() => {
                let text = response
                    .text()
                    .await
                    .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
                serde_json::from_str::<Stored>(&text)
                    .map(|stored| Some(stored.path))
                    .map_err(|e| ReplicaError::Upstream(e.to_string()))
            }
            reqwest::StatusCode::UNAUTHORIZED => Err(ReplicaError::Unauthorized),
            status if status.is_client_error() => Ok(None),
            status => Err(ReplicaError::Upstream(format!(
                "the server answered {status}"
            ))),
        }
    }

    /// Moves a note upstream without rewriting any text. `false` when refused.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable.
    pub async fn move_note(&self, slug: &str, from: &str, to: &str) -> Result<bool, ReplicaError> {
        let body = serde_json::json!({ "kind": "note", "from": from, "to": to, "links": false });
        let response = self
            .client
            .post(self.url(&["api", "v1", "vaults", slug, "rename"])?)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        Self::accepted(response.status())
    }

    /// Sends a note upstream to its trash. `false` when refused.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable.
    pub async fn delete(&self, slug: &str, path: &str) -> Result<bool, ReplicaError> {
        let response = self
            .client
            .delete(self.note_url(slug, path)?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        Self::accepted(response.status())
    }

    fn accepted(status: reqwest::StatusCode) -> Result<bool, ReplicaError> {
        match status {
            status if status.is_success() => Ok(true),
            reqwest::StatusCode::UNAUTHORIZED => Err(ReplicaError::Unauthorized),
            status if status.is_client_error() => Ok(false),
            status => Err(ReplicaError::Upstream(format!(
                "the server answered {status}"
            ))),
        }
    }

    /// Opens the sync socket.
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable or refuses the token.
    pub async fn connect(&self) -> Result<Socket, ReplicaError> {
        let socket = self.connect_stream().await?;
        let schema = crate::sync::current_schema_version()
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        Ok(Socket { socket, schema })
    }

    /// Opens the sync socket as a raw stream, for relaying a window's frames (§7.6.10).
    ///
    /// # Errors
    ///
    /// Fails when the server is unreachable or refuses the token.
    pub async fn connect_stream(&self) -> Result<Stream, ReplicaError> {
        let address = if let Some(rest) = self.origin.strip_prefix("https://") {
            format!("wss://{rest}/api/v1/sync")
        } else if let Some(rest) = self.origin.strip_prefix("http://") {
            format!("ws://{rest}/api/v1/sync")
        } else {
            return Err(ReplicaError::Upstream("unsupported server address".into()));
        };
        let mut request = address
            .into_client_request()
            .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
        let bearer = format!("Bearer {}", self.token)
            .parse()
            .map_err(|_| ReplicaError::Upstream("token is not a header value".into()))?;
        request.headers_mut().insert("Authorization", bearer);
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| match e {
                tokio_tungstenite::tungstenite::Error::Http(response)
                    if response.status() == 401 =>
                {
                    ReplicaError::Unauthorized
                }
                other => ReplicaError::Upstream(other.to_string()),
            })?;
        Ok(socket)
    }

    /// Forwards one HTTP request to the user's server as the device (E37).
    ///
    /// `path_and_query` already names the upstream vault. Only `headers` listed in
    /// [`FORWARDED_REQUEST_HEADERS`] travel; the device token is the only credential.
    ///
    /// # Errors
    ///
    /// Fails when the server cannot be reached; any HTTP answer, a denial included, is `Ok`.
    pub async fn forward(
        &self,
        method: reqwest::Method,
        path_and_query: &str,
        headers: &reqwest::header::HeaderMap,
        body: bytes::Bytes,
    ) -> Result<reqwest::Response, ReplicaError> {
        let url = format!("{}{path_and_query}", self.origin);
        let mut request = self.client.request(method, url).bearer_auth(&self.token);
        for name in FORWARDED_REQUEST_HEADERS {
            if let Some(value) = headers.get(*name) {
                request = request.header(*name, value);
            }
        }
        request
            .body(body)
            .send()
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))
    }
}

/// The request headers a forwarded request keeps (E37). Nothing that identifies or
/// authenticates the window — `Cookie`, `Authorization`, `Origin`, `Host` — is among them.
pub const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "if-none-match",
    "if-modified-since",
    "range",
];

/// An upstream sync socket.
pub type Stream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One open §7.1 socket. Used for one note at a time within a pass.
#[derive(Debug)]
pub struct Socket {
    socket: Stream,
    schema: u64,
}

/// What upstream said to an update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pushed {
    /// Upstream applied it and echoed it back.
    Applied,
    /// Upstream refused it, with §7.1's code.
    Refused(String),
}

impl Socket {
    async fn send(&mut self, frame: Outgoing) -> Result<(), ReplicaError> {
        let message = match frame {
            Outgoing::Text(text) => Message::Text(text.into()),
            Outgoing::Binary(bytes) => Message::Binary(bytes.into()),
        };
        self.socket
            .send(message)
            .await
            .map_err(|e| ReplicaError::Upstream(e.to_string()))
    }

    async fn next(&mut self) -> Result<Incoming, ReplicaError> {
        loop {
            let message = tokio::time::timeout(FRAME_TIMEOUT, self.socket.next())
                .await
                .map_err(|_| ReplicaError::Upstream("the server stopped answering".into()))?
                .ok_or_else(|| ReplicaError::Upstream("the server closed the connection".into()))?
                .map_err(|e| ReplicaError::Upstream(e.to_string()))?;
            match message {
                Message::Text(text) => return Ok(wire::decode_text(&text)),
                Message::Binary(bytes) => {
                    if let Some(frame) = wire::decode_binary(&bytes) {
                        return Ok(frame);
                    }
                }
                Message::Close(_) => {
                    return Err(ReplicaError::Upstream(
                        "the server closed the connection".into(),
                    ));
                }
                _ => {}
            }
        }
    }

    /// Subscribes to a note and returns its complete state. The note stays subscribed
    /// until [`Self::leave`], so a following [`Self::push`] hears its echo.
    ///
    /// # Errors
    ///
    /// [`ReplicaError::Refused`] when upstream denies the note; otherwise a socket failure.
    pub async fn state(&mut self, vault: &str, note: &str) -> Result<Vec<u8>, ReplicaError> {
        self.send(wire::subscribe(vault, note, self.schema)).await?;
        loop {
            match self.next().await? {
                Incoming::Sync {
                    vault: v,
                    note: n,
                    update,
                } if v == vault && n == note => return Ok(update),
                Incoming::Error { code } => return Err(ReplicaError::Refused(code)),
                _ => {}
            }
        }
    }

    /// Sends an update for a subscribed note and waits for upstream to apply or refuse it.
    ///
    /// # Errors
    ///
    /// A socket failure, or a frame too large to address.
    pub async fn push(
        &mut self,
        vault: &str,
        note: &str,
        update: &[u8],
    ) -> Result<Pushed, ReplicaError> {
        let frame = wire::update(vault, note, update)
            .ok_or_else(|| ReplicaError::Upstream("note path too long".into()))?;
        self.send(frame).await?;
        loop {
            match self.next().await? {
                // why: the echo is upstream's acknowledgement (§7.1): it is broadcast only
                // after the update is durable in upstream's sidecar.
                Incoming::Update {
                    vault: v,
                    note: n,
                    update: echoed,
                } if v == vault && n == note && echoed == update => return Ok(Pushed::Applied),
                Incoming::Error { code } => return Ok(Pushed::Refused(code)),
                _ => {}
            }
        }
    }

    /// Unsubscribes from a note.
    ///
    /// # Errors
    ///
    /// A socket failure.
    pub async fn leave(&mut self, vault: &str, note: &str) -> Result<(), ReplicaError> {
        self.send(wire::unsubscribe(vault, note)).await
    }

    /// Closes the socket.
    pub async fn close(mut self) {
        drop(self.socket.close(None).await);
    }
}
