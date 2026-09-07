// @vitest-environment jsdom

/**
 * Reconciling a divergent reconnection, and resolving what it marks (`SPEC.md` §3.5, §22.7).
 *
 * The comparison itself is `mb-core`'s and is tested there. What is tested here is the part
 * that only exists in the browser: which versions are handed to it, that the rewrite reaches
 * the editor through the CRDT rather than around it, and that the base it hands back is the
 * one that makes the *next* divergence detectable.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { applyUpdate, Doc } from "yjs";

import { load, noteBridge, type NoteBridge } from "../notes.js";
import { PROSEMIRROR_ROOT, createYjsBinding } from "./collaboration.js";
import { applyResolution, reconcile } from "./conflicts.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdownWith } from "./source.js";

const contractPath = resolvePath(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

const STAMP = "2026-08-28T22:41:07Z";
let bridge: NoteBridge;

beforeAll(async () => {
  await load(readFileSync(resolvePath(process.cwd(), "src/wasm/mb_bg.wasm")));
  bridge = await noteBridge();
});

/**
 * A Yjs document holding a note, plus an editor bound to it the way a pane is.
 *
 * The binding is the point rather than setup noise: everything here writes through
 * `setContent`, and what makes that an ordinary CRDT edit — syncable and undoable, which is
 * what §3.5 asks resolution to be — is `y-prosemirror` sitting between the two. An editor
 * holding the same text without the binding would pass every assertion below while changing
 * nothing a second device would ever see.
 */
function note(markdown: string): { document: Doc; editor: Editor; destroy: () => void } {
  const document = new Doc();
  applyUpdate(document, bridge.updateFromMarkdown(markdown));
  const element = window.document.createElement("div");
  const editor = new Editor({
    element,
    extensions: [
      ...createMemberberryExtensions(contract),
      createYjsBinding(document.getXmlFragment(PROSEMIRROR_ROOT)),
    ],
  });
  return {
    document,
    editor,
    destroy: () => {
      editor.destroy();
      document.destroy();
    },
  };
}

/** The state of a note as it would arrive from the server or be captured locally. */
function state(markdown: string): Uint8Array {
  return bridge.updateFromMarkdown(markdown);
}

describe("reconciling the server's state", () => {
  it("marks a collision and reports what the note now carries", () => {
    // §3.5's sequence: this device changed a paragraph offline, somebody else changed the
    // same one, and the CRDT has just merged them without asking.
    const open = note("Four levels.\n");
    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: "Three levels.\n",
      state: { mine: state("Five levels.\n"), theirs: state("Four levels.\n") },
      now: () => STAMP,
    });

    // §3.5's shape, and the order is the contract: the *local* version stays where it was
    // and the divergent one follows it in the callout. The other way round is a note that
    // silently adopted somebody else's paragraph and filed the author's own as the intruder.
    expect(result.conflicts).toBe(1);
    expect(result.base).toBe(
      "Five levels.\n\n" +
        `> [!conflict] Conflicting version — external edit, ${STAMP.replace(":41", "\\:41")}\n` +
        ">\n" +
        "> Four levels.\n",
    );
    expect(open.editor.getText()).toContain("Five levels.");
    expect(open.editor.getText()).toContain("Four levels.");
    open.destroy();
  });

  it("marks nothing when only the other side changed the note", () => {
    // The ordinary reconnection, and the one the base exists to keep quiet. Without it this
    // is indistinguishable from a collision, and every shared vault grows callouts.
    const open = note("Four levels.\n");
    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: "Three levels.\n",
      state: { mine: state("Three levels.\n"), theirs: state("Four levels.\n") },
      now: () => STAMP,
    });

    expect(result.conflicts).toBe(0);
    expect(result.base).toBe("Four levels.\n");
    expect(open.editor.getText()).not.toContain("Conflicting version");
    open.destroy();
  });

  it("leaves the note alone when the server already had everything", () => {
    // No local state captured means nothing of this device's could have been lost, so there
    // is nothing to merge — only the base to record.
    const open = note("Four levels.\n");
    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: "Three levels.\n",
      state: { theirs: state("Four levels.\n") },
      now: () => STAMP,
    });

    expect(result).toEqual({ conflicts: 0, base: "Four levels.\n" });
    open.destroy();
  });

  it("counts conflicts a note was already carrying", () => {
    // The badge has to agree with what is on screen, including a conflict nobody resolved
    // last time. Nothing is rewritten: the merge lost nothing this time.
    const carried =
      "Mine.\n\n> [!conflict] Conflicting version — external edit, then\n>\n> Theirs.\n";
    const open = note(carried);
    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: carried,
      state: { theirs: state(carried) },
      now: () => STAMP,
    });

    expect(result.conflicts).toBe(1);
    open.destroy();
  });

  it("degrades without a base rather than refusing to reconcile", () => {
    // A note this device has never synced, or whose body was dropped. The comparison keeps
    // content, so the collision is still marked — it is deletions it can no longer honour.
    const open = note("Four levels.\n");
    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: undefined,
      state: { mine: state("Five levels.\n"), theirs: state("Four levels.\n") },
      now: () => STAMP,
    });

    expect(result.conflicts).toBe(1);
    expect(result.base.startsWith("Five levels.\n")).toBe(true);
    open.destroy();
  });

  it("does not touch the note when the merge produced what is already on screen", () => {
    // why: `setContent` replaces the document, and replacing it moves the caret to the top
    // and the scroll with it. Every reconnection does this, so a reconciliation that rewrote
    // an unchanged note would throw a reader out of their place for nothing.
    //
    // The caret is what the assertion has to be on. The contents would be identical either
    // way, and so would the CRDT's clock: y-prosemirror diffs the two and produces no update
    // when nothing changed, which is exactly why the contents cannot show this.
    const open = note("Same.\n\nSecond paragraph.\n");
    open.editor.commands.setTextSelection(open.editor.state.doc.content.size - 2);
    const caret = open.editor.state.selection.from;
    expect(caret).toBeGreaterThan(1);

    const result = reconcile({
      view: open.editor.view,
      document: open.document,
      bridge,
      base: "Same.\n\nSecond paragraph.\n",
      state: {
        mine: state("Same.\n\nSecond paragraph.\n"),
        theirs: state("Same.\n\nSecond paragraph.\n"),
      },
      now: () => STAMP,
    });

    expect(result.conflicts).toBe(0);
    expect(open.editor.state.selection.from).toBe(caret);
    open.destroy();
  });

  it("hands back a base the next reconciliation can use", () => {
    // The durability claim, end to end: what this returns is what both sides hold once the
    // rewrite has flushed, so feeding it back must mark nothing new.
    const first = note("Four levels.\n");
    const merged = reconcile({
      view: first.editor.view,
      document: first.document,
      bridge,
      base: "Three levels.\n",
      state: { mine: state("Five levels.\n"), theirs: state("Four levels.\n") },
      now: () => STAMP,
    });
    first.destroy();

    const second = note(merged.base);
    const again = reconcile({
      view: second.editor.view,
      document: second.document,
      bridge,
      base: merged.base,
      state: { mine: state(merged.base), theirs: state(merged.base) },
      now: () => STAMP,
    });

    expect(again.conflicts).toBe(merged.conflicts);
    expect(again.base).toBe(merged.base);
    second.destroy();
  });
});

describe("resolving a conflict", () => {
  /** A note carrying two conflicts, of the shape `merge` emits. */
  function diverged(): { document: Doc; editor: Editor; destroy: () => void } {
    return note(
      bridge.merge("A.\n\nB.\n", "A1.\n\nB1.\n", "C.\n\nD.\n", STAMP),
    );
  }

  it("keeps the local version and drops the callout", () => {
    const open = diverged();
    expect(
      applyResolution({
        view: open.editor.view,
        document: open.document,
        bridge,
        ordinal: 0,
        keep: "mine",
      }),
    ).toBe(true);

    const markdown = editorMarkdownWith(bridge, open.document);
    expect(bridge.count(markdown)).toBe(1);
    expect(markdown).toContain("A1.");
    open.destroy();
  });

  it("replaces only the block the callout belongs to", () => {
    // The defect this shape exists to fix: keeping theirs on the first of a paired run used
    // to leave `A., C., D.`, because the run's boundary was not recoverable from the file.
    const open = diverged();
    applyResolution({
      view: open.editor.view,
      document: open.document,
      bridge,
      ordinal: 0,
      keep: "theirs",
    });

    const markdown = editorMarkdownWith(bridge, open.document);
    expect(markdown.startsWith("C.\n\nB1.\n")).toBe(true);
    expect(bridge.count(markdown)).toBe(1);
    open.destroy();
  });

  it("keeps both as ordinary blocks", () => {
    const open = diverged();
    applyResolution({
      view: open.editor.view,
      document: open.document,
      bridge,
      ordinal: 0,
      keep: "both",
    });

    const markdown = editorMarkdownWith(bridge, open.document);
    expect(markdown.startsWith("A1.\n\nC.\n")).toBe(true);
    expect(bridge.count(markdown)).toBe(1);
    open.destroy();
  });

  it("resolves the second conflict independently of the first", () => {
    const open = diverged();
    applyResolution({
      view: open.editor.view,
      document: open.document,
      bridge,
      ordinal: 1,
      keep: "theirs",
    });

    const markdown = editorMarkdownWith(bridge, open.document);
    expect(markdown.endsWith("D.\n")).toBe(true);
    expect(markdown).toContain("A1.");
    expect(bridge.count(markdown)).toBe(1);
    open.destroy();
  });

  it("does nothing, and says so, for a conflict that is no longer there", () => {
    // Somebody else resolved it first, and this reader's button is still on screen. Inert
    // rather than destructive: an ordinal past the last conflict must not rewrite a block.
    const open = note("One.\n\nTwo.\n");
    const before = open.editor.state.doc.toJSON() as unknown;

    expect(
      applyResolution({
        view: open.editor.view,
        document: open.document,
        bridge,
        ordinal: 0,
        keep: "theirs",
      }),
    ).toBe(false);
    expect(open.editor.state.doc.toJSON() as unknown).toEqual(before);
    open.destroy();
  });

  it("addresses the conflict a reader sees even when the editor holds an extra empty block", () => {
    // An ordinal rather than a block index, and the reason: `doc` may end in an empty
    // paragraph that canonicalization drops, so a position taken from the screen can name a
    // different block once the note is serialized.
    const open = diverged();
    open.editor.commands.focus("end");
    open.editor.commands.insertContentAt(open.editor.state.doc.content.size, {
      type: "paragraph",
    });

    applyResolution({
      view: open.editor.view,
      document: open.document,
      bridge,
      ordinal: 1,
      keep: "mine",
    });

    const markdown = editorMarkdownWith(bridge, open.document);
    expect(bridge.count(markdown)).toBe(1);
    expect(markdown).toContain("B1.");
    open.destroy();
  });
});
