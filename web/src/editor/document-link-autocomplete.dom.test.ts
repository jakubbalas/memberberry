// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNoteEditor, type NoteEditor } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const sessions: NoteEditor[] = [];
const readable = [
  { path: "Projects/Roadmap.md", title: "Roadmap" },
  { path: "Archive/Roadmap.md", title: "Older Roadmap" },
  { path: "Public/Café.md", title: "Café ☕" },
];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.destroy()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount(loadLinkNotes = async () => readable) {
  const element = document.createElement("div");
  document.body.append(element);
  const session = await startNoteEditor({
    vaultId: "personal", noteId: "Source.md", element,
    createPersistence: () => ({ whenSynced: Promise.resolve(), destroy: async () => undefined }),
    loadExtensions: async () => createMemberberryExtensions(contract), loadEmojiCatalog: async () => [],
    loadLinkNotes,
  });
  sessions.push(session);
  if (!(session.editor instanceof Editor)) throw new Error("missing editor");
  const editor = session.editor;
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
  editor.view.focus();
  return editor;
}
function key(editor: Editor, value: string): void {
  editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}
const popup = () => document.querySelector<HTMLElement>('[role="listbox"][aria-label="Document suggestions"]');
async function suggestions(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(popup()?.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
  const found = popup();
  if (found === null) throw new Error("missing suggestions");
  return found;
}

describe("document-link IntelliSense", () => {
  it("ranks readable titles and shows disambiguating paths for [[query", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road");
    const menu = await suggestions();
    expect(menu.querySelector('[role="option"]')?.textContent).toBe("RoadmapProjects/Roadmap.md");
    expect(menu.textContent).toContain("Archive/Roadmap.md");
    expect(menu.textContent).not.toContain("Private");
  });

  it("loads only when triggered, once rather than on every keystroke", async () => {
    const load = vi.fn(async () => readable);
    const editor = await mount(load);
    editor.commands.insertContent("ordinary text");
    expect(load).not.toHaveBeenCalled();
    editor.commands.insertContent(" [[r");
    await suggestions();
    editor.commands.insertContent("o");
    editor.commands.insertContent("a");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard selection and writes a schema wikilink, not a second Markdown dialect", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road");
    await suggestions();
    key(editor, "ArrowDown");
    key(editor, "Enter");
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({ type: "wikilink", attrs: { target: "Archive/Roadmap", embed: false } });
    expect(popup()).toBeNull();
  });

  it("Escape dismisses until the trigger changes, without deleting typed text", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road");
    await suggestions();
    key(editor, "Escape");
    editor.view.dispatch(editor.state.tr);
    expect(popup()).toBeNull();
    expect(editor.state.doc.textContent).toBe("[[road");
  });

  it("pointer selection preserves an existing heading and alias", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road#Goals|The plan");
    const menu = await suggestions();
    menu.querySelector<HTMLElement>('[role="option"]')?.click();
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({ type: "wikilink", attrs: {
      target: "Projects/Roadmap", alias: "The plan", anchor_kind: "heading", anchor_text: "Goals",
    } });
  });

  it("replaces the complete unfinished link around the cursor without duplicating suffixes", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road#^pinned|Plan]] after");
    editor.commands.setTextSelection(7);
    await suggestions();
    key(editor, "Enter");
    expect(editor.getJSON().content?.[0]?.content).toMatchObject([
      { type: "wikilink", attrs: { target: "Projects/Roadmap", alias: "Plan", anchor_kind: "block", anchor_text: "pinned" } },
      { type: "text", text: " after" },
    ]);
  });

  it("supports links in level-one headings", async () => {
    const load = vi.fn(async () => readable);
    const editor = await mount(load);
    editor.commands.setContent({ type: "doc", content: [{ type: "heading", attrs: { level: 1 } }] });
    editor.commands.setTextSelection(1);
    editor.commands.insertContent("[[road");
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    expect((await suggestions()).textContent).toContain("Projects/Roadmap.md");
  });

  it.each(["scroll", "resize"])("closes on viewport %s and removes its listener on teardown", async (eventName) => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const editor = await mount();
    editor.commands.insertContent("[[road");
    await suggestions();
    const registrations = add.mock.calls.filter(([name]) => name === eventName);
    window.dispatchEvent(new Event(eventName));
    expect(popup()).toBeNull();
    expect(editor.view.dom.hasAttribute("aria-controls")).toBe(false);
    editor.destroy();
    expect(registrations.length).toBeGreaterThan(0);
    for (const [name, listener, options] of registrations) {
      expect(remove).toHaveBeenCalledWith(name, listener, options);
    }
  });

  it("does not suggest while editing code", async () => {
    const editor = await mount();
    editor.commands.setContent({ type: "doc", content: [{ type: "code_block", content: [{ type: "text", text: "[[road" }] }] });
    editor.commands.setTextSelection(7);
    expect(popup()).toBeNull();
  });

  it("captures a pane scroll but not scrolling the option list itself", async () => {
    const editor = await mount();
    editor.commands.insertContent("[[road");
    const menu = await suggestions();
    menu.dispatchEvent(new Event("scroll"));
    expect(popup()).toBe(menu);
    editor.view.dom.parentElement?.dispatchEvent(new Event("scroll"));
    expect(popup()).toBeNull();
  });

  it("handles visual-viewport keyboard resize and releases its listeners", async () => {
    const viewport = new EventTarget();
    const old = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const add = vi.spyOn(viewport, "addEventListener");
      const remove = vi.spyOn(viewport, "removeEventListener");
      const editor = await mount();
      editor.commands.insertContent("[[road");
      await suggestions();
      viewport.dispatchEvent(new Event("resize"));
      expect(popup()).toBeNull();
      for (const [name, listener, capture] of add.mock.calls) expect(remove).toHaveBeenCalledWith(name, listener, capture);
    } finally {
      if (old === undefined) Reflect.deleteProperty(window, "visualViewport");
      else Object.defineProperty(window, "visualViewport", old);
    }
  });

  it("renders untrusted catalog titles and paths as text, never HTML", async () => {
    const title = '<img src=x onerror="alert(1)">';
    const editor = await mount(async () => [{ path: `Public/${title}.md`, title }]);
    editor.commands.insertContent("[[");
    const menu = await suggestions();
    expect(menu.textContent).toContain(title);
    expect(menu.querySelector("img, script")).toBeNull();
  });

  it("a failed catalog load shows an inert error instead of stale results", async () => {
    const editor = await mount(async () => { throw new Error("denied"); });
    editor.commands.insertContent("[[road");
    await vi.waitFor(() => expect(popup()?.textContent).toBe("Documents unavailable."));
    key(editor, "Enter");
    expect(editor.getJSON().content?.some((node) => node.content?.some((child) => child.type === "wikilink"))).toBe(false);
  });

  it("late catalog responses cannot reopen a dismissed or destroyed editor", async () => {
    let complete: ((notes: typeof readable) => void) | undefined;
    const editor = await mount(() => new Promise((resolve) => { complete = resolve; }));
    editor.commands.insertContent("[[road");
    key(editor, "Escape");
    editor.destroy();
    complete?.(readable);
    await Promise.resolve();
    expect(popup()).toBeNull();
  });
});
