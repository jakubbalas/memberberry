//! Real HTTP transport E29 ambiguity checks; handler-level cases live in strict unit fixtures.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)] // why: disposable wire assertions only.
use crate::registration_cases::Observer;
use crate::registration_fixture::{Server, json};
use std::io::{Read, Write};
fn raw_post(s: &Server, action: &str, headers: &str, body: &str) -> (u16, String, String) {
    let mut stream = std::net::TcpStream::connect(s.addr).expect("listener");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .expect("deadline");
    write!(stream,"POST /api/v1/vault-locations/projects/{action} HTTP/1.1\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).expect("raw request");
    let mut text = String::new();
    stream.read_to_string(&mut text).expect("response");
    let (head, body) = text.split_once("\r\n\r\n").expect("HTTP response");
    (
        head.split_whitespace()
            .nth(1)
            .expect("status")
            .parse()
            .expect("code"),
        body.into(),
        head.to_ascii_lowercase(),
    )
}
fn valid(s: &Server) -> String {
    format!(
        "Host: localhost\r\n{}Origin: http://localhost\r\nContent-Type: application/json\r\n",
        s.admin
    )
}
/// Wire acceptance is separate from direct full-handler malformed-header coverage.
pub fn strict_wire_gate() {
    for new in [false, true] {
        for action in ["preview", "register"] {
            let s = Server::new(false);
            let config = s.dir.path().join("server.toml");
            let projects = s.dir.path().join("Projects");
            let public = projects.join("Public");
            let before = std::fs::read(&config).expect("config snapshot");
            let observer = Observer::new(&[&config, &projects, &public]);
            let mut input = if new {
                serde_json::json!({"mode":"new","path":"","directory":"New","slug":"project","name":"Project"})
            } else {
                serde_json::json!({"mode":"existing","path":"Public","slug":"project","name":"Project"})
            };
            let (status, body, _) = raw_post(&s, "preview", &valid(&s), &input.to_string());
            assert_eq!(status, 200);
            assert!(!observer.events().is_empty(), "real wire positive control");
            if action == "register" {
                input.as_object_mut().expect("selection object").insert(
                    "confirmation".into(),
                    json(&body)
                        .get("confirmation")
                        .expect("actual receipt")
                        .clone(),
                );
            }
            let cookie = s
                .admin
                .strip_prefix("Cookie: ")
                .expect("field")
                .trim_end_matches("\r\n");
            let auth = s.auth();
            let spare = auth
                .user_by_username("spare")
                .expect("lookup")
                .expect("spare");
            let spare_session = auth
                .create_session(spare.id, 4_102_444_800)
                .expect("second genuine session");
            let second = format!(
                "mb_session={}",
                auth.signed_session_cookie(&spare_session)
                    .expect("signed cookie")
            );
            drop(auth);
            let mut cases = Vec::new();
            for (label, a, b) in [
                ("valid-invalid", cookie, "mb_session=invalid"),
                ("invalid-valid", "mb_session=invalid", cookie),
                ("different-genuine", cookie, second.as_str()),
                ("different-genuine-reversed", second.as_str(), cookie),
                ("repeated-genuine", cookie, cookie),
            ] {
                for across in [false, true] {
                    let fields = if across {
                        format!("Cookie: {a}\r\nCookie: {b}\r\n")
                    } else {
                        format!("Cookie: {a}; {b}\r\n")
                    };
                    cases.push((format!("cookie-{label}-across={across}"),format!("Host: localhost\r\n{fields}Origin: http://localhost\r\nContent-Type: application/json\r\n"),404));
                }
            }
            for (a, b) in [
                ("application/json", "text/plain"),
                ("text/plain", "application/json"),
                ("application/json", "application/json"),
            ] {
                cases.push((format!("content-type-{a}-{b}"),format!("Host: localhost\r\n{}Origin: http://localhost\r\nContent-Type: {a}\r\nContent-Type: {b}\r\n",s.admin),400));
            }
            for (a, b) in [
                ("same-origin", "cross-site"),
                ("cross-site", "same-origin"),
                ("same-origin", "same-origin"),
            ] {
                cases.push((
                    format!("sec-fetch-{a}-{b}"),
                    format!(
                        "{}Sec-Fetch-Site: {a}\r\nSec-Fetch-Site: {b}\r\n",
                        valid(&s)
                    ),
                    404,
                ));
            }
            for host in [
                "localhost/path",
                "user@localhost",
                "localhost?query",
                "localhost#fragment",
                "localhost\\",
                "%6cocalhost",
                "localhost:",
            ] {
                cases.push((format!("host={host:?}"),format!("Host: {host}\r\n{}Origin: http://localhost\r\nContent-Type: application/json\r\n",s.admin),404));
            }
            for origin in [
                "http://localhost/.",
                "http://localhost/..",
                "http://localhost/%2e",
                "http://localhost/a/..",
                "http://localhost\\",
                "http:///localhost",
            ] {
                cases.push((format!("origin={origin:?}"),format!("Host: localhost\r\n{}Origin: {origin}\r\nContent-Type: application/json\r\n",s.admin),404));
            }
            for field in ["Origin: http://localhost\r\n", "Host: localhost\r\n"] {
                cases.push((
                    format!("duplicate-{}", field.split(':').next().expect("name")),
                    format!("{}{field}", valid(&s)),
                    404,
                ));
            }
            for (label, headers, expected) in cases {
                let (status, body, head) = raw_post(&s, action, &headers, &input.to_string());
                assert_eq!(status, expected, "{label} {action} new={new}: {body}");
                assert!(
                    head.contains("cache-control: no-store"),
                    "handler must receive these wire cases: {label}"
                );
                assert_eq!(
                    json(&body),
                    serde_json::json!({"error":if expected==400 {"invalid_request"} else {"not_found"}})
                );
                assert!(
                    observer.events().is_empty(),
                    "wire denial touched observed storage: {label}"
                );
                println!(
                    "STRICT-WIRE {label} action={action} new={new} handler-refusal={status} no-store=ok inotify=0"
                );
            }
            // Malformed control bytes are rejected by HTTP parsing, not credited to the handler.
            let malformed = format!(
                "Host: local\x01host\r\n{}Origin: http://localhost\r\nContent-Type: application/json\r\n",
                s.admin
            );
            let (status, body, head) = raw_post(&s, action, &malformed, &input.to_string());
            assert_eq!(status, 400);
            assert!(body.is_empty());
            assert!(!head.contains("cache-control: no-store"));
            assert!(observer.events().is_empty());
            println!(
                "STRICT-TRANSPORT control-host action={action} new={new} rejected-before-handler=400"
            );
            assert_eq!(std::fs::read(&config).expect("config preserved"), before);
            assert_eq!(s.state.len(), 0);
            observer.events(); // discard only our preservation snapshot read
            if action == "register" {
                let h = valid(&s).replace(
                    &s.admin,
                    &format!(
                        "Cookie: theme=dark\r\n{}Cookie: unrelated=value\r\n",
                        s.admin
                    ),
                );
                assert_eq!(
                    raw_post(&s, action, &h, &input.to_string()).0,
                    201,
                    "ordinary unambiguous multi-cookie remains accepted"
                );
                assert!(
                    !observer.events().is_empty(),
                    "authorized register wire positive control"
                );
            }
        }
    }
}
