//! The client half of §7.1's frame encoding, for a replica talking to its upstream.
//!
//! The server half is [`crate::sync::ClientFrame`] and [`crate::sync::ServerFrame`]; the
//! browser's is `web/src/editor/sync.ts`. Tests here encode with this module and decode with
//! the server's, and the reverse, so the three cannot drift apart unnoticed.

/// Tag byte for a full-state frame.
const FRAME_SYNC: u8 = 0x01;
/// Tag byte for an incremental update frame.
const FRAME_UPDATE: u8 = 0x02;

/// A frame the replica sends upstream, ready for the socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    /// A JSON control frame.
    Text(String),
    /// A binary CRDT frame.
    Binary(Vec<u8>),
}

/// `subscribe` for one note, at this build's schema revision.
#[must_use]
pub fn subscribe(vault: &str, note: &str, schema_version: u64) -> Outgoing {
    Outgoing::Text(
        serde_json::json!({
            "type": "subscribe",
            "vault": vault,
            "note": note,
            "schema_version": schema_version,
        })
        .to_string(),
    )
}

/// `unsubscribe` for one note.
#[must_use]
pub fn unsubscribe(vault: &str, note: &str) -> Outgoing {
    Outgoing::Text(
        serde_json::json!({ "type": "unsubscribe", "vault": vault, "note": note }).to_string(),
    )
}

/// A binary `update` frame, or `None` when a name is too long for its `u16` length.
#[must_use]
pub fn update(vault: &str, note: &str, payload: &[u8]) -> Option<Outgoing> {
    let vault_len = u16::try_from(vault.len()).ok()?;
    let note_len = u16::try_from(note.len()).ok()?;
    let mut bytes = Vec::with_capacity(5 + vault.len() + note.len() + payload.len());
    bytes.push(FRAME_UPDATE);
    bytes.extend_from_slice(&vault_len.to_be_bytes());
    bytes.extend_from_slice(&note_len.to_be_bytes());
    bytes.extend_from_slice(vault.as_bytes());
    bytes.extend_from_slice(note.as_bytes());
    bytes.extend_from_slice(payload);
    Some(Outgoing::Binary(bytes))
}

/// A browser's frame re-addressed to `vault` on the user's server (§7.6.10).
#[must_use]
pub fn forward_client(frame: &crate::sync::ClientFrame, vault: &str) -> Option<Outgoing> {
    use crate::sync::ClientFrame;
    match frame {
        ClientFrame::Subscribe {
            note,
            schema_version,
            ..
        } => Some(Outgoing::Text(
            serde_json::json!({
                "type": "subscribe",
                "vault": vault,
                "note": note,
                "schema_version": schema_version,
            })
            .to_string(),
        )),
        ClientFrame::Unsubscribe { note, .. } => Some(unsubscribe(vault, note)),
        ClientFrame::Update {
            note,
            update: payload,
            ..
        } => update(vault, note, payload),
        ClientFrame::Awareness {
            note,
            clients,
            state,
            ..
        } => Some(Outgoing::Text(
            serde_json::json!({
                "type": "awareness",
                "vault": vault,
                "note": note,
                "clients": clients,
                "state": state,
            })
            .to_string(),
        )),
    }
}

/// A text frame from upstream with its vault renamed `from` → `to`, for the window.
#[must_use]
pub fn relabel_text(text: &str, from: &str, to: &str) -> String {
    if from == to {
        return text.to_string();
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(mut value) => {
            if value.get("vault").and_then(|v| v.as_str()) == Some(from)
                && let Some(object) = value.as_object_mut()
            {
                object.insert("vault".into(), serde_json::Value::String(to.into()));
            }
            value.to_string()
        }
        Err(_) => text.to_string(),
    }
}

/// A binary frame from upstream with its vault renamed `from` → `to`, or `None` if malformed.
#[must_use]
pub fn relabel_binary(bytes: &[u8], from: &str, to: &str) -> Option<Vec<u8>> {
    let tag = *bytes.first()?;
    let decoded = decode_binary(bytes)?;
    let (vault, note, payload) = match decoded {
        Incoming::Sync {
            vault,
            note,
            update,
        }
        | Incoming::Update {
            vault,
            note,
            update,
        } => (vault, note, update),
        _ => return None,
    };
    let vault = if vault == from { to.to_string() } else { vault };
    let mut out = Vec::with_capacity(bytes.len() + to.len());
    out.push(tag);
    out.extend_from_slice(&u16::try_from(vault.len()).ok()?.to_be_bytes());
    out.extend_from_slice(&u16::try_from(note.len()).ok()?.to_be_bytes());
    out.extend_from_slice(vault.as_bytes());
    out.extend_from_slice(note.as_bytes());
    out.extend_from_slice(&payload);
    Some(out)
}

/// A frame upstream sent, as far as a replica cares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// A subscription was admitted; its full state follows.
    Admitted { vault: String, note: String },
    /// A note's complete state.
    Sync {
        vault: String,
        note: String,
        update: Vec<u8>,
    },
    /// An incremental update, including the echo of one this replica sent.
    Update {
        vault: String,
        note: String,
        update: Vec<u8>,
    },
    /// A refusal. Uniform by design (§7.1), so it names no note.
    Error { code: String },
    /// Presence and anything else a replica ignores.
    Other,
}

/// Decodes a text frame.
#[must_use]
pub fn decode_text(text: &str) -> Incoming {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Incoming::Other;
    };
    let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_string);
    match value.get("type").and_then(|t| t.as_str()) {
        Some("admitted") => match (field("vault"), field("note")) {
            (Some(vault), Some(note)) => Incoming::Admitted { vault, note },
            _ => Incoming::Other,
        },
        Some("error") => Incoming::Error {
            code: field("code").unwrap_or_default(),
        },
        _ => Incoming::Other,
    }
}

/// Decodes a binary frame, or `None` when it is malformed.
#[must_use]
pub fn decode_binary(bytes: &[u8]) -> Option<Incoming> {
    let tag = *bytes.first()?;
    let vault_len = usize::from(u16::from_be_bytes([*bytes.get(1)?, *bytes.get(2)?]));
    let note_len = usize::from(u16::from_be_bytes([*bytes.get(3)?, *bytes.get(4)?]));
    let vault_end = 5usize.checked_add(vault_len)?;
    let note_end = vault_end.checked_add(note_len)?;
    let vault = std::str::from_utf8(bytes.get(5..vault_end)?)
        .ok()?
        .to_string();
    let note = std::str::from_utf8(bytes.get(vault_end..note_end)?)
        .ok()?
        .to_string();
    let update = bytes.get(note_end..)?.to_vec();
    match tag {
        FRAME_SYNC => Some(Incoming::Sync {
            vault,
            note,
            update,
        }),
        FRAME_UPDATE => Some(Incoming::Update {
            vault,
            note,
            update,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

    use super::*;
    use crate::sync::{ClientFrame, ServerFrame, Wire};
    use proptest::prelude::*;

    fn server_decodes(frame: &Outgoing) -> ClientFrame {
        match frame {
            Outgoing::Text(text) => serde_json::from_str(text).expect("server parses it"),
            Outgoing::Binary(bytes) => ClientFrame::from_binary(bytes).expect("server parses it"),
        }
    }

    fn replica_decodes(frame: &ServerFrame) -> Incoming {
        match frame.to_wire().expect("encodes") {
            Wire::Text(text) => decode_text(&text),
            Wire::Binary(bytes) => decode_binary(&bytes).expect("replica parses it"),
        }
    }

    #[test]
    fn the_server_reads_a_subscribe_for_the_named_note() {
        let ClientFrame::Subscribe { vault, note, .. } = server_decodes(&subscribe("v", "A.md", 3))
        else {
            panic!("not a subscribe");
        };
        assert_eq!((vault.as_str(), note.as_str()), ("v", "A.md"));
    }

    #[test]
    fn the_server_reads_an_unsubscribe() {
        assert!(matches!(
            server_decodes(&unsubscribe("v", "A.md")),
            ClientFrame::Unsubscribe { .. }
        ));
    }

    #[test]
    fn a_name_too_long_for_the_header_is_not_encoded() {
        assert!(update("v", &"a".repeat(70_000), &[0, 0]).is_none());
    }

    #[test]
    fn an_admission_is_read_as_one() {
        let frame = ServerFrame::Admitted {
            vault: "v".into(),
            note: "A.md".into(),
            schema_version: 3,
        };
        assert_eq!(
            replica_decodes(&frame),
            Incoming::Admitted {
                vault: "v".into(),
                note: "A.md".into()
            }
        );
    }

    #[test]
    fn a_refusal_carries_its_code() {
        let frame = ServerFrame::Error { code: "read_only" };
        assert_eq!(
            replica_decodes(&frame),
            Incoming::Error {
                code: "read_only".into()
            }
        );
    }

    #[test]
    fn a_truncated_binary_frame_is_rejected() {
        assert!(decode_binary(&[0x02, 0, 5, 0, 1, b'v']).is_none());
    }

    #[test]
    fn a_forwarded_subscribe_names_the_upstream_vault() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"subscribe","vault":"work-2","note":"A.md","schema_version":3}"#,
        )
        .expect("frame");
        let ClientFrame::Subscribe { vault, note, .. } =
            server_decodes(&forward_client(&frame, "work").expect("forwarded"))
        else {
            panic!("not a subscribe");
        };
        assert_eq!((vault.as_str(), note.as_str()), ("work", "A.md"));
    }

    #[test]
    fn a_forwarded_awareness_keeps_its_clients_and_state() {
        let frame: ClientFrame = serde_json::from_str(
            r#"{"type":"awareness","vault":"local","note":"A.md","clients":[7],"state":{"update":[1,2]}}"#,
        )
        .expect("frame");
        let ClientFrame::Awareness {
            vault,
            clients,
            state,
            ..
        } = server_decodes(&forward_client(&frame, "work").expect("forwarded"))
        else {
            panic!("not awareness");
        };
        assert!(
            vault == "work"
                && clients == vec![7]
                && state.pointer("/update/1") == Some(&serde_json::json!(2))
        );
    }

    #[test]
    fn a_relabelled_text_frame_names_the_local_vault() {
        let text = relabel_text(
            r#"{"type":"admitted","vault":"work","note":"A.md"}"#,
            "work",
            "work-2",
        );
        assert_eq!(
            decode_text(&text),
            Incoming::Admitted {
                vault: "work-2".into(),
                note: "A.md".into()
            }
        );
    }

    #[test]
    fn a_relabelled_binary_frame_keeps_its_payload() {
        let Outgoing::Binary(bytes) = update("work", "A.md", &[9, 8, 7]).expect("encodes") else {
            panic!("binary");
        };
        let relabelled = relabel_binary(&bytes, "work", "work-2").expect("relabels");
        assert_eq!(
            decode_binary(&relabelled),
            Some(Incoming::Update {
                vault: "work-2".into(),
                note: "A.md".into(),
                update: vec![9, 8, 7]
            })
        );
    }

    proptest! {
        #[test]
        fn an_update_survives_the_trip_to_the_server(
            vault in "[a-z0-9-]{1,20}",
            note in "\\PC{1,40}",
            payload in prop::collection::vec(any::<u8>(), 0..64),
        ) {
            let encoded = update(&vault, &note, &payload).expect("short names encode");
            let ClientFrame::Update { vault: v, note: n, update: u } = server_decodes(&encoded) else {
                return Err(TestCaseError::fail("not an update"));
            };
            prop_assert_eq!((v, n, u), (vault, note, payload));
        }

        #[test]
        fn a_full_state_survives_the_trip_from_the_server(
            vault in "[a-z0-9-]{1,20}",
            note in "\\PC{1,40}",
            payload in prop::collection::vec(any::<u8>(), 0..64),
        ) {
            let frame = ServerFrame::Sync { vault: vault.clone(), note: note.clone(), update: payload.clone() };
            prop_assert_eq!(replica_decodes(&frame), Incoming::Sync { vault, note, update: payload });
        }

        #[test]
        fn an_update_survives_the_trip_from_the_server(
            vault in "[a-z0-9-]{1,20}",
            note in "\\PC{1,40}",
            payload in prop::collection::vec(any::<u8>(), 0..64),
        ) {
            let frame = ServerFrame::Update { vault: vault.clone(), note: note.clone(), update: payload.clone() };
            prop_assert_eq!(replica_decodes(&frame), Incoming::Update { vault, note, update: payload });
        }

        #[test]
        fn decoding_arbitrary_bytes_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..64)) {
            let _ = decode_binary(&bytes);
        }
    }
}
