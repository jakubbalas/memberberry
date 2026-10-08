// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor } from "@tiptap/core";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { Awareness } from "y-protocols/awareness";
import { beforeAll, expect, it } from "vitest";
import { load, updateFromMarkdown } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { tableRowHandles } from "./table-tools.js";
import { createConnectionStatus, createYjsBinding, PROSEMIRROR_ROOT } from "./collaboration.js";
import { connectionMessage, mountEditorShell } from "./editor-shell.js";
const contract: unknown = JSON.parse(readFileSync(resolve(process.cwd(), "../crates/mb-core/schema.json"), "utf8"));
beforeAll(async () => { await load(readFileSync(resolve(process.cwd(), "src/wasm/mb_bg.wasm"))); });
for (const connected of [false, true]) for (const pending of [0, 1, 7]) {
  it(`prioritizes terminal refresh over connected=${connected}, pending=${pending}`, () => {
    const message = connectionMessage({ connected, pending, synced: false, refreshRequired: true });
    expect(message).toMatch(/refresh required/i);
    expect(message).not.toMatch(/offline|reconnected|sending/i);
    if (pending > 0) expect(message).toContain(`${pending} unsent ${pending === 1 ? "change" : "changes"}`);
  });
}
it("announces terminal refusal accessibly, refuses Source apply and retains exact draft/model", async () => {
  const panel = document.createElement("section"), surface = document.createElement("div"), status = document.createElement("p");
  panel.append(surface); document.body.append(panel, status);
  const doc = new Doc(); applyUpdate(doc, await updateFromMarkdown("# Title\n\nBody\n"));
  const awareness = new Awareness(doc), connection = createConnectionStatus();
  connection.set({ connected: true, pending: 0, synced: true });
  const editor = new Editor({ element: surface, extensions: [...createMemberberryExtensions(contract), tableRowHandles, createYjsBinding(doc.getXmlFragment(PROSEMIRROR_ROOT))] });
  const shell = mountEditorShell({ panel, editor, document: doc, status, awareness, connection });
  try {
    const toggle = panel.querySelector<HTMLButtonElement>("[aria-label='Toggle Markdown source view']");
    const source = panel.querySelector<HTMLTextAreaElement>(".source-view");
    if (!toggle || !source) throw Error("Source controls absent");
    toggle.click(); await Promise.resolve(); await Promise.resolve();
    await expect.poll(() => source.hidden).toBe(false);
    const draft = "  \n# Title\n\n independent draft  \n\tkeep whitespace\n";
    source.value = draft; source.dispatchEvent(new Event("input", { bubbles: true }));
    const y = encodeStateAsUpdate(doc), pm = editor.getJSON();
    connection.set({ connected: false, pending: 1, synced: false, refreshRequired: true });
    expect(panel.querySelector(".connection-status")?.getAttribute("role")).toBe("status");
    expect(panel.querySelector<HTMLElement>(".connection-status")?.dataset["state"]).toBe("refresh-required");
    expect(panel.textContent).toMatch(/refresh required/i);
    expect(toggle.disabled).toBe(true);
    const reload = panel.querySelector<HTMLButtonElement>("[aria-label='Reload editor']");
    expect(reload).not.toBeNull(); expect(reload?.disabled).toBe(true);
    // Retained public DOM handler: presentation cannot be the only preflight.
    toggle.disabled = false; toggle.click(); await Promise.resolve(); await Promise.resolve();
    expect(source.value).toBe(draft); expect(source.hidden).toBe(false);
    expect(encodeStateAsUpdate(doc)).toEqual(y); expect(editor.getJSON()).toEqual(pm);
    shell.destroy(); shell.destroy(); connection.set({ connected: true, pending: 0, synced: true });
    expect(panel.querySelector(".connection-status")).toBeNull(); expect(panel.querySelector("[aria-label='Reload editor']")).toBeNull();
  } finally { shell.destroy(); editor.destroy(); awareness.destroy(); doc.destroy(); panel.remove(); status.remove(); }
});

it("retains independent link destination through terminal refusal and focus departure", async () => {
  const panel = document.createElement("section"), surface = document.createElement("div"), status = document.createElement("p");
  panel.append(surface); document.body.append(panel, status);
  const doc = new Doc(); applyUpdate(doc, await updateFromMarkdown('# Title\n\n[Body](https://example.org "")\n'));
  const awareness = new Awareness(doc), connection = createConnectionStatus();
  connection.set({ connected: true, pending: 0, synced: true });
  const editor = new Editor({ element: surface, extensions: [...createMemberberryExtensions(contract), tableRowHandles, createYjsBinding(doc.getXmlFragment(PROSEMIRROR_ROOT))] });
  const shell = mountEditorShell({ panel, editor, document: doc, status, awareness, connection });
  try {
    editor.commands.setTextSelection({ from: 8, to: 12 });
    document.querySelector<HTMLButtonElement>(".selection-menu [aria-label='Link']")?.click();
    const dest = document.querySelector<HTMLInputElement>("[aria-label='Link destination']");
    if (!dest) throw Error("Actual destination input absent");
    expect(dest.closest<HTMLFormElement>("form")?.hidden).toBe(false);
    const draft = "  https://example.net/independent?x=1  "; dest.value = draft; dest.dispatchEvent(new Event("input", { bubbles: true }));
    const before = encodeStateAsUpdate(doc), pm = editor.getJSON();
    connection.set({ connected: false, pending: 0, synced: false, refreshRequired: true });
    const apply = document.querySelector<HTMLButtonElement>("[aria-label='Apply link']");
    expect(apply?.disabled).toBe(true);
    expect(panel.querySelector<HTMLButtonElement>("[aria-label='Reload editor']")?.disabled).toBe(true);
    // Public submit handler remains safe even when a caller retains the form.
    dest.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    panel.querySelector<HTMLButtonElement>("[aria-label='Reload editor']")?.focus();
    document.dispatchEvent(new Event("selectionchange"));
    expect(dest.value).toBe(draft); expect(dest.closest<HTMLFormElement>("form")?.hidden).toBe(false);
    expect(encodeStateAsUpdate(doc)).toEqual(before); expect(editor.getJSON()).toEqual(pm);
    expect(editor.getJSON().content?.[1]?.content?.[0]?.marks?.find(m => m.type === "link")?.attrs?.["title"]).toBe("");
  } finally { shell.destroy(); editor.destroy(); awareness.destroy(); doc.destroy(); panel.remove(); status.remove(); }
});

it("preserves Source when terminal refusal arrives during its async Apply preflight", async () => {
  const panel = document.createElement("section"), surface = document.createElement("div"), status = document.createElement("p");
  panel.append(surface); document.body.append(panel, status);
  const doc = new Doc(); applyUpdate(doc, await updateFromMarkdown("# Title\n\nBody\n"));
  const awareness = new Awareness(doc), connection = createConnectionStatus();
  connection.set({ connected: true, pending: 0, synced: true });
  const editor = new Editor({ element: surface, extensions: [...createMemberberryExtensions(contract), tableRowHandles, createYjsBinding(doc.getXmlFragment(PROSEMIRROR_ROOT))] });
  const shell = mountEditorShell({ panel, editor, document: doc, status, awareness, connection });
  try {
    const toggle = panel.querySelector<HTMLButtonElement>("[aria-label='Toggle Markdown source view']");
    const source = panel.querySelector<HTMLTextAreaElement>(".source-view");
    if (!toggle || !source) throw Error("Source controls absent");
    toggle.click(); await Promise.resolve(); await Promise.resolve();
    await expect.poll(() => source.hidden).toBe(false);
    const draft = "  \n# Title\n\n independent draft  \n\tkeep whitespace\n";
    source.value = draft; source.dispatchEvent(new Event("input", { bubbles: true }));
    const y = encodeStateAsUpdate(doc), pm = editor.getJSON();
    toggle.click();
    connection.set({ connected: false, pending: 1, synced: false, refreshRequired: true });
    await Promise.resolve(); await Promise.resolve();
    expect(panel.querySelector(".connection-status")?.getAttribute("role")).toBe("status");
    expect(panel.querySelector<HTMLElement>(".connection-status")?.dataset["state"]).toBe("refresh-required");
    expect(panel.textContent).toMatch(/refresh required/i);
    expect(toggle.disabled).toBe(true);
    const reload = panel.querySelector<HTMLButtonElement>("[aria-label='Reload editor']");
    expect(reload).not.toBeNull(); expect(reload?.disabled).toBe(true);
    // Retained public DOM handler: presentation cannot be the only preflight.
    await Promise.resolve(); await Promise.resolve();
    expect(source.value).toBe(draft); expect(source.hidden).toBe(false);
    expect(encodeStateAsUpdate(doc)).toEqual(y); expect(editor.getJSON()).toEqual(pm);
    shell.destroy(); shell.destroy(); connection.set({ connected: true, pending: 0, synced: true });
    expect(panel.querySelector(".connection-status")).toBeNull(); expect(panel.querySelector("[aria-label='Reload editor']")).toBeNull();
  } finally { shell.destroy(); editor.destroy(); awareness.destroy(); doc.destroy(); panel.remove(); status.remove(); }
});
