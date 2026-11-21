use std::fs;
use std::sync::Arc;
use std::time::Duration;

use mb_auth::{ApiTokenScope, AuthDb, NewUser, UserId};
use mb_server::config::McpConfig;
use mb_server::http::{AppState, serve_until};
use mb_server::{Slug, Vault};
use reqwest::{Client, Response, StatusCode, header};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const SETTINGS: &str = "/api/v1/settings/mcp";
const ACL: &str = "[[members]]\nuser = 'alice'\nrole = 'viewer'\n[[members]]\nuser = 'bob'\nrole = 'owner'\n[[rules]]\npath = 'Private'\ngrant = { alice = 'none' }\n";
const BOB_ONLY_ACL: &str = "[[members]]\nuser = 'bob'\nrole = 'owner'\n";

async fn read_json(response: Response) -> Value {
    serde_json::from_slice(&response.bytes().await.expect("response body")).expect("JSON response")
}

struct Connection {
    url: String,
    http: Client,
    secret: String,
    id: u64,
}

impl Connection {
    async fn send(&mut self, method: &str, params: Value) -> Response {
        self.id += 1;
        self.http
            .post(&self.url)
            .bearer_auth(&self.secret)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-11-25")
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params}).to_string())
            .send()
            .await
            .expect("MCP response")
    }

    async fn invoke(&mut self, name: &str, arguments: Value) -> Value {
        let response = self
            .send("tools/call", json!({"name":name,"arguments":arguments}))
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        read_json(response).await["result"].clone()
    }

    async fn connect(&mut self) {
        let response = self
            .send(
                "initialize",
                json!({"protocolVersion":"2025-11-25","capabilities":{},
            "clientInfo":{"name":"fixture","version":"1"}}),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            read_json(response).await["result"]["protocolVersion"],
            "2025-11-25"
        );
    }
}

fn cookie(auth: &AuthDb, user: UserId) -> String {
    let token = auth.create_session(user, i64::MAX).expect("session");
    format!(
        "mb_session={}",
        auth.signed_session_cookie(&token).expect("signed session")
    )
}

struct SettingsClient<'a> {
    http: &'a Client,
    origin: &'a str,
    cookie: &'a str,
}

impl SettingsClient<'_> {
    fn request(&self, method: reqwest::Method, suffix: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{SETTINGS}{suffix}", self.origin))
            .header(header::COOKIE, self.cookie)
            .header(header::ORIGIN, self.origin)
            .header(header::CONTENT_TYPE, "application/json")
    }

    async fn set_enabled(&self, revision: i64, enabled: bool) -> Value {
        let response = self
            .request(reqwest::Method::PATCH, "")
            .body(json!({"revision":revision,"enabled":enabled}).to_string())
            .send()
            .await
            .expect("set enabled");
        assert_eq!(response.status(), StatusCode::OK);
        read_json(response).await
    }

    async fn issue(&self, name: &str, vaults: Value) -> (String, String) {
        let response = self
            .request(reqwest::Method::POST, "/tokens")
            .body(json!({"name":name,"vaults":vaults}).to_string())
            .send()
            .await
            .expect("create token");
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = read_json(response).await;
        (
            body["id"].as_str().expect("id").to_owned(),
            body["secret"].as_str().expect("secret").to_owned(),
        )
    }

    async fn edit_vaults(&self, id: &str, revision: i64, vaults: Value) -> Value {
        let response = self
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":revision,"vaults":vaults}).to_string())
            .send()
            .await
            .expect("edit token vaults");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        read_json(response).await
    }
}

pub async fn live_grants_and_tokens() {
    let temp = tempfile::tempdir().expect("fixture");
    let db_path = temp.path().join("auth.db");
    let mut auth = AuthDb::open(&db_path).expect("db");
    let admin = auth
        .setup_first_user(NewUser {
            username: "alice",
            display_name: "Alice",
            password: "fixture password one",
        })
        .expect("admin");
    let member = auth
        .create_user(NewUser {
            username: "bob",
            display_name: "Bob",
            password: "fixture password two",
        })
        .expect("member");
    let admin_cookie = cookie(&auth, admin.id);
    let member_cookie = cookie(&auth, member.id);
    let api_token = auth
        .create_api_token(ApiTokenScope {
            user_id: admin.id,
            vault_slug: "second".to_owned(),
            role: mb_core::Role::Viewer,
        })
        .expect("existing REST token");

    let mut vaults: Vec<Vault> = [
        ("first", "First vault", "First result"),
        ("second", "Second vault", "Second result"),
    ]
    .into_iter()
    .map(|(slug, name, title)| {
        let root = temp.path().join(slug);
        fs::create_dir_all(root.join("Private")).expect("folders");
        fs::write(root.join("access.toml"), ACL).expect("policy");
        fs::write(
            root.join("Project update.md"),
            format!("# {title}\n\nMilestone review notes.\n"),
        )
        .expect("note");
        fs::write(
            root.join("Private/Hidden.md"),
            "# Classified\n\nMilestone review notes.\n",
        )
        .expect("denied note");
        Vault::open(Slug::parse(slug).expect("slug"), name, &root).expect("vault")
    })
    .collect();

    // A vault the server admin cannot discover must stay invisible in MCP settings and token writes.
    let secret_root = temp.path().join("unreadable");
    fs::create_dir_all(&secret_root).expect("unreadable vault dir");
    fs::write(secret_root.join("access.toml"), BOB_ONLY_ACL).expect("bob policy");
    fs::write(
        secret_root.join("Secret.md"),
        "# Secret\n\nMilestone review notes.\n",
    )
    .expect("secret note");
    vaults.push(
        Vault::open(
            Slug::parse("unreadable").expect("slug"),
            "Unreadable vault",
            &secret_root,
        )
        .expect("unreadable vault"),
    );

    let main = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("web listener");
    let mcp_reservation = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("MCP reservation");
    let origin = format!("http://{}", main.local_addr().expect("web address"));
    let mcp = mcp_reservation.local_addr().expect("MCP address");
    drop(mcp_reservation);
    let url = format!("http://{mcp}/mcp");
    let state = Arc::new(
        AppState::authenticated(vaults, auth)
            .expect("app")
            .with_mcp(Some(McpConfig {
                listen: mcp,
                endpoint: None,
                note_origin: origin.clone(),
            }))
            .expect("MCP config"),
    );
    let (stop, shutdown) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(serve_until(state.clone(), main, async {
        let _ = shutdown.await;
    }));
    let http = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("client");
    let settings = SettingsClient {
        http: &http,
        origin: &origin,
        cookie: &admin_cookie,
    };

    let request = settings
        .request(reqwest::Method::GET, "")
        .send()
        .await
        .expect("settings");
    assert_eq!(request.status(), StatusCode::OK);
    let initial = read_json(request).await;
    assert_eq!(initial["endpoint"], url);
    assert_eq!(initial["enabled"], false);
    assert_eq!(initial["vaults"].as_array().expect("vaults").len(), 2);
    assert_eq!(initial["vaults"][0]["name"], "First vault");
    assert_eq!(initial["vaults"][1]["name"], "Second vault");
    assert_eq!(settings.set_enabled(0, true).await["revision"], 1);

    // Tokens must always have at least one readable vault; unknown and unreadable vaults look identical.
    let empty_create = settings
        .request(reqwest::Method::POST, "/tokens")
        .body(json!({"name":"Empty","vaults":[]}).to_string())
        .send()
        .await
        .expect("empty vaults");
    assert_eq!(empty_create.status(), StatusCode::BAD_REQUEST);
    let unknown_vault = settings
        .request(reqwest::Method::POST, "/tokens")
        .body(json!({"name":"Unknown","vaults":["missing"]}).to_string())
        .send()
        .await
        .expect("unknown vault");
    let unreadable_vault = settings
        .request(reqwest::Method::POST, "/tokens")
        .body(json!({"name":"Unreadable","vaults":["unreadable"]}).to_string())
        .send()
        .await
        .expect("unreadable vault");
    assert_eq!(unknown_vault.status(), StatusCode::BAD_REQUEST);
    assert_eq!(unreadable_vault.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(unknown_vault).await,
        read_json(unreadable_vault).await
    );

    let unauthenticated = http
        .get(format!("{origin}{SETTINGS}"))
        .send()
        .await
        .expect("anonymous");
    assert_eq!(unauthenticated.status(), StatusCode::NOT_FOUND);
    let non_admin = SettingsClient {
        http: &http,
        origin: &origin,
        cookie: &member_cookie,
    };
    assert_eq!(
        non_admin
            .request(reqwest::Method::GET, "")
            .send()
            .await
            .expect("member")
            .status(),
        StatusCode::NOT_FOUND
    );
    let cross_site = http
        .patch(format!("{origin}{SETTINGS}"))
        .header(header::COOKIE, &admin_cookie)
        .header(header::ORIGIN, "https://different.invalid")
        .header(header::CONTENT_TYPE, "application/json")
        .body(json!({"revision":1,"enabled":false}).to_string())
        .send()
        .await
        .expect("cross-site");
    assert_eq!(cross_site.status(), StatusCode::NOT_FOUND);
    let stale = settings
        .request(reqwest::Method::PATCH, "")
        .body(json!({"revision":0,"enabled":false}).to_string())
        .send()
        .await
        .expect("stale revision");
    assert_eq!(stale.status(), StatusCode::CONFLICT);

    let (id, secret) = settings.issue("Primary", json!(["first"])).await;
    let (_, fixed_secret) = settings.issue("First only", json!(["first"])).await;
    let mut connection = Connection {
        url: url.clone(),
        http: http.clone(),
        secret,
        id: 0,
    };
    let mut fixed = Connection {
        url: url.clone(),
        http: http.clone(),
        secret: fixed_secret,
        id: 0,
    };
    for client in [&mut connection, &mut fixed] {
        client.connect().await;
    }
    let list = read_json(connection.send("tools/list", json!({})).await).await;
    assert_eq!(list["result"]["tools"].as_array().expect("tools").len(), 2);

    let search = json!({"query":"Milestone"});
    let first = connection.invoke("search_notes", search.clone()).await;
    let hits = first["structuredContent"]["hits"].as_array().expect("hits");
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]["url"],
        format!("{origin}/v/first/Project%20update.md")
    );
    let old_id = hits[0]["id"].clone();
    let note = connection.invoke("fetch_note", json!({"id":old_id})).await;
    assert!(
        note["structuredContent"]["markdown"]
            .as_str()
            .expect("markdown")
            .contains("First result")
    );
    let missing = connection
        .invoke("fetch_note", json!({"id":"first/Absent.md"}))
        .await;
    let hidden = connection
        .invoke("fetch_note", json!({"id":"first/Private/Hidden.md"}))
        .await;
    assert_eq!(hidden, missing);
    assert_eq!(
        connection
            .invoke(
                "fetch_note",
                json!({"id":"first/../second/Project update.md"})
            )
            .await,
        missing
    );

    // Editing a token's vaults enforces validation, concurrency, ownership and same-origin rules.
    assert_eq!(
        settings
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":1,"vaults":[]}).to_string())
            .send()
            .await
            .expect("empty edit")
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        settings
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":1,"vaults":["unreadable"]}).to_string())
            .send()
            .await
            .expect("unreadable edit")
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        settings
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":0,"vaults":["second"]}).to_string())
            .send()
            .await
            .expect("stale edit")
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        non_admin
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":1,"vaults":["second"]}).to_string())
            .send()
            .await
            .expect("member edit")
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        http.patch(format!("{origin}{SETTINGS}/tokens/{id}"))
            .header(header::COOKIE, &admin_cookie)
            .header(header::ORIGIN, "https://different.invalid")
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"revision":1,"vaults":["second"]}).to_string())
            .send()
            .await
            .expect("cross-site edit")
            .status(),
        StatusCode::NOT_FOUND
    );

    // Reassign Primary from ["first"] to ["second"] while keeping the same connected clients.
    let edited = settings.edit_vaults(&id, 1, json!(["second"])).await;
    assert_eq!(edited["revision"], 2);
    assert_eq!(
        connection.invoke("fetch_note", json!({"id":old_id})).await,
        missing
    );
    let second = connection.invoke("search_notes", search.clone()).await;
    assert_eq!(
        second["structuredContent"]["hits"][0]["vault"],
        "Second vault"
    );
    // Fixed token keeps its own ["first"] assignment unaffected by editing Primary.
    assert_eq!(
        fixed.invoke("search_notes", search.clone()).await["structuredContent"]["hits"][0]["vault"],
        "First vault"
    );
    assert_eq!(
        fixed
            .invoke("fetch_note", json!({"id":"second/Project update.md"}))
            .await,
        missing
    );
    let expanded = settings
        .edit_vaults(&id, 2, json!(["first", "second"]))
        .await;
    assert_eq!(expanded["revision"], 3);
    assert_eq!(
        connection.invoke("search_notes", search).await["structuredContent"]["hits"]
            .as_array()
            .expect("both vault hits")
            .len(),
        2
    );

    fs::write(
        temp.path().join("second/Project update.md"),
        "# Current project status\n\nUpdated milestone. Published status fixture.\n",
    )
    .expect("updated checkout note");
    let fresh = connection
        .invoke("fetch_note", json!({"id":"second/Project update.md"}))
        .await;
    assert_eq!(
        fresh["structuredContent"]["title"],
        "Current project status"
    );
    assert!(fresh["structuredContent"]["modified_unix"].is_number());
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let indexed = connection
                .invoke(
                    "search_notes",
                    json!({"query":"Published","vault":"second"}),
                )
                .await;
            if indexed["structuredContent"]["hits"][0]["title"] == "Current project status" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("watcher refreshed the index");

    fs::write(
        temp.path().join("second/access.toml"),
        format!("{ACL} [[rules]]\npath = 'Project update.md'\ngrant = {{ alice = 'none' }}\n"),
    )
    .expect("updated policy");
    assert!(state.reload_access().is_empty());
    assert_eq!(
        connection
            .invoke("fetch_note", json!({"id":"second/Project update.md"}))
            .await,
        missing
    );
    assert_eq!(
        connection
            .invoke(
                "search_notes",
                json!({"query":"Milestone","vault":"second"})
            )
            .await["structuredContent"]["hits"],
        json!([])
    );

    let metadata = settings
        .request(reqwest::Method::GET, "")
        .send()
        .await
        .expect("list tokens")
        .text()
        .await
        .expect("token metadata");
    assert!(metadata.contains(&id));
    assert!(!metadata.contains(&connection.secret));
    assert!(!metadata.contains(&fixed.secret));
    assert!(!metadata.contains("Unreadable vault"));
    assert_eq!(
        http.post(&url)
            .bearer_auth(api_token.expose_secret())
            .body("{}")
            .send()
            .await
            .expect("old token")
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        http.post(&url)
            .bearer_auth(&connection.secret)
            .header(header::ORIGIN, "https://different.invalid")
            .body("{}")
            .send()
            .await
            .expect("invalid origin")
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        http.get(format!("{origin}/api/v1/vaults/first/search?q=Milestone"))
            .bearer_auth(&connection.secret)
            .send()
            .await
            .expect("REST isolation")
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        http.post(format!("{origin}/mcp"))
            .bearer_auth(&connection.secret)
            .body("{}")
            .send()
            .await
            .expect("listener isolation")
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        settings
            .request(reqwest::Method::DELETE, &format!("/tokens/{id}"))
            .send()
            .await
            .expect("revoke")
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        connection.send("ping", json!({})).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        settings
            .request(reqwest::Method::PATCH, &format!("/tokens/{id}"))
            .body(json!({"revision":4,"vaults":["first"]}).to_string())
            .send()
            .await
            .expect("edit revoked")
            .status(),
        StatusCode::CONFLICT
    );
    let admin_changes = AuthDb::open(&db_path).expect("admin database connection");
    admin_changes
        .set_admin(member.id, true)
        .expect("second admin");
    admin_changes
        .set_disabled(admin.id, true)
        .expect("disable issuer");
    assert_eq!(
        fixed.send("ping", json!({})).await.status(),
        StatusCode::UNAUTHORIZED
    );

    stop.send(()).expect("stop");
    running.await.expect("server task").expect("clean shutdown");
    let reopened = AuthDb::open(&db_path).expect("reopen");
    let database = fs::read(&db_path).expect("read fixture database");
    assert!(
        !database
            .windows(connection.secret.len())
            .any(|bytes| bytes == connection.secret.as_bytes())
    );
    let persisted = reopened
        .list_mcp_tokens(admin.id)
        .expect("persisted tokens");
    assert!(
        persisted
            .iter()
            .any(|token| token.id == id && token.revoked_at.is_some() && token.vaults.len() == 2)
    );
    assert_eq!(reopened.mcp_settings().expect("saved settings").revision, 4);
    assert!(
        reopened
            .authenticate_mcp_token(&mb_auth::mcp::Token::parse(&connection.secret).expect("parse"))
            .expect("revocation survived restart")
            .is_none()
    );
}
