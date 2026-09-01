# CRDT conformance fixtures

Each basename is one cross-language contract triple from `SPEC.md` §22.2:

- `.md`: canonical Markdown
- `.json`: the ProseMirror document JSON plus its sibling frontmatter map
- `.bin`: the complete lib0 v1 Yjs state update

Rust validates the triples and schema coverage in `mb-crdt::conformance`. M3's TypeScript
suite will load `.bin` and require the same semantic `.json` state.

Lib0 updates are not canonical byte strings: object key order is semantically irrelevant but
changes their encoding. Conformance therefore compares materialized ProseMirror/frontmatter
JSON and Markdown, never byte equality between separately produced updates.

After an intentional schema or encoding change, inspect the diff produced by:

```sh
UPDATE_CONFORMANCE_FIXTURES=1 cargo test -p mb-crdt conformance_fixture
```

The fixed fixture client ID must never be used for live documents; repeated live client IDs
would make unrelated Yjs operations collide.
