//! Yjs-compatible merge state for Memberberry notes.
//!
//! The shared document has two roots: `prosemirror`, the `Y.XmlFragment` shape consumed
//! by `y-prosemirror`, and `frontmatter`, a sibling `Y.Map` whose keys merge independently.

mod decode;
mod encode;
mod external;
mod storage;

#[cfg(test)]
mod conformance;

pub use decode::{CrdtError, document_from_update_v1, document_from_yrs};
pub use encode::{document_to_yrs, encode_update_v1};
pub use external::{
    EXTERNAL_ORIGIN, ExternalChange, apply_external_document, apply_external_markdown,
};
pub use storage::{DEFAULT_COMPACTION_THRESHOLD, Sidecar, SidecarError, SidecarState};

/// Name of the `Y.XmlFragment` shared with `y-prosemirror`.
pub const PROSEMIRROR_ROOT: &str = "prosemirror";

/// Name of the sibling `Y.Map` holding note frontmatter.
pub const FRONTMATTER_ROOT: &str = "frontmatter";
