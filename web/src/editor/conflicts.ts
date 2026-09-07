/**
 * Making a divergent reconnection visible (`SPEC.md` §3.5).
 *
 * The sequence this exists for: a device edits a note while offline, the note also changes
 * elsewhere, and the two meet when the socket comes back. A CRDT merges them at block
 * granularity without asking, and the loser of a block-level race disappears — silently.
 * §3.5's answer is to keep the local version in place and insert the divergent one after it
 * as a `[!conflict]` callout, with three actions on it.
 *
 * **The comparison is done in Rust.** Every version crosses the boundary as Markdown and
 * `mb-core` aligns the blocks, which is the §5.2 rule: a "quick" TypeScript diff here would
 * be a second opinion about what a note means. What lives in this module is *when* to ask,
 * what to do with the answer, and where the merge base comes from.
 *
 * **Nothing here awaits.** Between reading the document and writing the merged version back
 * there must be no gap, or a keystroke lands in it and the write deletes it. That is why the
 * WASM entry points arrive as a `NoteBridge` the caller has already loaded, rather than being
 * awaited one at a time — see `notes.ts`.
 */

import type { EditorView } from "@tiptap/pm/view";
import type { Doc } from "yjs";

import type { ConflictSide, NoteBridge } from "../notes.js";
import { applySourceMarkdownWith, editorMarkdownWith } from "./source.js";
import type { ServerState } from "./sync.js";

export interface ReconcileOptions {
  readonly view: EditorView;
  readonly document: Doc;
  readonly bridge: NoteBridge;
  /** The server's whole state, and what this device held that it had not seen. */
  readonly state: ServerState;
  /**
   * The Markdown this note had when the two sides were last in sync (§3.5).
   *
   * `undefined` for a note this device has never synced, which degrades the comparison to
   * two-way — content-keeping, and able to resurrect a deletion made elsewhere.
   */
  readonly base: string | undefined;
  /** Injectable for tests; defaults to the wall clock, to the second. */
  readonly now?: () => string;
}

/** What a reconciliation leaves behind for its caller to record and to display. */
export interface Reconciliation {
  /** How many unresolved conflicts the note now carries, at any depth. */
  readonly conflicts: number;
  /**
   * The Markdown both sides now hold, to be stored as the next merge base.
   *
   * The callout insertion is an ordinary edit through the CRDT, so it flushes to the server
   * like any other — which is what makes this the version they agree on, and what makes the
   * *next* divergence detectable.
   */
  readonly base: string;
}

/**
 * Rewrites the open note to carry §3.5's conflict callouts, if there is a conflict.
 *
 * Called for every arrival of the server's state, not only a divergent one: with nothing
 * unsent there is nothing to merge, and the only work is recording the base.
 *
 * The rewrite is a `setContent` through the y-prosemirror binding — an ordinary edit through
 * the CRDT, so it syncs to everyone and is undoable, which is exactly what §3.5 asks
 * resolution to be.
 */
export function reconcile(options: ReconcileOptions): Reconciliation {
  const current = editorMarkdownWith(options.bridge, options.document);
  if (options.state.mine === undefined) {
    // The server already had everything this device holds, so the merge that just happened
    // could not have dropped anything of ours. What both sides hold is what is on screen.
    return { conflicts: options.bridge.count(current), base: current };
  }
  const mine = options.bridge.markdownFromUpdate(options.state.mine);
  // The server's frame is its whole state (§7.1), so it materializes on its own — no local
  // document is involved in reading it, which is the point: this has to be *their* version.
  const theirs = options.bridge.markdownFromUpdate(options.state.theirs);
  const merged = options.bridge.merge(options.base, mine, theirs, (options.now ?? stamp)());
  // Compared against the document as the CRDT left it rather than assumed to differ. A
  // `setContent` replaces the document, which moves the caret to the top and takes the scroll
  // position with it — and every reconnection comes through here, so rewriting an unchanged
  // note would throw a reader out of their place for nothing.
  if (merged !== current) applySourceMarkdownWith(options.bridge, options.view, merged);
  return { conflicts: options.bridge.count(merged), base: merged };
}

export interface ResolveOptions {
  readonly view: EditorView;
  readonly document: Doc;
  readonly bridge: NoteBridge;
  /** Which conflict, counting from the top of the note. See `NoteBridge.resolve`. */
  readonly ordinal: number;
  readonly keep: ConflictSide;
}

/**
 * Applies one of §3.5's three actions, and reports whether it changed anything.
 *
 * `false` means the ordinal named no conflict — a button clicked on a note that has since
 * moved on, which happens when somebody else resolved the same one first. Inert rather than
 * destructive, and silent: there is nothing a reader could do about it except click the
 * button that is no longer there.
 */
export function applyResolution(options: ResolveOptions): boolean {
  const markdown = editorMarkdownWith(options.bridge, options.document);
  const resolved = options.bridge.resolve(markdown, options.ordinal, options.keep);
  if (resolved === markdown) return false;
  applySourceMarkdownWith(options.bridge, options.view, resolved);
  return true;
}

/**
 * The timestamp §3.5 writes into a callout's title.
 *
 * Seconds, not milliseconds: it is read by a person, in a file, and the extra three digits
 * say nothing a reader of a conflict wants to know.
 */
function stamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
