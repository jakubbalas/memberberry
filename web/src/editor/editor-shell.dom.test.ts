// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { applyUpdate, Doc } from "yjs";
import { beforeAll, describe, expect, it } from "vitest";

import { load, updateFromMarkdown } from "../notes.js";
import { mountEditorShell } from "./editor-shell.js";
import { createMemberberryExtensions } from "./schema.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

beforeAll(async () => {
  const wasm = resolve(process.cwd(), "src/wasm/mb_bg.wasm");
  await load(readFileSync(wasm));
});

describe("editor shell", () => {
  it("mounts controls, drives source mode and removes listeners with the note", async () => {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel, status);
    const editor = new Editor({ element: surface, extensions: createMemberberryExtensions(contract) });
    const ydoc = new Doc();
    applyUpdate(ydoc, await updateFromMarkdown("# Initial\n\nText\n"));
    const shell = mountEditorShell({ editor, document: ydoc, panel, status });

    const source = panel.querySelector<HTMLTextAreaElement>(".source-view");
    const sourceButton = panel.querySelector<HTMLButtonElement>("[aria-label='Toggle Markdown source view']");
    if (source === null || sourceButton === null) throw new Error("source controls missing");
    sourceButton.click();
    await tick();
    expect(source.hidden).toBe(false);
    expect(source.value).toContain("Initial");
    source.value = "# Changed\n\nFrom source\n";
    sourceButton.click();
    await tick();
    expect(editor.getText()).toContain("Changed");

    panel.querySelector<HTMLButtonElement>("[aria-label='Insert task block']")?.click();
    expect(JSON.stringify(editor.getJSON())).toContain('"task_item"');
    editor.commands.insertContent("/task");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    expect(panel.querySelector<HTMLElement>(".slash-menu")?.hidden).toBe(false);

    const controls = panel.querySelector<HTMLElement>(".editor-controls");
    expect(controls).not.toBeNull();
    shell.destroy();
    expect(panel.querySelector(".editor-controls")).toBeNull();
    editor.destroy();
    ydoc.destroy();
    panel.remove();
    status.remove();
  });
});

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
