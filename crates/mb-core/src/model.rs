//! The block model.
//!
//! Every variant here maps 1:1 to a canonical Markdown rendering (`SPEC.md` §4.4).
//! The model is deliberately constrained to what Markdown can express: that constraint
//! is what makes constraint C2 (a dead app still leaves readable notes) hold.

use crate::frontmatter::Frontmatter;
use crate::task::Task;

/// A whole note: optional frontmatter plus a sequence of blocks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Document {
    pub frontmatter: Frontmatter,
    pub blocks: Vec<Block>,
}

impl Document {
    #[must_use]
    pub fn new(blocks: Vec<Block>) -> Self {
        Self {
            frontmatter: Frontmatter::default(),
            blocks,
        }
    }
}

/// A block plus its optional `^block-id` anchor.
///
/// The anchor lives here rather than on each variant so that anchoring is uniform:
/// any block can be the target of `![[Note#^anchor]]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub kind: BlockKind,
    pub anchor: Option<String>,
}

impl Block {
    #[must_use]
    pub fn new(kind: BlockKind) -> Self {
        Self { kind, anchor: None }
    }

    #[must_use]
    pub fn with_anchor(kind: BlockKind, anchor: impl Into<String>) -> Self {
        Self {
            kind,
            anchor: Some(anchor.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockKind {
    Paragraph(Vec<Inline>),
    Heading {
        level: HeadingLevel,
        content: Vec<Inline>,
    },
    List(List),
    Blockquote(Vec<Block>),
    /// `> [!note] Title` — Obsidian callout syntax, including `[!conflict]` (`SPEC.md` §3.5).
    Callout(Callout),
    CodeBlock {
        lang: Option<String>,
        code: String,
    },
    Divider,
    Table(Table),
    MathBlock(String),
}

/// An ATX heading level, always `1..=6`.
///
/// A newtype rather than a `u8` because Markdown has exactly six levels and `schema.json`
/// constrains the `heading` node's `level` attribute to match. A `Heading` carrying `9`
/// would have no canonical rendering, so it is made unrepresentable instead of clamped at
/// every use (AGENTS.md 4.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HeadingLevel(u8);

impl HeadingLevel {
    pub const H1: Self = Self(1);
    pub const H2: Self = Self(2);
    pub const H3: Self = Self(3);
    pub const H4: Self = Self(4);
    pub const H5: Self = Self(5);
    pub const H6: Self = Self(6);

    /// Returns `None` for a level outside `1..=6`.
    #[must_use]
    pub const fn new(level: u8) -> Option<Self> {
        if level >= 1 && level <= 6 {
            Some(Self(level))
        } else {
            None
        }
    }

    /// Clamps into `1..=6`.
    ///
    /// For callers converting from a source that is already bounded by construction — a
    /// CommonMark heading event, a ProseMirror attribute validated at the boundary — where
    /// propagating an `Option` would only move an impossible case around.
    #[must_use]
    pub const fn clamped(level: u8) -> Self {
        Self(if level < 1 {
            1
        } else if level > 6 {
            6
        } else {
            level
        })
    }

    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callout {
    pub kind: String,
    pub fold: Fold,
    pub title: Vec<Inline>,
    pub content: Vec<Block>,
}

/// Obsidian encodes foldability in the marker suffix: `[!note]`, `[!note]+`, `[!note]-`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Fold {
    #[default]
    None,
    Expanded,
    Collapsed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct List {
    pub ordered: bool,
    /// Start number for ordered lists. Serialization uses lazy numbering (`SPEC.md` §4.4)
    /// but the start value is preserved so `3.` does not silently become `1.`.
    pub start: u64,
    pub items: Vec<ListItem>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListItem {
    /// `Some` makes this a task item: `- [ ]` / `- [x]` / `- [-]` (`SPEC.md` §10).
    pub task: Option<Task>,
    pub content: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Table {
    pub alignments: Vec<Alignment>,
    pub head: Vec<Vec<Inline>>,
    pub rows: Vec<Vec<Vec<Inline>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Alignment {
    #[default]
    None,
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inline {
    Text(String),
    /// Rendered `*x*` or `_x_` depending on neighbours; see `serialize::emphasis_delimiter`.
    Emphasis(Vec<Inline>),
    Strong(Vec<Inline>),
    Strikethrough(Vec<Inline>),
    /// `==highlight==`
    Highlight(Vec<Inline>),
    Code(String),
    /// `$x$`
    Math(String),
    Link {
        dest: String,
        /// The optional `"title"` after the destination, shown as a tooltip.
        ///
        /// Modelled rather than dropped because it is content the author wrote: a link
        /// carrying one round-tripped as a link without one, silently, on the first save.
        title: Option<String>,
        content: Vec<Inline>,
    },
    Image {
        dest: String,
        alt: String,
    },
    /// `[[Target#anchor|alias]]`, or `![[…]]` when `embed` is set.
    WikiLink(WikiLink),
    /// `#tag` or `#nested/tag`
    Tag(String),
    /// A *custom* emoji shortcode `:name:`. Unicode emoji are stored as their literal
    /// glyph in `Text` instead, because a glyph renders in a plain text editor (§11.3).
    Emoji(String),
    FootnoteRef(String),
    SoftBreak,
    HardBreak,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    pub target: String,
    pub anchor: Option<Anchor>,
    pub alias: Option<String>,
    pub embed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Anchor {
    /// `#Heading`
    Heading(String),
    /// `#^block-id`
    Block(String),
}
