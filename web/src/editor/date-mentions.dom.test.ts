// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { undo, redo } from "y-prosemirror";
import { createMemberberryExtensions } from "./schema.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { dateMentions } from "./date-mentions.js";
import { memberberryInputRules } from "./commands.js";
import { markdownFromUpdate } from "../wasm/mb.js";
import { load } from "../notes.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const cleanups: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 19, 11, 20)); });
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers();
});

const paragraph = (text: string, marks?: object[]) => ({ type: "paragraph", content: text ? [{ type: "text", text, ...(marks ? { marks } : {}) }] : [] });
function open(content: object[] = [paragraph("")], editable = true, document?: Doc): Editor {
  const element = window.document.createElement("div"); window.document.body.append(element);
  const editor = new Editor({ element, editable, extensions: [
    ...createMemberberryExtensions(contract), memberberryInputRules, dateMentions,
    ...(document ? [createYjsBinding(document.getXmlFragment(PROSEMIRROR_ROOT))] : []),
  ] });
  editor.commands.setContent({ type: "doc", content });
  cleanups.push(() => editor.destroy());
  return editor;
}
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", handle => handle(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}
function key(editor: Editor, value: string, element: Element = editor.view.dom): boolean {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  element.dispatchEvent(event); return event.defaultPrevented;
}
function mention(editor: Editor, index = 0): HTMLButtonElement {
  const button = editor.view.dom.querySelectorAll<HTMLButtonElement>(".mb-date-mention")[index];
  if (!button) throw new Error(`missing date button ${index}`);
  return button;
}
function input(label: string): HTMLInputElement {
  const result = document.querySelector<HTMLInputElement>(`dialog input[aria-label="${label}"]`);
  if (!result) throw new Error(`missing input ${label}`);
  return result;
}
function save(): void { document.querySelector("dialog form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }

describe("date mentions in the real editor model", () => {
  it.each([["@now", "2026-10-19 11:20"], ["@today", "2026-10-19"], ["@yesterday", "2026-10-18"], ["@tomorrow", "2026-10-20"]])("confirms %s using Enter", (trigger, expected) => {
    const editor = open(); type(editor, trigger); key(editor, "Enter");
    expect(editor.getText()).toBe(expected);
    expect(document.querySelector(".mb-date-menu")).toBeNull();
  });
  it("confirms with Tab without inserting a tab", () => {
    const editor = open(); type(editor, "@TODAY"); key(editor, "Tab"); expect(editor.getText()).toBe("2026-10-19");
  });
  it("confirms exact keywords with Space and retains the separator", () => {
    const editor = open(); type(editor, "@today "); expect(editor.getText()).toBe("2026-10-19 ");
  });
  it("chooses partial matches with a pointer", () => {
    const editor = open(); type(editor, "@tom"); document.querySelector<HTMLButtonElement>(".mb-date-menu button")?.click();
    expect(editor.getText()).toBe("2026-10-20");
  });
  it("supports arrow selection without moving the editor caret", () => {
    const editor = open(); type(editor, "@"); key(editor, "ArrowDown"); key(editor, "Enter"); expect(editor.getText()).toBe("2026-10-19");
  });
  it("Escape dismisses suggestions without converting the literal trigger", () => {
    const editor = open(); type(editor, "@today"); key(editor, "Escape"); editor.commands.setTextSelection(7); key(editor, "Enter");
    expect(editor.getText().trim()).toBe("@today");
  });
  it.each(["person@today", "\\@today", "@todayish", "https://example/@today"])("keeps %s literal", text => {
    const editor = open(); type(editor, text + " "); expect(editor.getText()).toBe(text + " ");
  });
  it.each([
    [{ type: "code_block", content: [{ type: "text", text: "@today" }] }],
    [{ type: "math_block", content: [{ type: "text", text: "@today" }] }],
    [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "@today" }] }],
    [paragraph("@today", [{ type: "code" }])],
    [paragraph("@today", [{ type: "link", attrs: { href: "https://example.org" } }])],
  ])("does not complete literal/title contexts %#", block => {
    const editor = open([block]); editor.commands.setTextSelection(7); type(editor, " "); expect(editor.getText()).toBe("@today ");
    expect(document.querySelector(".mb-date-menu")).toBeNull();
  });
  it("renders existing dates as buttons with absolute hover details, keeping model text intact", () => {
    const editor = open([paragraph("2026-10-19 11:20")]);
    expect(mention(editor).textContent).toContain("@Today");
    expect(mention(editor).title).toContain("October 19, 2026"); expect(editor.getText()).toBe("2026-10-19 11:20");
  });
  it("does not decorate impossible dates, identifiers, timestamps, code, links, math or the title", () => {
    const editor = open([
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "2026-10-19" }] },
      paragraph("2026-02-29 abc2026-10-19 2026-10-19T11:20Z 2026-10-19 11:20+02:00 \\2026-10-19 2026-10-19 25:00"),
      paragraph("2026-10-19", [{ type: "code" }]), paragraph("2026-10-19", [{ type: "link", attrs: { href: "https://example.org" } }]),
      { type: "code_block", content: [{ type: "text", text: "2026-10-19" }] },
      { type: "math_block", content: [{ type: "text", text: "2026-10-19" }] },
    ]);
    expect(editor.view.dom.querySelector(".mb-date-mention")).toBeNull();
  });
  it("renders a date split by formatting as one mention", () => {
    const editor = open([{ type: "paragraph", content: [{ type: "text", text: "2026-" }, { type: "text", text: "10-19", marks: [{ type: "strong" }] }] }]);
    expect(editor.view.dom.querySelectorAll(".mb-date-mention")).toHaveLength(1);
  });
  it("removes relative presentation when code/link marks change without text changes", () => {
    const editor = open([paragraph("2026-10-19")]); editor.commands.setTextSelection({ from: 1, to: 11 });
    editor.commands.setMark("code"); expect(editor.view.dom.querySelector(".mb-date-mention")).toBeNull();
    editor.commands.unsetMark("code"); expect(mention(editor).textContent).toBe("@Today");
  });
  it("removes date decorations when the containing block becomes code", () => {
    const editor = open([paragraph("2026-10-19")]); editor.commands.setTextSelection(1); editor.commands.setNode("code_block");
    expect(editor.view.dom.querySelector(".mb-date-mention")).toBeNull();
  });
  it("refreshes labels across midnight without modifying the document or Yjs state", () => {
    const editor = open([paragraph("2026-10-19")]); const original = editor.state.doc;
    vi.setSystemTime(new Date(2026, 9, 20, 0, 0)); vi.advanceTimersByTime(60_000);
    expect(mention(editor).textContent).toBe("@Yesterday"); expect(editor.state.doc).toBe(original);
  });
  it("refreshes on return to the window", () => {
    const editor = open([paragraph("2026-10-19")]); vi.setSystemTime(new Date(2026, 9, 20));
    window.dispatchEvent(new Event("focus")); expect(mention(editor).textContent).toBe("@Yesterday");
  });
  it("edits date and time together and supports removing the time", () => {
    const editor = open([paragraph("2026-10-19")]); mention(editor).click();
    input("Date").value = "2026-10-20"; input("Include time").checked = true; input("Time").value = "14:30"; save();
    expect(editor.getText()).toBe("2026-10-20 14:30");
    mention(editor).click(); input("Include time").checked = false; save(); expect(editor.getText()).toBe("2026-10-20");
  });
  it("cancels a dialog without modifying the date", () => {
    const editor = open([paragraph("2026-10-19")]); mention(editor).click(); input("Date").value = "2027-01-01";
    document.querySelector<HTMLButtonElement>("dialog button[type=button]")?.click(); expect(editor.getText()).toBe("2026-10-19");
  });
  it("does not apply empty/invalid modal input", () => {
    const editor = open([paragraph("2026-10-19")]); mention(editor).click(); input("Date").value = ""; save();
    expect(editor.getText()).toBe("2026-10-19"); expect(document.querySelector("dialog [role=status]")?.textContent).toContain("valid");
  });
  it("invalidates a captured date when another local document edit arrives", () => {
    const editor = open([paragraph("2026-10-19")]); mention(editor).click();
    editor.commands.insertContentAt(1, "new "); expect(document.querySelector("dialog")).toBeNull();
    expect(editor.getText()).toBe("new 2026-10-19");
  });
  it("invalidates a captured date when another collaborator edits the note", () => {
    const document = new Doc(); const remote = new Doc();
    cleanups.unshift(() => { document.destroy(); remote.destroy(); });
    const editor = open([paragraph("2026-10-19")], true, document);
    applyUpdate(remote, encodeStateAsUpdate(document));
    const other = new Editor({ extensions: [...createMemberberryExtensions(contract), createYjsBinding(remote.getXmlFragment(PROSEMIRROR_ROOT))] });
    cleanups.push(() => other.destroy());
    mention(editor).click(); other.commands.insertContentAt(1, "remote "); applyUpdate(document, encodeStateAsUpdate(remote));
    expect(document.getXmlFragment(PROSEMIRROR_ROOT).toString()).toContain("remote ");
    expect(window.document.querySelector("dialog")).toBeNull();
    expect(editor.getText()).toBe("remote 2026-10-19");
  });
  it("invalidates the dialog when the editor becomes read-only", () => {
    const editor = open([paragraph("2026-10-19")]); mention(editor).click(); editor.setEditable(false);
    expect(document.querySelector("dialog")).toBeNull(); expect(editor.getText()).toBe("2026-10-19");
  });
  it("renders but does not edit dates in a read-only note", () => {
    const editor = open([paragraph("2026-10-19")], false); mention(editor).click(); expect(document.querySelector("dialog")).toBeNull();
  });
  it("closes date suggestions when editing permission is revoked", () => {
    const editor = open(); type(editor, "@today"); editor.setEditable(false); expect(document.querySelector(".mb-date-menu")).toBeNull();
  });
  it("keeps hidden source-mode editors out of mention completion", () => {
    const editor = open(); editor.view.dom.hidden = true; type(editor, "@today "); expect(editor.getText()).toBe("@today ");
  });
  it("maps date edit positions after earlier paragraphs change", () => {
    const editor = open([paragraph("hello"), paragraph("2026-10-19")]); editor.commands.insertContentAt(1, "prefix ");
    mention(editor).click(); input("Date").value = "2026-10-20"; save(); expect(editor.getText()).toBe("prefix hello\n\n2026-10-20");
  });
  it.each(["ArrowLeft", "Backspace"])("%s treats the hidden source as one date", value => {
    const editor = open([paragraph("2026-10-19")]); editor.commands.setTextSelection(11); key(editor, value);
    expect(value === "ArrowLeft" ? editor.state.selection.from : editor.getText()).toBe(value === "ArrowLeft" ? 1 : "");
  });
  it("opens the dialog from a keyboard-focused date", () => {
    const editor = open([paragraph("2026-10-19")]); key(editor, "Enter", mention(editor)); expect(document.querySelector("dialog")).not.toBeNull();
  });
  it("cleans up timers, global listeners, suggestions and dialogs on destroy", () => {
    const schedule = vi.spyOn(globalThis, "setTimeout"); const cancel = vi.spyOn(globalThis, "clearTimeout");
    const editor = open(); type(editor, "@today"); expect(document.querySelector(".mb-date-menu")).not.toBeNull();
    const timer = schedule.mock.results[schedule.mock.calls.findIndex(call => call[1] === 60_000)]?.value as unknown;
    editor.destroy(); expect(timer).toBeDefined(); expect(cancel).toHaveBeenCalledWith(timer); expect(document.querySelector(".mb-date-menu")).toBeNull();
    expect(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); }).not.toThrow();
    const other = open([paragraph("2026-10-19")]); mention(other).click(); other.destroy(); expect(document.querySelector("dialog")).toBeNull();
  });
  it("serializes mentions through the real Rust/WASM codec as ordinary ISO Markdown", () => {
    const document = new Doc(); cleanups.unshift(() => document.destroy());
    const editor = open([paragraph("")], true, document); type(editor, "@now"); key(editor, "Enter");
    expect(markdownFromUpdate(encodeStateAsUpdate(document))).toContain("2026-10-19 11:20");
    expect(markdownFromUpdate(encodeStateAsUpdate(document))).not.toContain("Today");
  });
  it("undoes and redoes date confirmation as a separate collaborative edit", () => {
    const document = new Doc(); cleanups.unshift(() => document.destroy());
    const editor = open([paragraph("")], true, document); type(editor, "@today"); key(editor, "Enter");
    undo(editor.state); expect(editor.getText()).toBe("@today"); redo(editor.state); expect(editor.getText()).toBe("2026-10-19");
  });
  it("undoes a modal edit without undoing the date's insertion", () => {
    const document = new Doc(); cleanups.unshift(() => document.destroy());
    const editor = open([paragraph("")], true, document); type(editor, "@today"); key(editor, "Enter");
    mention(editor).click(); input("Date").value = "2026-10-20"; save();
    undo(editor.state); expect(editor.getText()).toBe("2026-10-19"); redo(editor.state); expect(editor.getText()).toBe("2026-10-20");
  });
});
