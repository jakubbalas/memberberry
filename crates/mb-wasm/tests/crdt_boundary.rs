// why: these are test-only setup assertions; production WASM functions return `Result`.
#![allow(clippy::expect_used)]

use mb_wasm::{markdown_from_update_inner, update_from_markdown_inner};

#[test]
fn markdown_and_crdt_update_round_trip_through_the_rust_owned_boundary() {
    let markdown = "# Source\n\n- [ ] Ship it \u{1F4C5} 2026-09-01\n";

    let update = update_from_markdown_inner(markdown).expect("valid markdown must encode");

    assert_eq!(
        markdown_from_update_inner(&update).expect("encoded update must decode"),
        markdown
    );
}

#[test]
fn malformed_update_is_rejected() {
    assert!(markdown_from_update_inner(&[1, 2, 3]).is_err());
}
