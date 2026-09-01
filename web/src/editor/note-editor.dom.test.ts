// @vitest-environment jsdom

import { Editor, type Extensions } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import { describe, expect, it } from "vitest";

import type { LocalPersistence } from "./collaboration.js";
import { startNoteEditor } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";

const CONTRACT = {
  version: 1,
  topNode: "doc",
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
  marks: {},
};

const fixturePath = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fullContract = JSON.parse(
  readFileSync(fixturePath("../../../crates/mb-core/schema.json"), "utf8"),
) as unknown;
const fullFixture = JSON.parse(
  readFileSync(fixturePath("../../../crates/mb-crdt/fixtures/conformance/full.json"), "utf8"),
) as { readonly prosemirror: object };

function localPersistence(): LocalPersistence {
  return { whenSynced: Promise.resolve(), destroy: async () => undefined };
}

describe("mounted note editor", () => {
  it("renders generated block DOM and maps an edit into the Y.XmlFragment", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    let editor: Editor | undefined;
    const session = await startNoteEditor({
      vaultId: "vault",
      noteId: "note",
      element,
      createPersistence: localPersistence,
      loadExtensions: async (): Promise<Extensions> => createMemberberryExtensions(CONTRACT),
      createEditor: (options) => {
        editor = new Editor(options);
        return editor;
      },
    });

    if (editor === undefined) throw new Error("editor factory did not run");
    editor.commands.insertContent("Local edit");

    expect(element.querySelector("p")?.textContent).toBe("Local edit");
    expect(yXmlFragmentToProsemirrorJSON(session.collaboration.fragment)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Local edit" }] }],
    });

    await session.destroy();
    element.remove();
  });

  it("renders every M2 fixture block and inline through the generated DOM rules", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: createMemberberryExtensions(fullContract),
      content: fullFixture.prosemirror,
    });

    expect(element.querySelector("h1")?.textContent).toContain("Heading");
    expect(element.querySelector("ul li[data-task-status='todo']")?.textContent).toContain("todo");
    expect(element.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(element.querySelector("blockquote")?.textContent).toContain("quoted");
    expect(element.querySelector("aside[data-callout='warning']")?.textContent).toContain("Styled title");
    expect(element.querySelector("pre code")?.textContent).toContain("fn main");
    expect(element.querySelector("[data-math-block]")?.textContent).toContain("x + y");
    expect(element.querySelector("hr")).not.toBeNull();
    expect(element.querySelectorAll("table tr")).toHaveLength(2);
    expect(element.querySelector("strong")?.textContent).toBe("strong");
    expect(element.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(element.querySelector("[data-wikilink]")?.textContent).toBe("[[Target]]");
    expect(element.querySelector("[data-tag]")?.textContent).toBe("#nested/tag");
    expect(element.querySelector("[data-emoji]")?.textContent).toBe(":berry:");
    expect(element.querySelector("[data-inline-math]")?.textContent).toBe("$x+y$");
    expect(element.querySelector("sup")?.textContent).toBe("[^note]");

    editor.destroy();
    element.remove();
  });
});
