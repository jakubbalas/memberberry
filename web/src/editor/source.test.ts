// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { applyUpdate, Doc } from "yjs";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { load, updateFromMarkdown } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { applySourceMarkdown, copyMarkdown, editorMarkdown, longNoteMode, setLongNoteMode } from "./source.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

beforeAll(async () => {
  const wasm = resolve(process.cwd(), "src/wasm/mb_bg.wasm");
  await load(readFileSync(wasm));
});

describe("source view bridge", () => {
  it("materializes a Yjs document through the WASM serializer", async () => {
    const update = await updateFromMarkdown("# Source\n\nText\n");
    const document = new Doc();
    applyUpdate(document, update);

    await expect(editorMarkdown(document)).resolves.toBe("# Source\n\nText\n");
    document.destroy();
  });

  it("reports unavailable clipboard access and writes through an injected clipboard", async () => {
    await expect(copyMarkdown("text", undefined)).resolves.toBe(false);
    const writeText = vi.fn(async () => undefined);
    await expect(copyMarkdown("text", { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("text");
  });

  it("applies source text through WASM and enables the long-note rendering policy", async () => {
    const element = document.createElement("div");
    const view = new Editor({ element, extensions: createMemberberryExtensions(contract) });
    await applySourceMarkdown(view, "# Replaced\n\nText\n");

    expect(view.getText()).toContain("Replaced");
    expect(longNoteMode(view, 1)).toBe(true);
    setLongNoteMode(element, true);
    expect(element.classList.contains("is-long-note")).toBe(true);
    view.destroy();
  });
});
