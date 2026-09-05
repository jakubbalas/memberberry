# AGENTS.md — Working agreements for Memberberry

Read this before writing code. `SPEC.md` is *what* to build; this file is *how*.

**Quality is non-negotiable and mechanically enforced.** Nothing here is aspirational. If
a rule cannot be checked by CI, it is written so a reviewer can check it in seconds.

---

## 0. The four rules that override everything

1. **C2 is sacred.** If the app died right now, the user must still be able to read their
   notes in a text editor. Any change that puts note content somewhere other than plain
   Markdown in `<vault>/notes/**/*.md` is wrong. No exceptions, no "just for this one
   feature", no binary sidecars holding content that is not also in the file.
2. **Untested code does not exist.** A feature is not done when it works. It is done when
   it works, is tested, and the test would fail if the feature broke.
3. **Deny by default.** Every read path is permission-filtered server-side. A permission
   check you forgot is a data breach in a system holding someone's private notes. §3 of
   this file is not optional reading.
4. **When the spec and the code disagree, stop.** Do not silently implement something
   different. Update `SPEC.md` in the same change, or raise the conflict.

---

## 1. Definition of done

A change is done only when **every** box is true. Not most.

- [ ] Implements exactly the specified scope — no more, no less
- [ ] Tests written **with** the code: happy path, edge cases, failure modes
- [ ] Coverage floor met (§2.1); new code does not lower the crate/package number
- [ ] **If it touches a read path: a permission test proving it filters** (§3)
- [ ] **If it adds an enforcement point: added to `SPEC.md` §6.4 and to the leak suite**
- [ ] `make check` passes clean — fmt, clippy `-D warnings`, tests, types, lint
- [ ] **If it touches anything a user sees: `make e2e` passes** (§5.2). `make check` does not
      open a browser, and a green unit suite has already shipped a page nobody could use
- [ ] No new `unwrap`/`expect`/`panic!` in library code (§4.2)
- [ ] No `any` in TypeScript, no `@ts-ignore` (§4.3)
- [ ] Public items documented; non-obvious decisions carry a `// why:` comment
- [ ] Performance budgets (`SPEC.md` §21) still met if a hot path changed
- [ ] `SPEC.md` updated if behaviour, format, schema or permissions changed
- [ ] **`HANDOFF.md` rewritten to match reality** (§9) — including anything you left open
- [ ] No TODO/FIXME left without a linked issue and a reason

If you cannot tick a box, say so explicitly in your summary. Do not quietly skip one and
report success — an honest "tests for the error path are missing because X" is far more
useful than a false green.

---

## 2. Testing

### 2.1 Coverage floor — enforced in CI

| Area | Floor | Rationale |
|---|---|---|
| `mb-core` | **95%** | Pure, no I/O, no excuse. Everything downstream trusts it. |
| `mb-auth` | **95%** | Permission bugs are the worst bugs this project can ship. |
| `mb-crdt`, `mb-search` | **90%** | Correctness-critical, hard to debug in production |
| `mb-index`, `mb-server` | **85%** | I/O boundaries make 100% impractical |
| `web/src/editor`, `web/src/shell` | **85%** | |
| `web/src/public` | **90%** | Anonymous surface; highest risk per line |
| Everything else | **80%** | |

Coverage is a floor, not a target. 95% line coverage with no property tests on the
serializer is worse than 85% with them. Coverage measures what was *executed*, not what
was *verified*.

### 2.2 What every change needs

- **Unit tests** for logic. Fast, isolated, no I/O, no sleeps.
- **Property tests** (`proptest` / `fast-check`) for anything with an invariant:
  round-trips, ordering, idempotence, convergence, permission monotonicity. **Mandatory**
  for the parser, serializer, task metadata, CRDT materialization, search index codec, and
  `effective_role`.
- **Golden/snapshot tests** (`insta`) for Markdown output and rendered HTML. Read every
  snapshot diff — never `cargo insta accept` without looking.
- **Integration tests** for anything crossing a boundary: file, network, database, WASM.
- **E2E** (Playwright) for user-visible flows, including mobile viewports.
- **Regression test first.** Every bug fix starts with a failing test that reproduces it.
  No exceptions, including "obvious" one-line fixes.

### 2.3 Test quality rules

- A test asserts **behaviour**, not implementation. If a refactor that changes no behaviour
  breaks your test, the test is wrong.
- One logical assertion per test; the name states the expectation:
  `viewer_update_frame_is_rejected_and_state_unchanged`, not `test_ws_3`.
- **No flaky tests.** A flaky test is a failing test. Fix or delete it — never retry it,
  never mark it ignored and move on. Randomized tests use seeded RNG and print the seed.
- No `sleep` for synchronization. Use deterministic waits and controllable clocks.
- Tests must not depend on execution order or shared mutable state.
- Prefer real implementations over mocks. Mock only at genuine external boundaries (S3,
  the network). A mock of your own module tests the mock.
- Test the failure modes: malformed input, empty input, huge input, unicode, RTL text,
  emoji in every field, path traversal, concurrent access, **and the unauthorized caller**.
- **A check that cannot observe the failure mode is not a check.** `curl` parses no HTML and
  enforces no CSP, so a 200 from it says nothing about whether a page renders or a form can
  submit. M5 shipped a bundle where every asset 404'd and a login form its own CSP blocked;
  both were green under the unit suite *and* a curl smoke test, and both took one browser
  load to find. Match the tool to the failure you are ruling out — for anything
  user-visible, that means a real browser.
- **A test must be able to fail.** Before trusting a new test, break the thing it covers and
  watch it go red. M5 had a passing asset test that requested the buggy path — it encoded
  the defect instead of catching it.

### 2.4 The suites that must never be weakened

These encode the project's core correctness (`SPEC.md` §22). If one starts failing, fix the
code — never relax the test:

- Markdown round-trip property tests and parser fuzzing (§22.1)
- Cross-language schema conformance (§22.2)
- Sync convergence under partition (§22.3)
- Invariant I1: `rm -rf .memberberry/` and everything still works, permissions included (§22.4)
- **The permission leak suite (§22.5)** — the single most valuable suite in the repo
- Transclusion cycle protection, conflict-callout round-tripping, presence scoping (§22.7)
- **The Playwright E2E suite (§22.6)** — the only thing here that can say a page works. A
  green unit suite has already shipped an application nobody could log into.
- Performance budgets (§21)

---

## 3. Security and permissions

Memberberry holds private notes and shares them with other people. Treat every read path
as a potential leak.

### 3.1 Non-negotiable rules

- **Deny by default.** A missing permission check must fail closed. Malformed
  `access.toml` denies everything rather than granting everything.
- **Never filter permissions on the client.** The client must not *receive* data it may
  not see. Client-side filtering is a UX affordance, never a boundary. This is why the
  search index is zoned (`SPEC.md` §14.2) rather than shipped whole and filtered.
- **Filter at the index/repository layer, not in feature code.** There is no unfiltered
  query helper in this codebase. Features query an already-filtered view. If you find
  yourself writing a permission check inside a UI feature, the filter is in the wrong place.
- **Authorize per frame, not per connection** on the WebSocket. A connection authorized
  once and trusted thereafter is a bug (E3).
- **Content addressing is not authorization.** An unguessable URL is not a permission
  check (E11).
- **A share link never grants more than its creator has**, checked at access time, not
  creation time.
- **Server admin is not omniscience.** The `is_admin` flag permits server administration —
  creating vaults, managing shared emoji packs, resetting passwords. It grants **no** read
  access to vault contents, and the invisibility rule applies to admins unchanged. Never
  add an `if is_admin { skip_check }` branch to a content path.
- **Presence is data.** Awareness reveals which note a person is reading. It follows the
  same permission filter as note content (E4), and is never persisted.
- **Every new enforcement point goes in `SPEC.md` §6.4 and the leak suite.** The list is
  the map; an unlisted enforcement point is one nobody will test.

### 3.2 The invisibility rule

A note a user cannot read **does not exist** for them: no title, no graph node, no backlink
row, no search hit, no tag count, no error message that reveals it exists. When adding any
feature that surfaces note data, ask what it reveals about notes the viewer cannot read,
and add an assertion to the leak suite.

### 3.3 Standard practice

- Argon2id for passwords; constant-time comparison on every secret; CSPRNG for every token.
- Validate and normalize every path before use. Path traversal out of the vault root is a
  test case, not a theoretical concern.
- Server-side URL fetching (the clipper) blocks loopback, private ranges, link-local and
  cloud metadata addresses, including through redirects (§16.3).
- Rate-limit auth, share links and the clip endpoint.
- Secrets never enter a vault directory, a log line, or an error message.
- No dependency added to an auth or public path without reading what it does.

### 3.4 What this model does *not* protect against

Know these so you never imply otherwise in the UI or docs: filesystem access reads
everything (ACLs are not encryption); git history retains content from before an ACL
tightened; a revoked user keeps their offline replica until reconnect. These are documented
consequences of C2 and offline-first, not bugs to fix quietly.

---

## 4. Code quality

### 4.1 General

- **Clarity over cleverness.** The next reader is an LLM with no context, or a human at 2am.
- **Make illegal states unrepresentable.** Newtypes for `NoteId`, `BlockId`, `VaultId`,
  `Sha256`; enums over stringly-typed states; parse into a validated type at the boundary
  rather than validating repeatedly. A `Role` is never a `String`.
- **Errors are values.** Model them explicitly. Never swallow one silently.
- **No premature abstraction.** Two similar call sites are a coincidence; three are a
  pattern. Do not build a framework for one use.
- **Delete aggressively.** Dead code, commented-out code and speculative parameters are
  liabilities. Version control remembers.
- Functions do one thing. If you need "and" to describe it, split it.
- Comments explain **why**, never **what**. If *what* needs a comment, rename things.

### 4.2 Rust

- `#![deny(warnings)]` in CI; clippy at `-D warnings`, pedantic lints considered.
- **No `unwrap`, `expect`, `panic!`, or panicking indexing in library code.** Return
  `Result`. `expect` is permitted in tests, in `main`, and at startup for genuinely
  unrecoverable configuration errors — with a message explaining the invariant.
- `thiserror` for library errors, `anyhow` at the binary boundary. Every variant carries
  enough context to debug without a reproduction.
- No `unsafe` without a `// SAFETY:` block justifying every invariant and a strong reason
  it cannot be safe code. Expect to be asked to remove it.
- Avoid `async` where it buys nothing. `mb-core` is sync and pure — keep it that way.
- Public API items get `///` docs, with an example where usage is not obvious.
- Prefer borrowing; do not `.clone()` to silence the borrow checker without understanding
  why. In hot paths (parser, serializer, index) allocation is a design concern.
- `mb-core` and `mb-search` must compile to `wasm32-unknown-unknown` at all times. No
  `std::fs`, no `SystemTime`, no threads. CI builds them for wasm on every commit.

### 4.3 TypeScript

- `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **No `any`.** Use `unknown` and narrow. No `@ts-ignore`; `@ts-expect-error` only with a
  comment explaining why and what would remove it.
- No non-null assertions (`!`) except immediately after a check the compiler cannot see,
  with a comment.
- Types generated from `schema.json` are generated, never hand-edited.
- Validate everything crossing the wire (`zod` or equivalent). The server does not trust the
  client and the client does not trust the server.
- No default exports. Named exports only — better for refactoring and for grep.
- Effects are explicit and cleaned up. Every listener, observer, worker and subscription has
  a matching teardown, and a test that proves it.

### 4.4 Svelte

- Runes (`$state`, `$derived`, `$effect`). Do not reach for `$effect` when `$derived` will
  do — most `$effect` uses are a modelling mistake.
- Components are presentational; logic lives in plain `.ts` modules testable without
  mounting anything.
- Every interactive element is keyboard-reachable and labelled. `SPEC.md` §8.4 means what it
  says: no mouse-only feature ships.
- Style through design tokens only (`SPEC.md` §20). Hard-coded colours are a bug.

### 4.5 Performance discipline (C6)

- Measure before optimizing, and measure after. "Should be faster" is not a result.
- The budget target is a **mid-range Android phone**, not your laptop (§21.1). If you have
  not seen it on that class of device, you do not know that it is fast.
- Anything on the keystroke path is sacred: no allocation in a loop, no synchronous layout
  thrash, no full document re-render on a single-block change.
- Long tasks belong in a Web Worker. The main thread's job is painting.
- Add a benchmark (`criterion` / `tinybench`) when you touch a hot path; CI tracks it.
- Bundle size is a budget, not a preference. A new dependency on the critical path needs a
  justification in the change description.

---

## 5. Commands

### 5.1 Development ports

Repo-owned development services bind to loopback ports in the `9010`-`9020` range. Keep
assignments stable and record new ones here before adding a listener:

| Port | Development service |
|---|---|
| `9010` | Memberberry HTTP and WebSocket server |
| `9011` | Vite frontend when it runs separately from the server |
| `9012` | Throwaway server the Playwright E2E suite provisions and drives |
| `9013` | Throwaway server the performance harness provisions over a 10k-note vault |
| `9014`-`9020` | Available for supporting services |

Production ports remain explicit deployment configuration. Tests that do not need a stable
address should ask the OS for an ephemeral port instead of consuming this range.

```
make check        # fmt + clippy + test + coverage + tokens — run before done
make e2e          # Playwright in a real browser, desktop and mobile (SPEC §22.6)
make test         # all tests
make test-fast    # behavioural only, the inner loop
make test-props   # the round-trip property suite (SPEC §22.1)
make soak         # property suite at 20k cases; finds what CI will not
make coverage     # per-crate coverage report
make coverage-gate # enforce the floors in §2.1 — part of `make check`
make token-check  # the design-token contract, both directions — part of `make check`
make wasm-check   # mb-core must stay wasm32-clean
make bench        # hot-path benchmarks
make perf         # the SPEC 21 budgets, both device classes, in a real browser
make perf-bundle  # just the critical-path bundle budget — deterministic, no browser
make gen-vault    # synthetic 10k-note vault for perf/scale work
make prod         # release build
```

`make check` is the gate. If it does not pass, the change is not done.

**`make check` does not open a browser.** It is separate from `make e2e` because the browser
download makes it too slow for the inner loop, and because they answer different questions:
`check` says the code is correct, `e2e` says the page works. CI runs both. **If your change
touches anything a user sees, `make check` alone is not evidence** — that combination has
already shipped an application nobody could log into (§2.3).

### 5.2 Test cadence

Three tiers. The question is not how *often* to open a browser — a clean full run is about a
minute — but how *much* to run in it, and *when*.

| When | What | Cost |
|---|---|---|
| Every edit | `make test-fast` | seconds |
| **The first time new UI renders anything**, and after any change to CSS, pointer behaviour or layout | one spec: `npm --prefix web run build && npx playwright test e2e/<name>.spec.ts` | ~30s |
| Before done, and before a commit | `make e2e` | ~1 min (37s of tests plus incremental builds) |

Two rules attached to the middle row, both learned expensively:

- **Rebuild first, every time.** `npx playwright test` does not build. Without the rebuild it
  drives the last bundle you made rather than the code you just wrote, and the failure looks
  exactly like a bug in the feature — a click that "does not work" on an element that is not
  in the page yet. If you are not going to remember, run `make e2e` instead; it builds.
- **Run one spec, not the suite.** A broken interaction costs a 30s timeout per attempt and
  Playwright retries, so the cost of a red run is nothing like the cost of a green one: four
  unreachable click targets once turned a 37-second suite into ten minutes and 23 failures,
  most of them unrelated specs timing out under the load.

**The middle row is about ordering, not thoroughness.** The local graph (§9.4) was built
complete — query, route, client, layout, component, every unit test, twelve mutation probes —
before a browser saw any of it, and the browser then found that an SVG element with
`fill: none` takes no pointer events at all. That is a design constraint rather than a bug: it
changed what the component had to render, and the work written before it had to be revisited.
**Open a browser when a thing first draws, not when it is finished.**

**Skip the browser for a change with no UI delta.** A query, a route, a permission filter: the
Rust suite and the leak suite cover those completely, and Playwright adds a minute and no
information.

---

## 6. Working with the spec

- `SPEC.md` is the contract. Section numbers are stable; reference them in commits
  (`M3: task chips, SPEC §10.2`).
- The **decision log (§24)** records choices the user made, with their words. Do not reverse
  one because a different approach seems better while implementing — raise it.
- The **deliberate exclusions (§4.4)** are decisions, not gaps. Mermaid, Canvas, columns,
  synced blocks, database views and task recurrence were considered and declined. The full
  list is in §25. Do not helpfully add them.
- The **assumptions (§25)** were decided without being asked. If implementing one reveals it
  is wrong, say so — they are marked reversible on purpose.
- The **honest limits** — §6.7, §7.2, §14.2, §9.4 — are stated on purpose. Do not quietly
  paper over one; if you can genuinely remove a limit, say so and update the section.
- **Open questions (§25)** block the milestone they name. Ask rather than assume.
- Discovering the spec is wrong is a good outcome — say so and propose the fix rather than
  routing around it in code.

---

## 7. Things that will be rejected

Stated plainly so they are not attempted:

- Storing note content anywhere other than the Markdown file (violates C2)
- A block type without a canonical Markdown representation (violates spec §3.2)
- A second Markdown parser or serializer in TypeScript (drift; that is why WASM exists)
- **Any query against the index that does not carry a permission filter**
- **Filtering permissions on the client, or trusting a client-supplied user/role**
- **Reusing the authenticated sync path for the anonymous share-link renderer**
- Hand-editing generated schema types on either side
- Skipping a test because "it's simple" or "it's just a refactor"
- `#[allow(...)]` or an eslint-disable without a comment explaining why
- Widening a type to `any`/`unknown` to make an error go away
- Committing a failing or ignored test
- Adding a dependency to the critical bundle path without justification
- Hard-coded colours instead of design tokens
- Network calls to anything outside the user's own infrastructure (violates C1)
- Telemetry, analytics, crash reporting or update checks (violates C1) — the app never
  phones home, not even optionally, not even opt-in

---

## 8. Communication

- Report honestly. If tests fail, show the output. If something was skipped, name it.
- Do not claim done when partially done. Partial with a clear list of what remains is
  useful; false completion is expensive.
- Surface trade-offs when you make them, not afterwards.
- When uncertain between two reasonable designs, pick one, state the assumption and keep
  going — but flag it. Do not stall on a question you can answer with a note in the code.
- Security findings are reported immediately and plainly, even mid-task, even if it means
  admitting the code you just wrote was wrong.

---

## 9. Handoff — `HANDOFF.md`

A fresh session reads `CLAUDE.md` → `AGENTS.md` → `SPEC.md` and nothing else. None of those
carry "where things stand", so that lives in one file at the repo root, and keeping it true
is part of the definition of done (§1).

**What goes in it**

- What was last completed, and what is next.
- Open items you chose not to fix, each with the reason. An open item nobody wrote down gets
  rediscovered as a surprise three milestones later.
- How to run the thing locally, including any step not obvious from the `Makefile`.
- Anything that would mislead someone picking the work up cold — a passing test that does not
  prove what it appears to, a toolchain gotcha, a command that needs a pty.

**What does not**

- Anything durable. A file format, a wire protocol, a decision, a known limit, a performance
  number — those belong in `SPEC.md`, and moving them there is the point. If a fact will
  still be true two milestones from now, it is spec, not handoff.
- History. `git log` has that. Rewrite the file; never append to it.

**One file, not one per milestone.** A `M5_HANDOFF.md` goes stale the moment the milestone
ends, nothing points at it, and so nobody reads it.
