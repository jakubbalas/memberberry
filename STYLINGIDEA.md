# Notion-style block menu ideas

Proposal based on the six Notion screenshots in `local/blocksscreens/`, reviewed on
2026-10-14. The user subsequently approved the items labelled **Include**, plus Web
bookmark and Date. Their implemented contract is recorded in `SPEC.md` §8.4.
Current implementation status below refers to the editor work described in `HANDOFF.md`.

The screenshots show Notion's **block insertion menu**: a searchable catalogue of things
to add. Memberberry's current block `⋯` opens only Move up/down. We can adopt the catalogue
while distinguishing **inserting a new block** from **turning an existing block into
another type**.

## Item inventory and recommendations

| Screenshot items | Recommendation for Memberberry |
|---|---|
| **Text; Heading 1–4** | **Include.** Already supported; expose consistently in the menu. |
| **Bulleted list; Numbered list; To-do list** | **Include.** Existing types and conversion actions. |
| **Toggle list** | **Include.** The branch already implements folding through Markdown callouts. |
| **Callout; Quote** | **Include.** Existing types. |
| **Table; Divider** | **Include as insertion actions.** Converting populated content into these needs separate rules to avoid losing text. |
| **Code; Block equation** | **Include.** Existing types; provide a useful language picker and equation editor where needed. |
| **Image** | **Include.** Reuse the existing media upload flow. |
| **Link to page; Mention a page or data source** | **Include as “Link to note.”** Use a permission-filtered note picker; omit the database/data-source concept. |
| **Emoji; Inline equation** | **Include.** Both fit existing Markdown representations. |
| **File** | **Good addition.** Upload an attachment and insert an ordinary Markdown link. |
| **Page** | **Useful follow-up: “Create linked note.”** Create a real `.md` note and insert its link. This expands the earlier formatting scope, which explicitly left Page out. |
| **Web bookmark** | **Useful as “Web link.”** Start with a labelled Markdown link. Rich previews and automatic metadata fetching are a separate feature. |
| **Table of contents** | **Useful follow-up.** An outline pane already exists. An in-document TOC needs an explicit Markdown representation and refresh behaviour. |
| **Toggle heading 1–3** | **Consider later.** Useful, but not equivalent to current callout toggles; needs decisions about heading navigation, folding boundaries and storage. |
| **Video; Audio** | **Later.** Attachment links are straightforward; embedded players require additional rendering and format decisions. |
| **Date or reminder** | **Partially include.** A date insertion action is reasonable; task due dates already exist. Reminders require scheduling and notification behaviour. |
| **Breadcrumb** | **Keep in navigation initially.** Its value as stored note content is less clear. |
| **Mention a person** | **Defer.** Person mentions and notification semantics are outside current scope. |
| **Button; Tabs** | **Defer.** Interactive content needs a new behaviour and storage contract. Notion's Tabs here means an in-page block, distinct from Memberberry's workspace tabs. |
| **Table view; Board view; Gallery view** | **Skip for this work.** These are database views, explicitly outside the current scope. Ordinary tables remain included. |
| **Synced block** | **Skip.** Explicitly excluded. Existing note/block transclusion covers some related uses. |
| **2, 3, 4, 5 columns** | **Skip.** Multi-column layouts are explicitly excluded. |
| **Code – Mermaid** | **Skip.** Mermaid was explicitly declined. |
| **AI Meeting Notes; AI Block** | **Skip.** External AI services conflict with the app's own-infrastructure-only contract; no local AI workflow is specified. |
| **Embed; HTML; Google Drive; Tweet** | **Skip generic/provider embeds for now.** Arbitrary HTML is excluded, and third-party embeds introduce external requests. Internal note transclusion and ordinary links remain suitable. |

## Menu presentation

Borrow search/filter, category headings, icons, Markdown shortcut hints, hover previews
and Escape to close. Preview cards can follow once the menu itself feels right.

## Suggested first implementation

The approved slice exposes all the included basic blocks, code/equations, images, note
links and emoji, plus Web bookmark and Date, in a searchable, grouped menu. File was
labelled **Good addition**, rather than **Include**, and remains a follow-up. Much of
this exposes capabilities that already exist.

For the block `⋯`, provide:

- **Turn into…** — show only safe conversions of the existing block.
- **Insert below…** — open the block catalogue shown in the screenshots.
- **Move up/down** — retain the existing movement actions and their single-editor guards.

This keeps insertion and conversion clear and avoids unexpectedly replacing existing
content. Implementation must preserve the existing structural-conversion guards and
update `SPEC.md` for any approved behaviour or format changes.
