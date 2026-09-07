// @vitest-environment jsdom

/**
 * The conflict callout's actions and its count (`SPEC.md` §3.5, §22.7).
 *
 * §3.5 asks for three buttons that perform "an ordinary edit through the CRDT". That claim is
 * what is checked here: a click has to reach the Y document, not just the DOM, or the
 * resolution would look right on screen and never leave the tab.
 *
 * The count is checked against `mb_core::conflict::count` rather than against a number typed
 * into this file. Two implementations answer the same question — Rust over the Markdown for
 * the index, this one over the editor's document for the live header — and the only useful
 * assertion is that they agree.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import { undo } from "y-prosemirror";
import { applyUpdate, Doc } from "yjs";

import { load, noteBridge, type NoteBridge } from "../notes.js";
import { PROSEMIRROR_ROOT, createYjsBinding } from "./collaboration.js";
import {
  CONFLICT_EVENT,
  conflictOrdinal,
  conflictViews,
  conflictsOf,
  isConflictCallout,
  mountConflicts,
  type ConflictDetail,
} from "./conflict-view.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdownWith } from "./source.js";

const contractPath = resolvePath(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

const STAMP = "2026-08-28T22:41:07Z";
const CALLOUT = `> [!conflict] Conflicting version — external edit, ${STAMP}`;

let bridge: NoteBridge;

beforeAll(async () => {
  await load(readFileSync(resolvePath(process.cwd(), "src/wasm/mb_bg.wasm")));
  bridge = await noteBridge();
});

interface Open {
  readonly document: Doc;
  readonly editor: Editor;
  readonly element: HTMLElement;
  destroy(): void;
}

/** A note mounted the way a pane mounts one: bound to its Y.Doc, with the node view on. */
function open(markdown: string, withActions = true): Open {
  const document = new Doc();
  applyUpdate(document, bridge.updateFromMarkdown(markdown));
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [
      ...createMemberberryExtensions(contract),
      ...(withActions ? [conflictViews({ document, bridge })] : []),
      createYjsBinding(document.getXmlFragment(PROSEMIRROR_ROOT)),
    ],
  });
  return {
    document,
    editor,
    element,
    destroy: () => {
      editor.destroy();
      document.destroy();
      element.remove();
    },
  };
}

function buttons(view: Open): HTMLButtonElement[] {
  return [...view.element.querySelectorAll<HTMLButtonElement>(".conflict-action")];
}

describe("conflictsOf", () => {
  /** Every note here is counted twice: once by Rust, once by this module. */
  const notes = [
    ["a note with nothing in it", "Just text.\n"],
    ["one conflict", `Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`],
    ["two conflicts", `A.\n\n${CALLOUT}\n>\n> C.\n\nB.\n\n${CALLOUT}\n>\n> D.\n`],
    ["an ordinary callout", "> [!note] Title\n>\n> Body.\n"],
    ["a conflict inside a quote", `> Quoted:\n>\n> ${CALLOUT}\n> >\n> > Theirs.\n`],
    ["a conflict inside a list item", `- An item:\n\n  ${CALLOUT}\n  >\n  > Theirs.\n`],
    ["a conflict inside a task item", `- [ ] A task:\n\n  ${CALLOUT}\n  >\n  > Theirs.\n`],
  ] as const;

  for (const [name, markdown] of notes) {
    it(`agrees with mb-core for ${name}`, () => {
      const view = open(markdown);
      // Through the round trip the editor itself performs, so what is counted is the document
      // as ProseMirror holds it rather than the string this test typed.
      const canonical = editorMarkdownWith(bridge, view.document);
      expect(conflictsOf(view.editor.state.doc)).toBe(bridge.count(canonical));
      view.destroy();
    });
  }

  it("does not count a conflict nested inside another one", () => {
    // §3.5 forbids the nesting, so this is a note somebody made by hand. A reader sees one
    // callout, and the count has to agree with the reader.
    const nested = `${CALLOUT}\n>\n> ${CALLOUT}\n> >\n> > Older.\n`;
    const view = open(nested);
    expect(conflictsOf(view.editor.state.doc)).toBe(1);
    view.destroy();
  });
});

describe("isConflictCallout", () => {
  it("matches the marker whatever its case", () => {
    const view = open("> [!CONFLICT] Conflicting version — external edit, now\n>\n> Theirs.\n");
    const node = view.editor.state.doc.maybeChild(0);
    expect(node !== null && node !== undefined && isConflictCallout(node)).toBe(true);
    view.destroy();
  });

  it("does not match another kind of callout", () => {
    const view = open("> [!note] Title\n>\n> Body.\n");
    const node = view.editor.state.doc.maybeChild(0);
    expect(node !== null && node !== undefined && isConflictCallout(node)).toBe(false);
    view.destroy();
  });
});

describe("conflictOrdinal", () => {
  it("counts conflicts rather than blocks", () => {
    const view = open(`A.\n\n${CALLOUT}\n>\n> C.\n\nB.\n\n${CALLOUT}\n>\n> D.\n`);
    const doc = view.editor.state.doc;
    const positions: number[] = [];
    doc.forEach((node, offset) => {
      if (isConflictCallout(node)) positions.push(offset);
    });

    expect(positions).toHaveLength(2);
    expect(conflictOrdinal(doc, positions[0] ?? 0)).toBe(0);
    expect(conflictOrdinal(doc, positions[1] ?? 0)).toBe(1);
    view.destroy();
  });

  it("has none for a conflict that is not a top-level block", () => {
    // `mb_core::conflict::nth` only addresses top-level conflicts, so an action offered on a
    // nested one would do nothing. It is not offered.
    const view = open(`> Quoted:\n>\n> ${CALLOUT}\n> >\n> > Theirs.\n`);
    expect(conflictOrdinal(view.editor.state.doc, 1)).toBeUndefined();
    view.destroy();
  });

  it("has none for a conflict nested inside another conflict", () => {
    // §3.5 forbids the nesting, so this is a note made by hand — and the dangerous case: the
    // inner callout's position resolves to the *outer* one, so an ordinal taken without the
    // depth check would resolve somebody else's conflict instead.
    const view = open(`${CALLOUT}\n>\n> ${CALLOUT}\n> >\n> > Older.\n`);
    const doc = view.editor.state.doc;
    expect(conflictOrdinal(doc, 0)).toBe(0);
    // Any position inside the outer callout — where the inner one lives — has no ordinal.
    for (let pos = 1; pos < doc.content.size; pos += 1) {
      expect(conflictOrdinal(doc, pos)).toBeUndefined();
    }
    view.destroy();
  });

  it("has none for a block that is not a conflict callout", () => {
    const view = open("One.\n\n> [!note] Title\n>\n> Body.\n");
    expect(conflictOrdinal(view.editor.state.doc, 0)).toBeUndefined();
    view.destroy();
  });

  it("has none for a position outside the document", () => {
    const view = open("One.\n");
    expect(conflictOrdinal(view.editor.state.doc, -1)).toBeUndefined();
    expect(conflictOrdinal(view.editor.state.doc, 9_999)).toBeUndefined();
    view.destroy();
  });
});

describe("the actions on a conflict callout", () => {
  it("offers §3.5's three, labelled", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    expect(buttons(view).map((button) => button.dataset["conflictKeep"])).toEqual([
      "mine",
      "theirs",
      "both",
    ]);
    expect(buttons(view).map((button) => button.textContent)).toEqual([
      "Keep mine",
      "Keep theirs",
      "Keep both",
    ]);
    view.destroy();
  });

  it("is keyboard-reachable", () => {
    // `AGENTS.md` §4.4: no mouse-only feature ships. Unlike the task checkbox there is no
    // inspector offering the same choices, so these buttons are the only route to them.
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    for (const button of buttons(view)) {
      expect(button.tabIndex).toBe(0);
      button.focus();
      expect(window.document.activeElement).toBe(button);
    }
    view.destroy();
  });

  it("is not offered on a callout that is not a conflict", () => {
    const view = open("> [!note] Title\n>\n> Body.\n");
    expect(buttons(view)).toHaveLength(0);
    // And the callout is still rendered by the schema's own `renderHTML`.
    expect(view.element.querySelector("aside[data-callout='note']")).not.toBeNull();
    view.destroy();
  });

  it("is not offered when no bridge was supplied", () => {
    // An editor mounted with no note boundary behind it. The callout still renders and still
    // round-trips; it just carries no buttons.
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`, false);
    expect(buttons(view)).toHaveLength(0);
    expect(view.element.querySelector("aside[data-callout='conflict']")).not.toBeNull();
    view.destroy();
  });

  it("keeps mine, and the change reaches the CRDT", () => {
    // §3.5: "an ordinary edit through the CRDT — so resolution syncs and is undoable". The
    // Y document is what syncs, so that is where the assertion has to be.
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    buttons(view)[0]?.click();

    expect(editorMarkdownWith(bridge, view.document)).toBe("Mine.\n");
    view.destroy();
  });

  it("keeps theirs, replacing the local version", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    buttons(view)[1]?.click();

    expect(editorMarkdownWith(bridge, view.document)).toBe("Theirs.\n");
    view.destroy();
  });

  it("keeps both, as two ordinary blocks", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    buttons(view)[2]?.click();

    expect(editorMarkdownWith(bridge, view.document)).toBe("Mine.\n\nTheirs.\n");
    view.destroy();
  });

  it("resolves the second of two conflicts without touching the first", () => {
    // The pairwise shape's whole point: each callout owns the block in front of it.
    const view = open(`A.\n\n${CALLOUT}\n>\n> C.\n\nB.\n\n${CALLOUT}\n>\n> D.\n`);
    const all = buttons(view);
    // Six buttons, three per callout; the fifth is "Keep theirs" on the second conflict.
    expect(all).toHaveLength(6);
    all[4]?.click();

    const markdown = editorMarkdownWith(bridge, view.document);
    expect(markdown.startsWith("A.\n\n> [!conflict]")).toBe(true);
    expect(markdown.endsWith("> C.\n\nD.\n")).toBe(true);
    view.destroy();
  });

  it("is undoable, which is what makes it safe to click", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    const before = editorMarkdownWith(bridge, view.document);
    buttons(view)[1]?.click();
    expect(editorMarkdownWith(bridge, view.document)).not.toBe(before);

    // y-prosemirror's undo, not Tiptap's history: the CRDT owns the undo stack for a
    // collaborative document, and it is the stack a resolution has to be on.
    undo(view.editor.state);

    expect(editorMarkdownWith(bridge, view.document)).toBe(before);
    view.destroy();
  });
});

describe("mountConflicts", () => {
  it("announces the count a note already carries, before anything is typed", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    const seen: number[] = [];
    view.editor.view.dom.addEventListener(CONFLICT_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push((event.detail as ConflictDetail).count);
    });

    const announcer = mountConflicts(view.editor);

    expect(seen).toEqual([1]);
    announcer.destroy();
    view.destroy();
  });

  it("announces again when a conflict is resolved, and not otherwise", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    const announcer = mountConflicts(view.editor);
    const seen: number[] = [];
    view.editor.view.dom.addEventListener(CONFLICT_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push((event.detail as ConflictDetail).count);
    });

    // A keystroke changes the document and not the count, and must say nothing: "update"
    // fires per keystroke and a count that is still one is not news.
    view.editor.commands.insertContentAt(1, "x");
    expect(seen).toEqual([]);

    buttons(view)[0]?.click();

    expect(seen).toEqual([0]);
    announcer.destroy();
    view.destroy();
  });

  it("stops announcing once it is torn down", () => {
    const view = open(`Mine.\n\n${CALLOUT}\n>\n> Theirs.\n`);
    const announcer = mountConflicts(view.editor);
    const seen: number[] = [];
    view.editor.view.dom.addEventListener(CONFLICT_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push((event.detail as ConflictDetail).count);
    });

    announcer.destroy();
    buttons(view)[0]?.click();

    expect(seen).toEqual([]);
    view.destroy();
  });
});
