// @vitest-environment jsdom

/**
 * The outline bridge (`SPEC.md` §9.5).
 *
 * Two halves, and they are tested differently. The rules — which headings a document has,
 * which blocks a section covers, where the caret sits — are pure and asserted directly
 * against a real Tiptap document built from the Rust-owned schema contract. The scroll
 * measuring is not: jsdom lays nothing out, every box is at zero, and a test that pretended
 * otherwise would be asserting jsdom's defaults. `web/e2e/outline.spec.ts` is where the
 * scrolling is checked, in a browser that has a viewport.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  OUTLINE_EVENT,
  OUTLINE_GOTO_EVENT,
  OUTLINE_MOVE_EVENT,
  type OutlineDetail,
  activeHeadingIndex,
  mountOutline,
  moveSection,
  outlineOf,
  sectionSpan,
} from "./outline.js";
import { createMemberberryExtensions } from "./schema.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

const heading = (level: number, text: string) => ({
  type: "heading",
  attrs: { level, anchor: null },
  content: [{ type: "text", text }],
});

const paragraph = (text: string) => ({
  type: "paragraph",
  attrs: { anchor: null },
  content: [{ type: "text", text }],
});

/** A note with two top-level sections, the first holding a subsection. */
const NOTE = {
  type: "doc",
  content: [
    paragraph("Front matter, above every heading."),
    heading(1, "First"),
    paragraph("Under first."),
    heading(2, "Nested"),
    paragraph("Under nested."),
    heading(1, "Second"),
    paragraph("Under second."),
  ],
};

function mount(content: unknown = NOTE) {
  const element = document.createElement("div");
  element.className = "editor-surface";
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: createMemberberryExtensions(contract),
    content: content as Record<string, unknown>,
  });
  return {
    editor,
    element,
    teardown: (): void => {
      editor.destroy();
      element.remove();
    },
  };
}

/** The document's top-level blocks as `type:text`, which is what a move has to rearrange. */
function blocks(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(`${node.type.name}:${node.textContent}`));
  return out;
}

describe("reading a document's outline", () => {
  it("names every heading, with its level and its block", () => {
    const { editor, teardown } = mount();
    try {
      expect(outlineOf(editor.state.doc)).toEqual([
        { index: 0, block: 1, level: 1, text: "First" },
        { index: 1, block: 3, level: 2, text: "Nested" },
        { index: 2, block: 5, level: 1, text: "Second" },
      ]);
    } finally {
      teardown();
    }
  });

  it("is empty for a note with no headings", () => {
    const { editor, teardown } = mount({ type: "doc", content: [paragraph("Just prose.")] });
    try {
      expect(outlineOf(editor.state.doc)).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe("what a section covers", () => {
  it("runs to the next heading of equal or higher level, subsections included", () => {
    // The same rule `mb_core::transclude::slice` uses, so moving a section moves exactly what
    // transcluding it would show.
    const { editor, teardown } = mount();
    try {
      expect(sectionSpan(editor.state.doc, 0)).toEqual({ start: 1, end: 5 });
      expect(sectionSpan(editor.state.doc, 1)).toEqual({ start: 3, end: 5 });
      expect(sectionSpan(editor.state.doc, 2)).toEqual({ start: 5, end: 7 });
    } finally {
      teardown();
    }
  });

  it("has nothing to say about an index that is not a heading", () => {
    const { editor, teardown } = mount();
    try {
      expect(sectionSpan(editor.state.doc, 9)).toBeUndefined();
    } finally {
      teardown();
    }
  });
});

describe("moving a section", () => {
  it("carries its blocks and its subsections with it", () => {
    const { editor, teardown } = mount();
    try {
      expect(moveSection(editor, 2, 0)).toBe(true);
      expect(blocks(editor)).toEqual([
        "paragraph:Front matter, above every heading.",
        "heading:Second",
        "paragraph:Under second.",
        "heading:First",
        "paragraph:Under first.",
        "heading:Nested",
        "paragraph:Under nested.",
      ]);
    } finally {
      teardown();
    }
  });

  it("puts a section moved downward after the whole target section", () => {
    const { editor, teardown } = mount();
    try {
      expect(moveSection(editor, 1, 2)).toBe(true);
      expect(blocks(editor)).toEqual([
        "paragraph:Front matter, above every heading.",
        "heading:First",
        "paragraph:Under first.",
        "heading:Second",
        "paragraph:Under second.",
        "heading:Nested",
        "paragraph:Under nested.",
      ]);
    } finally {
      teardown();
    }
  });

  it("leaves the levels alone", () => {
    // Moving an `##` above an `#` does not promote it: the heading text is the user's, and
    // rewriting it is a bigger claim than "move these blocks".
    const { editor, teardown } = mount();
    try {
      moveSection(editor, 1, 0);
      expect(outlineOf(editor.state.doc).map((entry) => entry.level)).toEqual([2, 1, 1]);
    } finally {
      teardown();
    }
  });

  it("refuses to move a section into itself, and changes nothing", () => {
    const { editor, teardown } = mount();
    try {
      const before = blocks(editor);
      // Section 0 contains the heading of section 1, so this has no meaning.
      expect(moveSection(editor, 0, 1)).toBe(false);
      expect(moveSection(editor, 0, 0)).toBe(false);
      expect(moveSection(editor, 0, 9)).toBe(false);
      expect(blocks(editor)).toEqual(before);
    } finally {
      teardown();
    }
  });

  it("leaves the blocks above the first heading where they are", () => {
    const { editor, teardown } = mount();
    try {
      moveSection(editor, 2, 0);
      expect(blocks(editor)[0]).toBe("paragraph:Front matter, above every heading.");
    } finally {
      teardown();
    }
  });
});

describe("the current section", () => {
  it("is the last heading at or above the top of the viewport", () => {
    expect(activeHeadingIndex([0, 200, 400], 210)).toBe(1);
    expect(activeHeadingIndex([0, 200, 400], 400)).toBe(2);
  });

  it("is nothing at all while the reader is above the first heading", () => {
    // A real state: a note usually opens with a paragraph above its first `##`, and claiming
    // that paragraph belongs to the first section would highlight a row nobody is reading.
    expect(activeHeadingIndex([120, 400], 0)).toBe(-1);
    expect(activeHeadingIndex([], 0)).toBe(-1);
  });

  it("counts a heading scrolled exactly to the top as reached", () => {
    expect(activeHeadingIndex([0, 200], 199)).toBe(1);
  });
});

describe("the bridge", () => {
  const listen = (element: HTMLElement): OutlineDetail[] => {
    const seen: OutlineDetail[] = [];
    element.addEventListener(OUTLINE_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push(event.detail as OutlineDetail);
    });
    return seen;
  };

  it("announces the outline as soon as it is mounted", () => {
    const { editor, element, teardown } = mount();
    const seen = listen(element);
    const bridge = mountOutline(editor);
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0]?.headings.map((entry) => entry.text)).toEqual([
        "First",
        "Nested",
        "Second",
      ]);
    } finally {
      bridge.destroy();
      teardown();
    }
  });

  it("announces again when the document changes", () => {
    const { editor, element, teardown } = mount();
    const bridge = mountOutline(editor);
    const seen = listen(element);
    try {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: "heading",
        attrs: { level: 1, anchor: null },
        content: [{ type: "text", text: "Third" }],
      });
      expect(seen.at(-1)?.headings.map((entry) => entry.text)).toContain("Third");
    } finally {
      bridge.destroy();
      teardown();
    }
  });

  it("moves a section when asked, and announces the new order", () => {
    const { editor, element, teardown } = mount();
    const bridge = mountOutline(editor);
    const seen = listen(element);
    try {
      editor.view.dom.dispatchEvent(
        new CustomEvent(OUTLINE_MOVE_EVENT, { detail: { from: 2, to: 0 } }),
      );
      expect(blocks(editor)[1]).toBe("heading:Second");
      expect(seen.at(-1)?.headings.map((entry) => entry.text)).toEqual([
        "Second",
        "First",
        "Nested",
      ]);
    } finally {
      bridge.destroy();
      teardown();
    }
  });

  it("puts the caret in the section it was asked to go to", () => {
    // The scroll itself needs a viewport (`e2e/outline.spec.ts`); what is checkable here is
    // that the next keystroke lands in the section the reader asked to see rather than
    // wherever the caret was left.
    const { editor, teardown } = mount();
    const bridge = mountOutline(editor);
    try {
      editor.view.dom.dispatchEvent(
        new CustomEvent(OUTLINE_GOTO_EVENT, { detail: { index: 2 } }),
      );
      const { $from } = editor.state.selection;
      expect($from.parent.textContent).toBe("Second");
    } finally {
      bridge.destroy();
      teardown();
    }
  });

  it("ignores a request naming a heading that is not there", () => {
    const { editor, teardown } = mount();
    const bridge = mountOutline(editor);
    try {
      const before = blocks(editor);
      editor.view.dom.dispatchEvent(
        new CustomEvent(OUTLINE_GOTO_EVENT, { detail: { index: 99 } }),
      );
      editor.view.dom.dispatchEvent(
        new CustomEvent(OUTLINE_MOVE_EVENT, { detail: { from: 99, to: 0 } }),
      );
      expect(blocks(editor)).toEqual(before);
    } finally {
      bridge.destroy();
      teardown();
    }
  });

  it("stops listening when it is destroyed", () => {
    // A pane is opened and closed constantly under tabs and splits (§8.2), so a bridge that
    // outlived its editor would be a listener per note ever opened. The teardown is proved
    // against a listener that was demonstrably live first.
    const { editor, element, teardown } = mount();
    const bridge = mountOutline(editor);
    const seen = listen(element);
    try {
      editor.commands.insertContentAt(0, paragraph("live"));
      expect(seen.length).toBeGreaterThan(0);
      const before = seen.length;
      bridge.destroy();
      editor.commands.insertContentAt(0, paragraph("after"));
      expect(seen).toHaveLength(before);
    } finally {
      teardown();
    }
  });
});
