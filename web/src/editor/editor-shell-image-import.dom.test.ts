// @vitest-environment jsdom

/**
 * The image editor is its own chunk. When it cannot load — offline without it cached, or a
 * navigation cancelling the load — the editor goes without image editing, quietly: no
 * unhandled rejection, and no "Edit image" button that does nothing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { Doc } from "yjs";
import { afterEach, expect, it, vi } from "vitest";

import { mountEditorShell } from "./editor-shell.js";
import { createMemberberryExtensions } from "./schema.js";
import { tableRowHandles } from "./table-tools.js";

vi.mock("./image-editor.js", () => {
  throw new Error("the image editor chunk could not be loaded");
});

const contract = JSON.parse(readFileSync(resolve(process.cwd(), "../crates/mb-core/schema.json"), "utf8")) as unknown;

const rejections: unknown[] = [];
const record = (reason: unknown): void => {
  rejections.push(reason);
};
process.on("unhandledRejection", record);
afterEach(() => {
  rejections.length = 0;
});

it("leaves image editing out when its chunk cannot load", async () => {
  const panel = document.createElement("section");
  const surface = document.createElement("div");
  const status = document.createElement("p");
  panel.append(surface);
  document.body.append(panel);
  const ydoc = new Doc();
  const editor = new Editor({
    element: surface,
    extensions: [...createMemberberryExtensions(contract), tableRowHandles],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "media/ab/cd/x.png", alt: "x" } }] }],
    },
  });
  const shell = mountEditorShell({
    editor,
    document: ydoc,
    panel,
    status,
    media: { vault: "v" },
    mediaUploader: { upload: async () => ({ path: "unused" }), flush: async () => undefined, destroy: () => undefined },
  });
  try {
    // Let the failed import settle, and any unhandled rejection be reported.
    await new Promise((settled) => setTimeout(settled, 20));
    const image = surface.querySelector("img");
    if (image === null) throw new Error("the image did not render");
    image.click();
    const control = panel.querySelector<HTMLButtonElement>("[aria-label='Edit selected image']");
    expect(control?.hidden ?? true).toBe(true);
    expect(rejections).toEqual([]);
  } finally {
    shell.destroy();
    editor.destroy();
    ydoc.destroy();
    panel.remove();
  }
});
