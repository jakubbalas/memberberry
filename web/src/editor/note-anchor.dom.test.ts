// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { extract, load } from "../notes.js";
import { noteAnchorNavigator, noteAnchorPosition } from "./note-anchor.js";
import { createMemberberryExtensions } from "./schema.js";
import { applySourceMarkdown } from "./source.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const editors: Editor[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup() {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: createMemberberryExtensions(contract), content: {
    type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Top" }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Café goals", marks: [{ type: "strong" }] }] },
      { type: "paragraph", attrs: { anchor: "pinned" }, content: [{ type: "text", text: "First pinned" }] },
      { type: "paragraph", attrs: { anchor: "pinned" }, content: [{ type: "text", text: "Second pinned" }] },
      { type: "blockquote", content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Quoted heading" }] },
        { type: "paragraph", attrs: { anchor: "nested" }, content: [{ type: "text", text: "Nested block" }] },
      ] },
    ],
  } });
  editors.push(editor);
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((run) => { frames.set(++nextId, run); return nextId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const scrolled: string[] = [];
  for (const node of element.querySelectorAll<HTMLElement>("p,h2")) node.scrollIntoView = () => { scrolled.push(node.textContent ?? ""); };
  return { editor, element, frames, scrolled, flush: async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    await Promise.all(callbacks.map((run) => run(0)));
  } };
}

describe("note anchor targets and lifecycle", () => {
  it.each([
    ["## Review [[Roadmap|Plan]]", "Review Plan"],
    ["## Review [[Roadmap]]", "Review Roadmap"],
    ["## Review **[[Roadmap|Plan]]**", "Review Plan"],
    ["## Review #project/next", "Review #project/next"],
    ["## Review :custom_plan:", "Review :custom_plan:"],
    ["## Review ![Plan diagram](plan.png)", "Review Plan diagram"],
    ["## Review $x^2$", "Review x^2"],
    ["## Review [**Plan**](Roadmap.md)", "Review Plan"],
  ])("finds the core heading identity in %s", async (heading, identity) => {
    const { editor, element } = setup();
    const markdown = `Top\n\n${heading}\n`;
    await applySourceMarkdown(editor, markdown);
    const facts = await extract(markdown);
    expect(facts.headings[0]?.text).toBe(identity);
    const position = await noteAnchorPosition(editor.state.doc, { anchorKind: "heading", anchor: identity });
    expect(position === undefined ? undefined : editor.view.nodeDOM(position)).toBe(element.querySelector("h2"));
  });

  it("scrolls to an aliased wikilink heading rather than dropping the requested jump", async () => {
    const app = setup();
    await applySourceMarkdown(app.editor, "Top\n\n## Review [[Roadmap|Plan]]\n");
    const heading = app.element.querySelector<HTMLElement>("h2");
    if (heading === null) throw new Error("missing heading");
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    const navigator = noteAnchorNavigator(app.editor);
    try {
      navigator.follow({ anchorKind: "heading", anchor: "Review Plan" });
      await app.flush();
      await vi.waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" }));
    } finally { navigator.destroy(); }
  });

  it("matches normalized headings but not headings quoted inside other blocks", async () => {
    const { editor } = setup();
    const position = await noteAnchorPosition(editor.state.doc, { anchorKind: "heading", anchor: " CAFE\u0301 GOALS " });
    expect(position === undefined ? undefined : editor.state.doc.nodeAt(position)?.textContent).toBe("Café goals");
    expect(await noteAnchorPosition(editor.state.doc, { anchorKind: "heading", anchor: "Quoted heading" })).toBeUndefined();
  });

  it("uses first-match block identity, including nested blocks, without matching a different case", async () => {
    const { editor } = setup();
    const at = async (anchor: string) => {
      const position = await noteAnchorPosition(editor.state.doc, { anchorKind: "block", anchor });
      return position === undefined ? undefined : editor.state.doc.nodeAt(position)?.textContent;
    };
    expect(await Promise.all([at("pinned"), at("nested"), at("Pinned")])).toEqual(["First pinned", "Nested block", undefined]);
  });

  it("a later jump replaces the queued one and never changes document content", async () => {
    const app = setup();
    const before = app.editor.getJSON();
    const navigator = noteAnchorNavigator(app.editor);
    navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
    navigator.follow({ anchorKind: "block", anchor: "pinned" });
    await app.flush();
    expect(app.scrolled).toEqual(["First pinned"]);
    expect(app.editor.getJSON()).toEqual(before);
    navigator.destroy();
  });

  it("discards an in-flight heading lookup after a newer jump replaces it", async () => {
    const app = setup();
    const navigator = noteAnchorNavigator(app.editor);
    try {
      navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
      const first = app.flush();
      navigator.follow({ anchorKind: "block", anchor: "pinned" });
      await first;
      expect(app.scrolled).toEqual([]);
      await app.flush();
      expect(app.scrolled).toEqual(["First pinned"]);
    } finally { navigator.destroy(); }
  });

  it("recomputes an in-flight heading position after the document changes", async () => {
    const app = setup();
    const navigator = noteAnchorNavigator(app.editor);
    try {
      navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
      const first = app.flush();
      app.editor.commands.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Inserted" }] });
      await first;
      expect(app.scrolled).toEqual([]);
      await app.flush();
      expect(app.scrolled).toEqual(["Café goals"]);
    } finally { navigator.destroy(); }
  });

  it("never scrolls an in-flight heading lookup after teardown", async () => {
    const app = setup();
    const navigator = noteAnchorNavigator(app.editor);
    navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
    const first = app.flush();
    navigator.destroy();
    app.editor.destroy();
    await first;
    expect(app.scrolled).toEqual([]);
    expect(app.frames.size).toBe(0);
  });

  it("waits until a hidden note body is ready", async () => {
    const app = setup();
    let ready = false;
    const navigator = noteAnchorNavigator(app.editor, () => ready);
    navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
    await app.flush();
    expect(app.scrolled).toEqual([]);
    ready = true;
    navigator.refresh();
    await app.flush();
    expect(app.scrolled).toEqual(["Café goals"]);
    navigator.destroy();
  });

  it("cancels pending layout work and removes the update subscription on teardown", async () => {
    const app = setup();
    const navigator = noteAnchorNavigator(app.editor);
    navigator.follow({ anchorKind: "heading", anchor: "Café goals" });
    expect(app.frames.size).toBe(1);
    navigator.destroy();
    expect(app.frames.size).toBe(0);
    app.editor.commands.insertContent("another edit");
    navigator.refresh();
    await app.flush();
    expect(app.scrolled).toEqual([]);
    expect(app.frames.size).toBe(0);
  });
});
