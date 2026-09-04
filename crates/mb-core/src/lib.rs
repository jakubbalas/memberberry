//! # mb-core
//!
//! The block model, canonical Markdown, task metadata and extraction for Memberberry.
//!
//! This crate is **pure**: no I/O, no async, no threads, no clock. That is a hard
//! requirement, not a style preference — it compiles to `wasm32-unknown-unknown` and runs
//! unchanged in the browser, which is what guarantees the client and the server can never
//! disagree about what a note means (`SPEC.md` §5.2).
//!
//! ## The contract
//!
//! Everything here exists to serve constraint C2: *if the app dies, the notes are still
//! readable*. Concretely that means:
//!
//! - Every block type has exactly one canonical Markdown rendering ([`serialize`]).
//! - Parsing is total: unmodelled input is downgraded to text, never dropped ([`parse`]).
//! - `parse(serialize(doc)) == doc`, and `serialize(parse(md))` is idempotent. Both are
//!   enforced by property tests, not by hope.

// AGENTS.md 4.2 permits panicking constructs in tests only.
#![cfg_attr(
    test,
    allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing)
)]

pub mod canonical;
pub mod extract;
pub mod frontmatter;
pub mod html;
pub mod model;
pub mod parse;
pub mod permissions;
pub mod schema;
pub mod serialize;
pub mod syntax;
pub mod task;
pub mod transclude;
pub mod unicode;

pub use canonical::document as canonicalize;
pub use extract::{Extracted, extract};
pub use model::{Block, BlockKind, Document, Inline};
pub use permissions::{Access, AclError, Member, NotePath, Role, Rule, Username};

/// Parses Markdown, frontmatter included, into the block model.
#[must_use]
pub fn parse(input: &str) -> Document {
    parse::document(input)
}

/// Renders a document to canonical Markdown.
#[must_use]
pub fn to_markdown(doc: &Document) -> String {
    serialize::document(doc)
}

/// Rewrites Markdown into its canonical form.
///
/// This is what `memberberry normalize` runs over a vault. It is idempotent: normalising
/// already-canonical input returns it unchanged, so the one-time git diff described in
/// `SPEC.md` §4.5 really is one-time.
#[must_use]
pub fn normalize(input: &str) -> String {
    to_markdown(&parse(input))
}
