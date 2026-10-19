//! Shared E29 HTML/public-asset distinction with real sessions and observable positive control.
#![allow(clippy::expect_used, clippy::unwrap_used)] // why: fixture and exact response assertions only.
use super::discovery_fixture::Server;
pub fn html_gate() {
    for route in ["/vaults/add", "/vaults/new"] {
        html_gate_at(route);
    }
}
fn html_gate_at(route: &str) {
    use rustix::fs::inotify;
    let s = Server::new_with_web_root(true);
    assert_eq!(s.admin.matches("Cookie:").count(), 1);
    assert_eq!(s.admin.matches("mb_session=").count(), 1);
    let watch = inotify::init(inotify::CreateFlags::NONBLOCK).expect("observer");
    for p in [
        s.dir.path().join("web/add-vault.html"),
        s.dir.path().join("server.toml"),
        s.dir.path().join("Projects"),
        s.dir.path().join("Projects/Registered"),
    ] {
        inotify::add_watch(
            &watch,
            p,
            inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS,
        )
        .expect("watch");
    }
    let denied = |headers: &str| {
        let (status, body, head) = s.get(route, headers);
        assert_eq!(status, 404);
        assert!(
            head.to_ascii_lowercase()
                .contains("content-type: text/html")
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("cache-control: no-store")
        );
        for secret in [
            "PrivateChildName",
            "PrivateTitle",
            "PrivateBody",
            "PrivateLabel",
            s.dir.path().to_str().expect("path"),
        ] {
            assert!(!body.contains(secret));
        }
        let mut bytes = [std::mem::MaybeUninit::uninit(); 4096];
        assert!(
            matches!(
                inotify::Reader::new(&watch, &mut bytes).next(),
                Err(rustix::io::Errno::AGAIN)
            ),
            "denied HTML opened/read bundle/config/project; stat ordering is separately covered by pre-read counter/source"
        );
    };
    for h in [
        "".to_owned(),
        s.user.clone(),
        s.admin_bearer.clone(),
        format!("{}{}", s.admin, s.admin_bearer),
        format!("{}{}", s.admin, s.admin),
        "Cookie: mb_session=invalid\r\n".to_owned(),
    ] {
        denied(&h);
    }
    let (head_status, head_body, head_headers) = s.head(route, "");
    assert_eq!(head_status, 404);
    assert!(head_body.is_empty());
    assert!(
        head_headers
            .to_ascii_lowercase()
            .contains("content-type: text/html")
    );
    let auth = s.auth();
    auth.set_admin(s.admin_id, false).expect("demote");
    denied(&s.admin);
    auth.set_admin(s.admin_id, true).expect("restore");
    auth.set_disabled(s.admin_id, true).expect("disable");
    denied(&s.admin);
    auth.set_disabled(s.admin_id, false).expect("enable");
    auth.revoke_session(&s.session).expect("revoke");
    denied(&s.admin);
    let session = auth
        .create_session(s.admin_id, 4_102_444_800)
        .expect("fresh");
    let h = format!(
        "Cookie: mb_session={}\r\n",
        auth.signed_session_cookie(&session).expect("signed")
    );
    assert_eq!(h.matches("mb_session=").count(), 1);
    let (status, body, head) = s.get(route, &h);
    assert_eq!(status, 200);
    assert_eq!(body, "<h1>Add vault</h1>");
    assert!(
        head.to_ascii_lowercase()
            .contains("content-security-policy: default-src 'none'; script-src 'self'")
    );
    let mut bytes = [std::mem::MaybeUninit::uninit(); 4096];
    assert!(
        inotify::Reader::new(&watch, &mut bytes).next().is_ok(),
        "positive HTML control must actually open/read the bundle"
    );
    let (status, body, head) = s.get("/assets/folders.js", "");
    assert_eq!(status, 200);
    assert_eq!(body, "/* public static interface; no data */");
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: text/javascript")
    );
    assert_eq!(s.get("/add-vault.html", "").0, 404);
    assert_eq!(s.get("/assets/../add-vault.html", "").0, 404);
    let (status, body, head) = s.get("/api/v1/vault-locations", "");
    assert_eq!(status, 404);
    assert_eq!(body, "{\"error\":\"not_found\"}");
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    assert_eq!(
        s.get("/api/v1/vaults/private/notes", &h).0,
        404,
        "HTML administration does not grant content access"
    );
    assert!(!s.get("/", &s.user).1.contains("href=\"/vaults/new\""));
    let home = s.get("/", &h).1;
    assert!(!home.contains("href=\"/vaults/add\""));
    assert_eq!(home.matches("href=\"/vaults/new\"").count(), 1);
}
