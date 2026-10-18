//! Real HTTP/auth fixtures shared by the read-side routes and E29 leak suite.
#![allow(dead_code, clippy::expect_used, clippy::unwrap_used, clippy::panic)] // why: test fixtures only; each target uses a subset.
use mb_server::{
    ServerConfig, Vault,
    http::{AppState, router},
};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
};

pub struct Server {
    pub dir: tempfile::TempDir,
    pub addr: SocketAddr,
    pub admin: String,
    pub user: String,
    pub admin_bearer: String,
    pub user_bearer: String,
    pub admin_id: mb_auth::UserId,
    pub session: mb_auth::SessionToken,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Server {
    pub fn new(registered: bool) -> Self {
        Self::build(registered, false)
    }
    pub fn new_with_web_root(registered: bool) -> Self {
        Self::build(registered, true)
    }
    fn build(registered: bool, web: bool) -> Self {
        let dir = tempfile::tempdir().expect("fixture");
        let projects = dir.path().join("Projects");
        std::fs::create_dir_all(projects.join("Public")).expect("public");
        std::fs::create_dir_all(projects.join("Registered/PrivateChildName")).expect("private");
        std::fs::write(
            projects.join("Registered/PrivateChildName/Hidden.md"),
            "# PrivateTitle\nPrivateBody",
        )
        .expect("note");
        std::fs::write(
            projects.join("Registered/access.toml"),
            "[[members]]\nuser = 'bob'\nrole = 'owner'\n",
        )
        .expect("ACL");
        let vaults = if registered {
            vec![
                Vault::open(
                    mb_server::Slug::parse("private").expect("slug"),
                    "PrivateLabel",
                    projects.join("Registered"),
                )
                .expect("vault"),
            ]
        } else {
            vec![]
        };
        let text = format!(
            "[[vault_locations]]\nid = 'projects'\nname = 'Projects'\npath = '{}'\n{}",
            projects.display(),
            if registered {
                format!(
                    "[[vaults]]\nslug = 'private'\npath = '{}'\n",
                    projects.join("Registered").display()
                )
            } else {
                String::new()
            }
        );
        std::fs::write(dir.path().join("server.toml"), text).expect("config");
        let mut auth = mb_auth::AuthDb::open(&dir.path().join("auth.sqlite")).expect("auth");
        let admin = auth
            .setup_first_user(mb_auth::NewUser {
                username: "alice",
                display_name: "Alice",
                password: "correct horse battery staple",
            })
            .expect("admin");
        let spare = auth
            .create_user(mb_auth::NewUser {
                username: "spare",
                display_name: "Spare",
                password: "correct horse battery staple",
            })
            .expect("spare");
        auth.set_admin(spare.id, true)
            .expect("second enabled admin");
        let user = auth
            .create_user(mb_auth::NewUser {
                username: "bob",
                display_name: "Bob",
                password: "correct horse battery staple",
            })
            .expect("user");
        let session = auth
            .create_session(admin.id, 4_102_444_800)
            .expect("session");
        let cookie = format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&session).expect("cookie")
        );
        let user_session = auth
            .create_session(user.id, 4_102_444_800)
            .expect("user session");
        let user_cookie = format!(
            "Cookie: mb_session={}\r\n",
            auth.signed_session_cookie(&user_session).expect("cookie")
        );
        let bearer = |id| {
            format!(
                "Authorization: Bearer {}\r\n",
                auth.create_api_token(mb_auth::ApiTokenScope {
                    user_id: id,
                    vault_slug: "private".into(),
                    role: mb_core::Role::Owner
                })
                .expect("token")
                .expose_secret()
            )
        };
        let admin_bearer = bearer(admin.id);
        let user_bearer = bearer(user.id);
        let state = if web {
            let root = dir.path().join("web");
            std::fs::create_dir_all(root.join("assets")).expect("web root");
            std::fs::write(root.join("add-vault.html"), "<h1>Add vault</h1>").expect("HTML");
            std::fs::write(
                root.join("assets/folders.js"),
                "/* public static interface; no data */",
            )
            .expect("asset");
            AppState::authenticated_with_web_root(vaults, auth, root)
        } else {
            AppState::authenticated(vaults, auth)
        }
        .expect("state")
        .with_vault_management(dir.path().join("server.toml"), false)
        .expect("management");
        let (tx, rx) = std::sync::mpsc::channel();
        let (shutdown, stop) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            rt.block_on(async {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("bind");
                tx.send(listener.local_addr().expect("addr")).expect("send");
                axum::serve(listener, router(Arc::new(state)))
                    .with_graceful_shutdown(async { drop(stop.await) })
                    .await
                    .expect("serve");
            });
        });
        Self {
            dir,
            addr: rx.recv().expect("addr"),
            admin: cookie,
            user: user_cookie,
            admin_bearer,
            user_bearer,
            admin_id: admin.id,
            session,
            shutdown: Some(shutdown),
            thread: Some(thread),
        }
    }
    pub fn auth(&self) -> mb_auth::AuthDb {
        mb_auth::AuthDb::open(&self.dir.path().join("auth.sqlite")).expect("auth")
    }
    pub fn config(&self) -> ServerConfig {
        ServerConfig::load(&self.dir.path().join("server.toml")).expect("config")
    }
    pub fn save(&self, config: &ServerConfig) {
        std::fs::write(
            self.dir.path().join("server.toml"),
            config.to_toml().expect("TOML"),
        )
        .expect("config write");
    }
    pub fn get(&self, path: &str, headers: &str) -> (u16, String, String) {
        self.request("GET", path, headers)
    }
    pub fn head(&self, path: &str, headers: &str) -> (u16, String, String) {
        self.request("HEAD", path, headers)
    }
    // why: keep the existing GET bytes/defaults; only the new HTML case uses HEAD.
    fn request(&self, method: &str, path: &str, headers: &str) -> (u16, String, String) {
        let mut stream = TcpStream::connect(self.addr).expect("connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("deadline");
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\n{headers}Connection: close\r\n\r\n"
        )
        .expect("request");
        let mut raw = String::new();
        stream.read_to_string(&mut raw).expect("response");
        let (head, body) = raw.split_once("\r\n\r\n").expect("HTTP");
        let status = head
            .split_whitespace()
            .nth(1)
            .expect("status")
            .parse()
            .expect("code");
        (status, body.to_string(), head.to_string())
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().expect("server teardown");
        }
    }
}
pub fn encode(raw: &str) -> String {
    raw.as_bytes().iter().map(|b| format!("%{b:02X}")).collect()
}
pub fn json(body: &str) -> serde_json::Value {
    serde_json::from_str(body).expect("JSON")
}
