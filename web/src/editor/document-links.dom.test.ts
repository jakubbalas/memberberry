// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNoteEditor, type NoteEditor } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "./links.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const sessions: NoteEditor[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.destroy()));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mount(href?: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const session = await startNoteEditor({
    vaultId: "personal", noteId: "Projects/Source.md", element,
    createPersistence: () => ({ whenSynced: Promise.resolve(), destroy: async () => undefined }),
    loadExtensions: async () => createMemberberryExtensions(contract), loadEmojiCatalog: async () => [],
  });
  sessions.push(session);
  if (!(session.editor instanceof Editor)) throw new Error("missing editor");
  const editor = session.editor;
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: href === undefined
    ? [{ type: "wikilink", attrs: { target: "Roadmap", anchor_kind: "heading", anchor_text: "Goals", alias: "Plan" } }]
    : [{ type: "text", text: "Follow", marks: [{ type: "link", attrs: { href } }] }] }] });
  const events: OpenNoteDetail[] = [];
  element.addEventListener(OPEN_NOTE_EVENT, (event) => {
    if (event instanceof CustomEvent) events.push(event.detail as OpenNoteDetail);
  });
  const link = element.querySelector<HTMLElement>("a, [data-wikilink]");
  if (link === null) throw new Error("missing link");
  return { editor, element, link, events };
}

describe("document link activation", () => {
  it("opens safe external Markdown links from an editable document", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { link } = await mount("https://example.com/guide#part");
    link.click();
    expect(open).toHaveBeenCalledWith("https://example.com/guide#part", "_blank", "noopener,noreferrer");
  });

  it.each([
    ["Roadmap.md#Goals", "Roadmap.md", "heading", "Goals"],
    ["./Roadmap.md#%5Epinned", "Projects/Roadmap.md", "block", "pinned"],
    ["../Archive/Old%20plan.md#Next%20steps", "Archive/Old plan.md", "heading", "Next steps"],
    ["#Goals", "Projects/Source.md", "heading", "Goals"],
  ])("routes %s through the authorized resolver with its anchor", async (href, target, anchorKind, anchor) => {
    const { link, events } = await mount(href);
    link.click();
    expect(events).toEqual([{ target, anchorKind, anchor, intent: "here", resolved: false, from: "Projects/Source.md" }]);
  });

  it.each([
    [{}, "here"], [{ ctrlKey: true }, "tab"], [{ metaKey: true, altKey: true }, "split"],
  ])("preserves Markdown link navigation intent %j", async (modifiers, intent) => {
    const { link, events } = await mount("Roadmap.md");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }));
    expect(events[0]?.intent).toBe(intent);
  });

  it("activates wikilinks without requiring embed/server configuration", async () => {
    const { link, events } = await mount();
    link.click();
    expect(events).toEqual([{ target: "Roadmap", anchorKind: "heading", anchor: "Goals", intent: "here", resolved: false, from: "Projects/Source.md" }]);
  });

  it("lets keyboard users activate a focused wikilink", async () => {
    const { link, events } = await mount();
    expect(link.getAttribute("tabindex")).toBe("0");
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(events).toHaveLength(1);
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:bad", "file:///etc/passwd", "//evil.example/path", "\\\\evil.example/path"])("never activates unsafe destination %s", async (href) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { link, events } = await mount(href);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect({ opened: open.mock.calls, events, prevented: event.defaultPrevented, href: link.getAttribute("href") })
      .toEqual({ opened: [], events: [], prevented: true, href: null });
  });

  it("removes activation handlers with the editor", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { editor, link } = await mount("https://example.com");
    editor.destroy();
    link.removeAttribute("href");
    link.click();
    expect(open).not.toHaveBeenCalled();
  });
});
