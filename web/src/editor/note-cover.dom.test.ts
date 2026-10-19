// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { Doc, applyUpdate } from "yjs";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import fc from "fast-check";
import { load, updateFromMarkdown } from "../notes.js";
import { editorMarkdown } from "./source.js";
import { createMemberberryExtensions } from "./schema.js";
import { mountNoteCover } from "./note-cover.js";
import type { MediaUploadResult } from "./media-upload.js";

const path = `media/aa/aa/${"a".repeat(64)}.png`;
const replacement = `media/bb/bb/${"b".repeat(64)}.webp`;
const cleanups: Array<() => void> = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(upload = vi.fn<() => Promise<MediaUploadResult>>().mockResolvedValue({ path })) {
  const panel = document.createElement("section");
  const surface = document.createElement("div"); surface.className = "editor-surface";
  panel.append(surface); document.body.append(panel);
  const status = document.createElement("p");
  const documentModel = new Doc();
  applyUpdate(documentModel, await updateFromMarkdown("# A note\n\nBody\n"));
  const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
  const editor = new Editor({ element: surface, extensions: createMemberberryExtensions(contract) });
  let allowed = true;
  const cover = mountNoteCover({ editor, panel, document: documentModel, status, vault: "my vault",
    uploader: { upload, flush: async () => undefined, destroy: () => undefined }, canEdit: () => allowed });
  const metadata = documentModel.getMap("frontmatter");
  const picker = panel.querySelector<HTMLInputElement>('input[type="file"]');
  const image = panel.querySelector("img");
  const position = panel.querySelector<HTMLInputElement>('input[type="range"]');
  const remove = [...panel.querySelectorAll("button")].find(button => button.textContent === "Remove cover");
  if (!picker || !image || !position || !remove) throw new Error("missing cover controls");
  const choose = (type = "image/png"): void => {
    Object.defineProperty(picker, "files", { configurable: true, value: [new File(["bytes"], "picture.png", { type })] });
    picker.dispatchEvent(new Event("change"));
  };
  cleanups.push(() => { cover.destroy(); editor.destroy(); documentModel.destroy(); panel.remove(); });
  return { panel, editor, documentModel, metadata, status, cover, picker, image, position, remove, choose, upload,
    forbid: () => { allowed = false; cover.refresh(); } };
}

it("saves the uploaded cover and crop as plain Markdown without changing note content", async () => {
  const state = await fixture(); state.choose();
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(path));
  state.position.value = "27"; state.position.dispatchEvent(new Event("input"));
  const markdown = await editorMarkdown(state.documentModel);
  expect(markdown).toContain(`cover: ${path}`);
  expect(markdown).toMatch(/cover_position: ["']?27/);
  expect(markdown).toContain("# A note\n\nBody");
  expect(state.image.src).toContain("/api/v1/vaults/my%20vault/media/media/");
  expect(state.image.style.objectPosition).toBe("50% 27%");
});

it("removes cover metadata without removing the note body", async () => {
  const state = await fixture(); state.metadata.set("cover", path); state.metadata.set("cover_position", "12");
  state.remove.click();
  expect(await editorMarkdown(state.documentModel)).toBe("# A note\n\nBody\n");
  expect(state.image.hasAttribute("src")).toBe(false);
});

it("collapses existing cover controls behind an accessible edit button", async () => {
  const state = await fixture(); state.metadata.set("cover", path);
  const menu = state.panel.querySelector("details");
  const toggle = state.panel.querySelector("summary");
  expect(menu?.open).toBe(false);
  expect(toggle?.textContent).toBe("Edit cover");
  if (!menu || !toggle) throw new Error("missing cover menu");
  toggle.click();
  expect(menu.open).toBe(true);
  state.position.value = "25"; state.position.dispatchEvent(new Event("input"));
  expect(menu.open).toBe(true);
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(toggle);
});

it("keeps Add cover available when there is no cover", async () => {
  const state = await fixture();
  expect(state.panel.querySelector("details")?.open).toBe(false);
  expect(state.panel.querySelector("summary")?.getAttribute("aria-label")).toBe("Add cover");
});

it("closes Add cover with Escape when clicking the trigger leaves focus outside the menu", async () => {
  const state = await fixture();
  const menu = state.panel.querySelector("details");
  const toggle = state.panel.querySelector("summary");
  if (!menu || !toggle) throw new Error("missing cover menu");
  toggle.click();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(toggle);
});

it.each(["empty", "covered"])("dismisses the %s cover menu on an outside pointer without consuming the click", async kind => {
  const state = await fixture();
  if (kind === "covered") state.metadata.set("cover", path);
  const menu = state.panel.querySelector("details");
  const toggle = state.panel.querySelector("summary");
  if (!menu || !toggle) throw new Error("missing cover menu");
  toggle.click();
  state.editor.view.dom.focus();
  const outside = new Event("pointerdown", { bubbles: true, cancelable: true });
  state.editor.view.dom.dispatchEvent(outside);
  expect(menu.open).toBe(false);
  expect(outside.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(state.editor.view.dom);
});

it("keeps the cover menu open for pointers inside its actions", async () => {
  const state = await fixture();
  const menu = state.panel.querySelector("details");
  if (!menu) throw new Error("missing cover menu");
  menu.open = true;
  state.panel.querySelector(".note-cover-hint")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(menu.open).toBe(true);
});

it("removes outside-pointer handling when the note closes", async () => {
  const state = await fixture();
  const menu = state.panel.querySelector("details");
  if (!menu) throw new Error("missing cover menu");
  state.cover.destroy();
  menu.open = true;
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  expect(menu.open).toBe(true);
});

function clipboard(read: () => Promise<readonly { types: readonly string[]; getType(type: string): Promise<Blob> }[]>): void {
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { read } });
  cleanups.push(() => {
    if (previous === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", previous);
  });
}

function transferEvent(type: string, files: readonly File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const transfer = { files, items: files.map(file => ({ kind: "file", type: file.type })), dropEffect: "none" };
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", { value: transfer });
  return event;
}

it("opens file and clipboard choices from the empty hover target", async () => {
  const state = await fixture(); const toggle = state.panel.querySelector("summary");
  toggle?.click();
  expect(state.panel.querySelector("details")?.open).toBe(true);
  expect(state.panel.textContent).toContain("Choose from files");
  expect(state.panel.textContent).toContain("Paste from clipboard");
});

it("uploads an image read from the clipboard", async () => {
  clipboard(async () => [{ types: ["text/plain", "image/png"], getType: async () => new Blob(["png"], { type: "image/png" }) }]);
  const state = await fixture();
  [...state.panel.querySelectorAll("button")].find(button => button.textContent === "Paste from clipboard")?.click();
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(path));
});

it.each(["denied", "empty", "unavailable"])("offers a paste shortcut or helpful feedback when clipboard is %s", async failure => {
  clipboard(async () => {
    if (failure === "denied") throw new DOMException("Not allowed", "NotAllowedError");
    return [];
  });
  if (failure === "unavailable") Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const state = await fixture();
  [...state.panel.querySelectorAll("button")].find(button => button.textContent === "Paste from clipboard")?.click();
  await vi.waitFor(() => expect(state.status.textContent).toMatch(failure === "empty" ? /Copy an image/ : /paste shortcut/));
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.cover.hasPending()).toBe(false);
});

it.each(["synced", "forbidden", "destroyed"])("refuses clipboard data after its destination is %s", async change => {
  let complete: ((value: readonly { types: readonly string[]; getType(type: string): Promise<Blob> }[]) => void) | undefined;
  const pending = new Promise<readonly { types: readonly string[]; getType(type: string): Promise<Blob> }[]>(resolve => { complete = resolve; });
  clipboard(() => pending);
  const state = await fixture();
  [...state.panel.querySelectorAll("button")].find(button => button.textContent === "Paste from clipboard")?.click();
  if (change === "synced") state.metadata.set("cover", replacement);
  if (change === "forbidden") state.forbid();
  if (change === "destroyed") state.cover.destroy();
  complete?.([{ types: ["image/png"], getType: async () => new Blob(["image"], { type: "image/png" }) }]);
  await pending; await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(state.upload).not.toHaveBeenCalled();
});

it.each(["paste", "drop"])("saves a %s image as a cover and consumes the event", async type => {
  const state = await fixture();
  const before = state.editor.getJSON();
  const event = transferEvent(type, [new File(["image"], "cover.png", { type: "image/png" })]);
  state.panel.querySelector(".note-cover")?.dispatchEvent(event);
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(path));
  expect(event.defaultPrevented).toBe(true);
  expect(state.editor.getJSON()).toEqual(before);
});

it("accepts a desktop image file with no supplied MIME type", async () => {
  const state = await fixture();
  state.panel.querySelector(".note-cover")?.dispatchEvent(transferEvent("drop", [new File(["image"], "cover.PNG")]));
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(path));
});

it("highlights the cover during an image drag and clears it after nested drag exits", async () => {
  const state = await fixture(); const root = state.panel.querySelector<HTMLElement>(".note-cover");
  const file = new File(["image"], "cover.png", { type: "image/png" });
  const enter = transferEvent("dragenter", [file]);
  state.panel.querySelector(".editor-surface")?.dispatchEvent(enter);
  expect(root?.dataset["dragging"]).toBe("true");
  expect(enter.defaultPrevented).toBe(false);
  state.panel.dispatchEvent(transferEvent("dragenter", [file]));
  state.panel.dispatchEvent(new Event("dragleave", { bubbles: true }));
  expect(root?.dataset["dragging"]).toBe("true");
  state.panel.dispatchEvent(new Event("dragleave", { bubbles: true }));
  expect(root?.dataset["dragging"]).toBeUndefined();
  expect(state.upload).not.toHaveBeenCalled();
});

it.each(["readonly", "closed"])("ignores clipboard and drop events for a %s note", async change => {
  const state = await fixture(); const root = state.panel.querySelector(".note-cover");
  if (change === "readonly") state.editor.setEditable(false); else state.cover.destroy();
  for (const type of ["paste", "drop", "dragenter"]) {
    root?.dispatchEvent(transferEvent(type, [new File(["image"], "cover.png", { type: "image/png" })]));
  }
  expect(state.upload).not.toHaveBeenCalled();
  expect(root?.getAttribute("data-dragging")).toBeNull();
});

it("releases cover-menu keyboard handling when the note closes", async () => {
  const state = await fixture(); state.metadata.set("cover", path);
  const menu = state.panel.querySelector("details");
  if (!menu) throw new Error("missing cover menu");
  menu.open = true;
  state.cover.destroy();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(menu.open).toBe(true);
});

it.each(["https://example.com/image.png", "//example.com/image.png", "media/../../private.png", "javascript:alert(1)", "", [path]])("does not fetch an invalid or external cover %s", async value => {
  const state = await fixture(); state.metadata.set("cover", value);
  expect(state.image.hasAttribute("src")).toBe(false);
});

it.each(["-1", "NaN", "", {}, "500"])("uses a safe crop position for malformed metadata %s", async value => {
  const state = await fixture(); state.metadata.set("cover", path); state.metadata.set("cover_position", value);
  expect(state.image.style.objectPosition).toBe(`50% ${value === "500" ? "100" : "50"}%`);
});

it("renders synced cover changes and hides editing controls for a viewer", async () => {
  const state = await fixture(); state.editor.setEditable(false); state.metadata.set("cover", replacement);
  expect(state.image.src).toContain(replacement);
  expect(state.panel.querySelector<HTMLElement>(".note-cover-actions")?.hidden).toBe(true);
  state.choose(); state.remove.click(); state.position.dispatchEvent(new Event("input"));
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.metadata.get("cover")).toBe(replacement);
});

it("does not request cached cover bytes while the body is waiting", async () => {
  const state = await fixture(); state.panel.dataset["body"] = "waiting"; state.metadata.set("cover", path);
  expect(state.image.hasAttribute("src")).toBe(false);
  delete state.panel.dataset["body"];
  await vi.waitFor(() => expect(state.image.src).toContain(path));
});

it("keeps the previous cover when an upload fails and reports the failure", async () => {
  const state = await fixture(vi.fn().mockRejectedValue(new Error("Upload refused")));
  state.metadata.set("cover", path); state.choose();
  await vi.waitFor(() => expect(state.status.textContent).toBe("Upload refused"));
  expect(state.metadata.get("cover")).toBe(path);
  expect(state.cover.hasPending()).toBe(false);
});

it("rejects unsupported files before uploading", async () => {
  const state = await fixture(); state.choose("image/svg+xml");
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.status.textContent).toContain("PNG, JPEG, GIF or WebP");
});

it("refuses an invalid uploaded media path", async () => {
  const state = await fixture(vi.fn().mockResolvedValue({ path: "https://example.com/image.png" })); state.choose();
  await vi.waitFor(() => expect(state.status.textContent).toContain("supported cover image"));
  expect(state.metadata.has("cover")).toBe(false);
});

it.each(["removed", "synced", "readonly", "forbidden", "destroyed"])("refuses a completed upload after the destination is %s", async change => {
  let complete: ((result: MediaUploadResult) => void) | undefined;
  const pending = new Promise<MediaUploadResult>(resolve => { complete = resolve; });
  const state = await fixture(vi.fn().mockReturnValue(pending)); state.choose();
  if (change === "removed") state.remove.click();
  if (change === "synced") state.metadata.set("cover", replacement);
  if (change === "readonly") state.editor.setEditable(false);
  if (change === "forbidden") state.forbid();
  if (change === "destroyed") state.cover.destroy();
  complete?.({ path }); await pending; await Promise.resolve();
  expect(state.metadata.get("cover")).toBe(change === "synced" ? replacement : undefined);
});

it("waits for offline upload resolution without writing a blob URL to Markdown", async () => {
  let complete: ((result: MediaUploadResult) => void) | undefined;
  const pending = new Promise<MediaUploadResult>(resolve => { complete = resolve; });
  const state = await fixture(vi.fn().mockResolvedValue({ path: "blob:temporary", pending })); state.choose();
  await vi.waitFor(() => expect(state.status.textContent).toContain("queued"));
  expect(await editorMarkdown(state.documentModel)).not.toContain("blob:");
  complete?.({ path });
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(path));
});

it("removes observers and listeners when the note closes", async () => {
  const state = await fixture(); state.cover.destroy();
  state.metadata.set("cover", path); state.choose(); state.remove.click();
  expect(state.panel.querySelector(".note-cover")).toBeNull();
  expect(state.image.hasAttribute("src")).toBe(false);
  expect(state.upload).not.toHaveBeenCalled();
  expect(state.metadata.get("cover")).toBe(path);
});

it("leaves the banner DOM unchanged while typing in the note", async () => {
  const state = await fixture(); state.metadata.set("cover", path);
  const root = state.panel.querySelector(".note-cover");
  if (root === null) throw new Error("missing cover");
  const observer = new MutationObserver(() => undefined);
  observer.observe(root, { attributes: true, childList: true, subtree: true });
  try {
    state.editor.commands.insertContent("More text");
    expect(observer.takeRecords()).toEqual([]);
  } finally { observer.disconnect(); }
});

it("does not let a cancelled upload clear a newer upload's pending state", async () => {
  let finishFirst: ((result: MediaUploadResult) => void) | undefined;
  let finishSecond: ((result: MediaUploadResult) => void) | undefined;
  const first = new Promise<MediaUploadResult>(resolve => { finishFirst = resolve; });
  const second = new Promise<MediaUploadResult>(resolve => { finishSecond = resolve; });
  const upload = vi.fn<() => Promise<MediaUploadResult>>().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const state = await fixture(upload);
  state.choose(); state.remove.click(); state.choose();
  finishFirst?.({ path }); await first; await Promise.resolve();
  expect(state.cover.hasPending()).toBe(true);
  finishSecond?.({ path: replacement });
  await vi.waitFor(() => expect(state.metadata.get("cover")).toBe(replacement));
  expect(state.cover.hasPending()).toBe(false);
});

it("round-trips cover metadata through the Rust CRDT codec with unicode note content", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 }).map(parts => parts.join("")),
    fc.integer({ min: 0, max: 100 }),
    async (hash, position) => {
      const documentModel = new Doc();
      try {
        applyUpdate(documentModel, await updateFromMarkdown("# 🌄 منظر\n\nKeep this note.\n"));
        const path = `media/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;
        documentModel.getMap("frontmatter").set("cover", path);
        documentModel.getMap("frontmatter").set("cover_position", String(position));
        const markdown = await editorMarkdown(documentModel);
        const restored = new Doc();
        try {
          applyUpdate(restored, await updateFromMarkdown(markdown));
          expect(restored.getMap("frontmatter").toJSON()).toMatchObject({ cover: path, cover_position: String(position) });
          expect(await editorMarkdown(restored)).toBe(markdown);
        } finally { restored.destroy(); }
      } finally { documentModel.destroy(); }
    },
  ), { seed: 20261019, numRuns: 40 });
});
