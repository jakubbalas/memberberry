// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyUpdate, Doc } from "yjs";

import type { MermaidOutcome, MermaidRenderer } from "../mermaid/renderer.js";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { THEME_CHANGE_EVENT } from "../shell/theme.js";
import { createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { editGanttAt, isGanttSource, mermaidViews } from "./mermaid-view.js";
import { placeCursorBelowTitle } from "./note-editor.js";
import { createMemberberryExtensions } from "./schema.js";
import { editorMarkdown } from "./source.js";

const cleanups: (() => void)[] = [];
const layout = ["getClientRects", "getBoundingClientRect"] as const;
const originals = layout.map((name) => Object.getOwnPropertyDescriptor(Range.prototype, name));
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  // jsdom has no Range layout; scrollIntoView needs one. Supply only that browser boundary.
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
});
afterAll(() => {
  layout.forEach((name, at) => {
    const original = originals[at];
    if (original === undefined) Reflect.deleteProperty(Range.prototype, name);
    else Object.defineProperty(Range.prototype, name, original);
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const GANTT = "gantt\n    title Relaunch\n    dateFormat YYYY-MM-DD\n    Design :d, 2026-11-02, 5d";
const NOTE = `# Plan\n\nBefore\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n\n\`\`\`rust\nfn main() {}\n\`\`\`\n`;

interface Recorder extends MermaidRenderer { readonly calls: { source: string; theme: Readonly<Record<string, string>> }[] }

function recorder(answer: (source: string) => MermaidOutcome = (s) => ({
  kind: "ok", svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${s.split("\n").length}</text></svg>`,
})): Recorder {
  const calls: Recorder["calls"] = [];
  return { calls, render: (source, theme) => { calls.push({ source, theme }); return Promise.resolve(answer(source)); } };
}

async function open(markdown: string, options: { editable?: boolean; renderer?: Recorder; theme?: () => Record<string, string> } = {}) {
  const ydoc = new Doc();
  applyUpdate(ydoc, await updateFromMarkdown(markdown));
  const element = document.createElement("div");
  document.body.append(element);
  const renderer = options.renderer ?? recorder();
  const editor = new Editor({ element, editable: options.editable ?? true, extensions: [
    ...createMemberberryExtensions(await schema()),
    mermaidViews({ renderer, theme: options.theme ?? (() => ({ accent: "#6651a3" })), delayMs: 5 }),
    createYjsBinding(ydoc.getXmlFragment(PROSEMIRROR_ROOT)),
  ] });
  let destroyed = false;
  const destroy = () => { if (!destroyed) { destroyed = true; editor.destroy(); } };
  cleanups.push(() => { destroy(); ydoc.destroy(); element.remove(); });
  const block = () => editor.view.dom.querySelector<HTMLElement>(".mb-mermaid");
  const toggle = () => block()?.querySelector<HTMLButtonElement>(".mb-mermaid-toggle") ?? undefined;
  const mermaidStart = () => {
    let at = -1;
    editor.state.doc.descendants((node, pos) => { if (node.attrs["lang"] === "mermaid") at = pos; });
    return at;
  };
  return { editor, ydoc, renderer, block, toggle, mermaidStart, destroy };
}

const ready = async (f: Awaited<ReturnType<typeof open>>) => {
  await vi.waitFor(() => { expect(f.block()?.dataset["mermaidState"]).toBe("ready"); });
};

it("renders a mermaid block as a diagram and leaves other code blocks as code", async () => {
  const f = await open(NOTE);
  await ready(f);
  const pres = Array.from(f.editor.view.dom.querySelectorAll("pre"), (pre) => pre.closest(".mb-mermaid") === null);
  expect([f.block()?.querySelector(".mb-mermaid-preview svg") !== null, pres]).toEqual([true, [false, true]]);
});

it("renders the block's source with the theme from the tokens", async () => {
  const f = await open(NOTE);
  await ready(f);
  expect(f.renderer.calls[0]).toEqual({ source: GANTT, theme: { accent: "#6651a3" } });
});

it("leaves the Markdown exactly as written (C2)", async () => {
  const f = await open(NOTE);
  await ready(f);
  expect(await editorMarkdown(f.ydoc)).toBe(NOTE);
});

it("hides the source until it is edited, then shows it", async () => {
  const f = await open(NOTE);
  await ready(f);
  const hidden = f.block()?.classList.contains("mb-mermaid-source-open");
  f.toggle()?.click();
  expect([hidden, f.block()?.classList.contains("mb-mermaid-source-open"), f.toggle()?.textContent]).toEqual([false, true, "Done"]);
});

it("puts the caret inside the source when Edit code is pressed", async () => {
  const f = await open(NOTE);
  await ready(f);
  f.toggle()?.click();
  expect(f.editor.state.selection.$head.parent.attrs["lang"]).toBe("mermaid");
});

it("leaves the source with Done", async () => {
  const f = await open(NOTE);
  await ready(f);
  f.toggle()?.click();
  f.toggle()?.click();
  expect([f.editor.state.selection.$head.parent.textContent, f.block()?.classList.contains("mb-mermaid-source-open")])
    .toEqual(["After", false]);
});

it("hides the source again once the caret moves out of the diagram", async () => {
  const f = await open(NOTE);
  await ready(f);
  f.toggle()?.click();
  f.editor.commands.setTextSelection(3);
  expect(f.block()?.classList.contains("mb-mermaid-source-open")).toBe(false);
});

it("re-renders after typing pauses, once for a burst of edits", async () => {
  const f = await open(NOTE);
  await ready(f);
  const end = f.mermaidStart() + GANTT.length + 1;
  for (const text of ["\n", "    Build :b, after d, 3d"]) {
    f.editor.view.dispatch(f.editor.state.tr.insertText(text, end + (text === "\n" ? 0 : 1)));
  }
  await vi.waitFor(() => { expect(f.renderer.calls).toHaveLength(2); });
  expect(f.renderer.calls[1]?.source).toBe(`${GANTT}\n    Build :b, after d, 3d`);
});

it("shows a syntax error inline and reveals the source", async () => {
  const f = await open(NOTE, { renderer: recorder(() => ({ kind: "error", message: "Parse error on line 4" })) });
  await vi.waitFor(() => { expect(f.block()?.dataset["mermaidState"]).toBe("error"); });
  expect(f.block()?.querySelector(".mb-mermaid-error")?.textContent).toBe("Parse error on line 4");
});

it("does not ask the renderer to draw an empty diagram", async () => {
  const f = await open("# Plan\n\n```mermaid\n```\n");
  await vi.waitFor(() => { expect(f.block()?.dataset["mermaidState"]).toBe("error"); });
  expect(f.renderer.calls).toEqual([]);
});

it("re-renders with the new tokens when the theme changes", async () => {
  let accent = "#111111";
  const f = await open(NOTE, { theme: () => ({ accent }) });
  await ready(f);
  accent = "#222222";
  document.documentElement.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
  await vi.waitFor(() => { expect(f.renderer.calls.map((c) => c.theme["accent"])).toEqual(["#111111", "#222222"]); });
});

it("removes its theme listener when the editor is destroyed", async () => {
  const root = document.documentElement;
  const added = vi.spyOn(root, "addEventListener");
  const removed = vi.spyOn(root, "removeEventListener");
  const f = await open(NOTE);
  await ready(f);
  f.destroy();
  const listeners = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === THEME_CHANGE_EVENT).map(([, fn]) => fn);
  expect([listeners(added).length, listeners(removed)]).toEqual([1, listeners(added)]);
});

it("cancels a pending re-render when the editor is destroyed", async () => {
  const f = await open(NOTE);
  await ready(f);
  // why: identify this view's debounce by its delay (5 ms here); the editor keeps timers of its own.
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  f.editor.view.dispatch(f.editor.state.tr.insertText("x", f.mermaidStart() + 2));
  const debounce = scheduled.mock.results.filter((_, at) => scheduled.mock.calls[at]?.[1] === 5).map((r) => r.value as unknown);
  f.destroy();
  expect([debounce.length, debounce.every((id) => cleared.mock.calls.some(([arg]) => arg === id))]).toEqual([1, true]);
});

it("waits until the diagram scrolls into view, and stops observing after", async () => {
  const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    readonly entry: { callback: IntersectionObserverCallback; disconnected: boolean };
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, disconnected: false }; observers.push(this.entry); }
    observe(): void { /* driven by the test */ }
    disconnect(): void { this.entry.disconnected = true; }
  });
  const f = await open(NOTE);
  const before = f.renderer.calls.length;
  const observer = observers[0];
  observer?.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await ready(f);
  expect([before, f.renderer.calls.length, observer?.disconnected]).toEqual([0, 1, true]);
});

it("offers Show code on a read-only note without moving the selection", async () => {
  const f = await open(NOTE, { editable: false });
  await ready(f);
  const label = f.toggle()?.textContent;
  f.toggle()?.click();
  expect([label, f.toggle()?.textContent, f.block()?.classList.contains("mb-mermaid-source-open")])
    .toEqual(["Show code", "Hide code", true]);
});

it("turns back into an ordinary code block when the language changes", async () => {
  const f = await open(NOTE);
  await ready(f);
  const pos = f.mermaidStart();
  f.editor.view.dispatch(f.editor.state.tr.setNodeAttribute(pos, "lang", "text"));
  expect(f.editor.view.dom.querySelector(".mb-mermaid")).toBeNull();
});

it("becomes a diagram when a code block's language changes to mermaid", async () => {
  const f = await open("# Plan\n\n```text\ngantt\n```\n");
  let pos = -1;
  f.editor.state.doc.descendants((node, at) => { if (node.type.name === "code_block") pos = at; });
  f.editor.view.dispatch(f.editor.state.tr.setNodeAttribute(pos, "lang", "mermaid"));
  await ready(f);
  expect(f.renderer.calls.map((c) => c.source)).toEqual(["gantt"]);
});

it("moves the caret into an adjacent hidden diagram with the arrow keys", async () => {
  const f = await open(NOTE);
  await ready(f);
  // why: jsdom has no layout, so endOfTextblock cannot measure; the browser spec covers it
  // for real. Here it is pinned so the decision about *where* the caret goes is tested.
  vi.spyOn(f.editor.view, "endOfTextblock").mockReturnValue(true);
  let before = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.textContent === "Before") before = pos + 1; });
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, before)));
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  const down = f.editor.state.selection.$head.parent.attrs["lang"];
  let after = -1;
  f.editor.state.doc.descendants((node, pos) => { if (node.textContent === "After") after = pos + 1; });
  f.editor.view.dispatch(f.editor.state.tr.setSelection(TextSelection.create(f.editor.state.doc, after)));
  f.editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  expect([down, f.editor.state.selection.$head.parent.attrs["lang"]]).toEqual(["mermaid", "mermaid"]);
});

it("offers Edit chart only for a Gantt chart in an editable note", async () => {
  const editable = await open(NOTE);
  await ready(editable);
  const shown = editable.block()?.querySelector<HTMLButtonElement>(".mb-mermaid-chart")?.hidden;
  editable.destroy();
  const readOnly = await open(NOTE, { editable: false });
  await ready(readOnly);
  const readOnlyHidden = readOnly.block()?.querySelector<HTMLButtonElement>(".mb-mermaid-chart")?.hidden;
  readOnly.destroy();
  const flow = await open("```mermaid\nflowchart LR\n  A --> B\n```\n");
  await ready(flow);
  expect([shown, readOnlyHidden, flow.block()?.querySelector<HTMLButtonElement>(".mb-mermaid-chart")?.hidden]).toEqual([false, true, true]);
});

it("recognises a Gantt source past blank lines and comments", () => {
  expect([isGanttSource("\n%% plan\n  gantt\n"), isGanttSource("flowchart LR"), isGanttSource("")]).toEqual([true, false, false]);
});

it("saves the visual editor's chart into the same block after text above it changed", async () => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };
  const f = await open(NOTE);
  await ready(f);
  await editGanttAt(f.editor.view, f.mermaidStart());
  const dialog = document.querySelector<HTMLDialogElement>("dialog.gantt-editor");
  // A collaborator's edit above the chart moves its position while the dialog is open.
  f.editor.view.dispatch(f.editor.state.tr.insertText("Earlier ", 1));
  const title = dialog?.querySelector<HTMLInputElement>('[aria-label="Chart title"]');
  if (title === null || title === undefined) throw new Error("no dialog");
  title.value = "Roadmap";
  title.dispatchEvent(new Event("change", { bubbles: true }));
  [...(dialog?.querySelectorAll("button") ?? [])].find((node) => node.textContent === "Save")?.click();
  expect(await editorMarkdown(f.ydoc)).toContain("# Earlier Plan\n\nBefore\n\n```mermaid\ngantt\n    title Roadmap\n");
});

it("leaves the code hidden when the diagram is clicked; only Edit code opens it", async () => {
  const f = await open(NOTE);
  await ready(f);
  const preview = f.block()?.querySelector<HTMLElement>(".mb-mermaid-preview");
  for (const type of ["mousedown", "mouseup", "click"]) preview?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  const afterClick = f.block()?.classList.contains("mb-mermaid-source-open");
  f.toggle()?.click();
  expect([afterClick, f.toggle()?.textContent, f.block()?.classList.contains("mb-mermaid-source-open")]).toEqual([false, "Done", true]);
});

it.each([
  ["the last block of a note", `# Plan\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n`],
  ["the only block of a note", `\`\`\`mermaid\n${GANTT}\n\`\`\`\n`],
])("hides the code again with Done when the diagram is %s", async (_where, markdown) => {
  const f = await open(markdown);
  await ready(f);
  // A note that is only a diagram starts with the caret, and so its code, inside it.
  if (f.toggle()?.textContent === "Done") f.toggle()?.click();
  f.toggle()?.click();
  const opened = f.block()?.classList.contains("mb-mermaid-source-open");
  f.toggle()?.click();
  expect([opened, f.block()?.classList.contains("mb-mermaid-source-open"), f.toggle()?.textContent]).toEqual([true, false, "Edit code"]);
});


it("opens a note that starts with a diagram with its code hidden", async () => {
  const f = await open(`\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`);
  await ready(f);
  expect([f.block()?.classList.contains("mb-mermaid-source-open"), f.editor.state.selection.$head.parent.textContent]).toEqual([false, "After"]);
});

it("places the opening caret below the title but outside a diagram there", async () => {
  const f = await open(`# Plan\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`);
  await ready(f);
  placeCursorBelowTitle(f.editor);
  expect([f.block()?.classList.contains("mb-mermaid-source-open"), f.editor.state.selection.$head.parent.textContent]).toEqual([false, "After"]);
});

it("still lets Edit code put the caret in the code of a diagram that starts the note", async () => {
  const f = await open(`\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`);
  await ready(f);
  f.toggle()?.click();
  expect([f.block()?.classList.contains("mb-mermaid-source-open"), f.editor.state.selection.$head.parent.attrs["lang"]]).toEqual([true, "mermaid"]);
});

it("leaves the caret in a note that is only a diagram, rather than edit the note to move it", async () => {
  const f = await open(`\`\`\`mermaid\n${GANTT}\n\`\`\`\n`);
  await ready(f);
  expect([f.editor.state.doc.childCount, f.editor.state.selection.$head.parent.attrs["lang"]]).toEqual([1, "mermaid"]);
});

describe("double-clicking a diagram", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) { this.open = true; };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) { this.open = false; };
  });
  afterEach(() => { for (const dialog of document.querySelectorAll("dialog.gantt-editor")) dialog.remove(); });
  const doubleClick = (node: Element | null | undefined) => node?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const dialog = () => document.querySelector("dialog.gantt-editor");

  it("opens the visual editor on a Gantt chart", async () => {
    const f = await open(NOTE);
    await ready(f);
    doubleClick(f.block()?.querySelector(".mb-mermaid-preview"));
    await vi.waitFor(() => { expect(dialog()).not.toBeNull(); });
    expect(f.block()?.classList.contains("mb-mermaid-source-open")).toBe(false);
  });

  it("does nothing on a diagram that is not a Gantt chart", async () => {
    const f = await open("Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");
    await ready(f);
    doubleClick(f.block()?.querySelector(".mb-mermaid-preview"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([dialog(), f.block()?.classList.contains("mb-mermaid-source-open")]).toEqual([null, false]);
  });

  it("does nothing in a read-only note", async () => {
    const f = await open(NOTE, { editable: false });
    await ready(f);
    doubleClick(f.block()?.querySelector(".mb-mermaid-preview"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dialog()).toBeNull();
  });
});

it("colours a Gantt chart's task bars from its colour lines", async () => {
  const renderer = recorder((source) => ({
    kind: "ok",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" id="m1"><rect id="m1-d" class="task"></rect><rect id="m1-x" class="task"></rect><text>${source.length}</text></svg>`,
  }));
  const f = await open(NOTE.replace("    Design :d, 2026-11-02, 5d", "    %% color d green\n    %% color x #3a7bd5\n    %% color nope red\n    Design :d, 2026-11-02, 5d"), { renderer });
  await ready(f);
  const bars = [...(f.block()?.querySelectorAll<SVGElement>(".mb-mermaid-preview rect") ?? [])].map((bar) => [bar.id, bar.style.fill, bar.style.stroke]);
  expect(bars[0]).toEqual(["m1-d", "var(--note-background-green)", "var(--note-color-green)"]);
  expect([bars[1]?.[0], /#3a7bd5|rgb\(58, 123, 213\)/u.test(bars[1]?.[2] ?? "")]).toEqual(["m1-x", true]);
});
