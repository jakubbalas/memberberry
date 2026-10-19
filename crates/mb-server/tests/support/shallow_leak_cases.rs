//! E30/E31 leak cases shared by dedicated HTTP and central enforcement suite.
#![allow(
    clippy::expect_used,
    clippy::panic,
    clippy::unwrap_used,
    clippy::indexing_slicing
)] // why: test-only wire assertions.
use super::registration_fixture::{Server, json};
use std::io::{Read, Write};
pub fn shallow_acl() {
    let s = Server::new(true);
    let root = s.dir.path().join("Projects/Registered");
    std::fs::write(root.join("Public.md"), "SECRET_BODY_SENTINEL").expect("note");
    std::fs::write(root.join("access.toml"),"[[members]]\nuser='bob'\nrole='viewer'\n[[rules]]\npath='PrivateChildName'\ngrant={bob='none'}\n").expect("ACL");
    let (status, body, head) = s.get("/api/v1/vaults/private/directory", &s.user);
    assert_eq!(status, 200);
    assert!(head.to_lowercase().contains("cache-control: no-store"));
    assert!(body.contains("Public.md"));
    for sentinel in [
        "PrivateChildName",
        "PrivateTitle",
        "PrivateBody",
        "SECRET_BODY_SENTINEL",
    ] {
        assert!(!body.contains(sentinel));
    }
    let denied = s.get(
        "/api/v1/vaults/private/directory?path=PrivateChildName",
        &s.user,
    );
    let absent = s.get("/api/v1/vaults/private/directory?path=Absent", &s.user);
    assert_eq!((denied.0, denied.1), (absent.0, absent.1));
    assert_eq!(denied.0, 404);
    let (status, body, _) = s.get("/api/v1/vaults/private/directory", &s.admin);
    assert_eq!(status, 404);
    assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
}
pub fn mkdir_gate() {
    let s = Server::new(true);
    let before = std::fs::read(s.dir.path().join("server.toml")).expect("config");
    use rustix::fs::inotify;
    let watch = inotify::init(inotify::CreateFlags::NONBLOCK).expect("observer");
    for path in [
        s.dir.path().join("server.toml"),
        s.dir.path().join("Projects"),
    ] {
        inotify::add_watch(
            &watch,
            path,
            inotify::WatchFlags::OPEN | inotify::WatchFlags::ACCESS | inotify::WatchFlags::CREATE,
        )
        .expect("watch");
    }
    let body = "{\"path\":\"\",\"directory\":\"Created\"}";
    let send = |headers: &str| {
        let mut stream = std::net::TcpStream::connect(s.addr).expect("connect");
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("timeout");
        write!(stream,"POST /api/v1/vault-locations/projects/directories HTTP/1.1\r\nHost: localhost\r\n{headers}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).expect("request");
        let mut raw = String::new();
        stream.read_to_string(&mut raw).expect("response");
        let (head, body) = raw.split_once("\r\n\r\n").expect("HTTP");
        (
            head.split_whitespace()
                .nth(1)
                .expect("status")
                .parse::<u16>()
                .expect("code"),
            body.to_owned(),
        )
    };
    for headers in [
        "Origin: http://localhost\r\n".to_owned(),
        format!("{}Origin: http://localhost\r\n", s.user),
        format!("{}Origin: http://localhost\r\n", s.admin_bearer),
    ] {
        let (status, body) = send(&headers);
        assert_eq!(status, 404);
        assert_eq!(json(&body), serde_json::json!({"error":"not_found"}));
    }
    let mut buf = [std::mem::MaybeUninit::uninit(); 8192];
    let mut reader = inotify::Reader::new(&watch, &mut buf);
    assert!(
        matches!(reader.next(), Err(rustix::io::Errno::AGAIN)),
        "unauthorized calls never open/probe/mkdir"
    );
    let (status, body) = send(&format!("{}Origin: http://localhost\r\n", s.admin));
    assert_eq!(
        status, 201,
        "positive control uses one Content-Type: {body}"
    );
    assert!(
        reader.next().is_ok(),
        "observer detects actual authenticated fs work"
    );
    assert!(s.dir.path().join("Projects/Created").is_dir());
    assert!(!s.dir.path().join("Projects/Created/access.toml").exists());
    assert_eq!(
        std::fs::read(s.dir.path().join("server.toml")).expect("config"),
        before
    );
    assert_eq!(s.state.len(), 1);
}
