// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";

import { mountEmojiPicker, mergeEmojiChoices, type EmojiChoice } from "./emoji-picker.js";

function fakeEditor() {
  const run = vi.fn();
  const insertContent = vi.fn();
  const editor = {
    chain: () => ({
      focus: () => ({
        insertContent: (value: string) => {
          insertContent(value);
          return { run };
        },
      }),
    }),
  } as unknown as Editor;
  return { editor, run, insertContent };
}

const choices: readonly EmojiChoice[] = [
  { shortcode: "partyparrot", glyph: "", category: "custom", custom: true },
  { shortcode: "tada", glyph: "🎉", category: "activities", custom: false, supportsSkinTone: false },
];

describe("emoji picker", () => {
  describe("dismissal", () => {
    let root: HTMLElement;
    let toggle: HTMLButtonElement;
    let panel: HTMLElement;
    let search: HTMLInputElement;
    let outside: HTMLButtonElement;
    let picker: ReturnType<typeof mountEmojiPicker>;

    beforeEach(() => {
      root = document.createElement("div");
      outside = document.createElement("button");
      outside.textContent = "Outside";
      document.body.append(root, outside);
      picker = mountEmojiPicker(fakeEditor().editor, root, choices);
      const button = root.querySelector<HTMLButtonElement>(".emoji-picker-toggle");
      const dialog = root.querySelector<HTMLElement>(".emoji-picker");
      const input = root.querySelector<HTMLInputElement>("input[type='search']");
      if (button === null || dialog === null || input === null) throw new Error("picker controls missing");
      toggle = button;
      panel = dialog;
      search = input;
      toggle.click();
    });

    afterEach(() => {
      picker.destroy();
      root.remove();
      outside.remove();
    });

    it("closes on an outside pointer press without consuming the target's interaction", () => {
      const pressed = vi.fn((event: Event) => event.stopPropagation());
      outside.addEventListener("pointerdown", pressed);
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      outside.dispatchEvent(event);
      outside.focus();
      expect(panel.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(pressed).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
    });

    it.each(["inside", "outside"])("closes on Escape with focus %s and restores focus to the toggle", (location) => {
      const target = location === "inside" ? search : outside;
      target.focus();
      const escaped = vi.fn();
      target.addEventListener("keydown", escaped);
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(panel.hidden).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(toggle);
      expect(event.defaultPrevented).toBe(true);
      expect(escaped).not.toHaveBeenCalled();
    });

    it("keeps inside pointer interactions open and lets the toggle close and reopen it", () => {
      search.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      root.querySelector<HTMLButtonElement>("[aria-label='Show custom emoji']")?.click();
      expect(panel.hidden).toBe(false);
      toggle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      toggle.click();
      expect(panel.hidden).toBe(true);
      toggle.click();
      expect(panel.hidden).toBe(false);
      expect(document.activeElement).toBe(search);
    });

    it("ignores Escape while closed without moving focus", () => {
      toggle.click();
      outside.focus();
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      outside.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
    });

    it("removes document dismissal listeners on teardown", () => {
      picker.destroy();
      outside.focus();
      outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      outside.dispatchEvent(event);
      expect(panel.hidden).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outside);
    });
  });

  describe("single-image upload failures and teardown", () => {
    const fetchMock = vi.fn<typeof fetch>();
    let toolbar: HTMLElement;
    let status: HTMLElement;
    let input: HTMLInputElement;
    let button: HTMLButtonElement;
    let picker: ReturnType<typeof mountEmojiPicker>;
    const select = (file: File): void => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change"));
    };

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
      toolbar = document.createElement("div");
      status = document.createElement("div");
      picker = mountEmojiPicker(fakeEditor().editor, toolbar, [{ shortcode: "taken", glyph: "", custom: true, category: "custom", aliases: ["wave"] }], { vault: "vault", status });
      const fileInput = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
      const importButton = toolbar.querySelector<HTMLButtonElement>(".emoji-import-controls button");
      if (fileInput === null || importButton === null) throw new Error("import controls missing");
      input = fileInput;
      button = importButton;
    });

    afterEach(() => {
      picker.destroy();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it.each([403, 409, 500])("reports HTTP %s without adding an emoji and permits another attempt", async (code) => {
      fetchMock.mockResolvedValue(new Response(null, { status: code }));
      select(new File(["image"], "fresh.png"));
      await vi.waitFor(() => expect(status.textContent).toBe(code === 409 ? "That emoji already exists. Choose another shortcode." : "Emoji import failed."));
      expect(button.disabled).toBe(false);
      expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
      fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
      select(new File(["image"], "fresh.png"));
      await vi.waitFor(() => expect(status.textContent).toBe("Imported :fresh:."));
      expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(2);
    });

    it.each([null, "taken", "---"])("does not upload after a cancelled or invalid replacement %s", async (replacement) => {
      vi.spyOn(window, "prompt").mockReturnValue(replacement);
      vi.spyOn(window, "alert").mockImplementation(() => undefined);
      select(new File(["image"], "wave.png"));
      await vi.waitFor(() => expect(status.textContent).toBe("Import cancelled."));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(button.disabled).toBe(false);
    });

    it("reports file read failures without uploading", async () => {
      const file = new File(["image"], "fresh.png");
      vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("File could not be read."));
      select(file);
      await vi.waitFor(() => expect(status.textContent).toBe("File could not be read."));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(button.disabled).toBe(false);
    });

    it("reports network failures without adding an emoji", async () => {
      fetchMock.mockRejectedValue(new TypeError("Network unavailable."));
      select(new File(["image"], "fresh.png"));
      await vi.waitFor(() => expect(status.textContent).toBe("Network unavailable."));
      expect(button.disabled).toBe(false);
      expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
    });

    it("does not upload a file whose read completes after teardown", async () => {
      let finish: (bytes: ArrayBuffer) => void = () => undefined;
      const reading = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
      const file = new File(["image"], "fresh.png");
      vi.spyOn(file, "arrayBuffer").mockReturnValue(reading);
      select(file);
      picker.destroy();
      finish(new Uint8Array([7]).buffer);
      await reading;
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(status.textContent).toBe("");
    });

    it("aborts an upload and ignores a late success after teardown", async () => {
      let finish: (response: Response) => void = () => undefined;
      const uploading = new Promise<Response>((resolve) => { finish = resolve; });
      fetchMock.mockReturnValue(uploading);
      const panel = toolbar.querySelector(".emoji-picker");
      select(new File(["image"], "fresh.png"));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      expect(button.disabled).toBe(true);
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      picker.destroy();
      expect(signal?.aborted).toBe(true);
      finish(new Response(null, { status: 201 }));
      await uploading;
      await Promise.resolve();
      expect(status.textContent).toBe("");
      expect(panel?.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
    });
  });

  it("offers only single-image import without pack management or bulk import controls", () => {
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, [], { vault: "vault" });
    expect([...toolbar.querySelectorAll(".emoji-import-controls button")].map((button) => button.textContent)).toEqual([
      "Import custom emoji",
    ]);
    picker.destroy();
  });

  it("opens a single-image file picker", () => {
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, [], { vault: "vault" });
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    const choose = vi.spyOn(input, "click").mockImplementation(() => undefined);
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>(".emoji-import-controls button")];
    const files = buttons.find((button) => button.textContent === "Import custom emoji");
    files?.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(input.hasAttribute("webkitdirectory")).toBe(false);
    expect(input.accept.split(",")).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(input.multiple).toBe(false);
    picker.destroy();
    files?.click();
    expect(choose).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("loads once on demand and preserves a query typed while loading", async () => {
    let release: (entries: readonly EmojiChoice[]) => void = () => undefined;
    const pending = new Promise<readonly EmojiChoice[]>((resolve) => { release = resolve; });
    const loader = vi.fn(() => pending);
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, loader);
    const toggle = toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle");
    expect(loader).not.toHaveBeenCalled();
    toggle?.click();
    const search = toolbar.querySelector<HTMLInputElement>("input");
    if (search === null) throw new Error("search missing");
    search.value = "tada";
    search.dispatchEvent(new Event("input"));
    toggle?.click();
    toggle?.click();
    expect(loader).toHaveBeenCalledTimes(1);
    release(choices);
    await vi.waitFor(() => expect(toolbar.querySelector(".emoji-picker")?.hasAttribute("aria-busy")).toBe(false));
    expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
    expect(toolbar.querySelector(".emoji-picker-item")?.textContent).toBe("🎉");
    expect(toolbar.querySelector('[aria-label="Show activities emoji"]')).not.toBeNull();
    toggle?.click();
    toggle?.click();
    expect(loader).toHaveBeenCalledTimes(1);
    picker.destroy();
  });

  it("reports loading failures and permits an explicit reopen to load again", async () => {
    const loader = vi.fn<() => Promise<readonly EmojiChoice[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(choices);
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, loader);
    const toggle = toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle");
    toggle?.click();
    await vi.waitFor(() => expect(toolbar.querySelector('[role="status"]')?.textContent).toContain("Could not load emoji"));
    toggle?.click();
    toggle?.click();
    await vi.waitFor(() => expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(2));
    picker.destroy();
  });

  it("aborts pending loading on teardown and ignores a late result", async () => {
    let release: (entries: readonly EmojiChoice[]) => void = () => undefined;
    const pending = new Promise<readonly EmojiChoice[]>((resolve) => { release = resolve; });
    const loader = vi.fn((_signal: AbortSignal) => pending);
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, loader);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    const panel = toolbar.querySelector(".emoji-picker");
    picker.destroy();
    expect(loader.mock.calls[0]?.[0].aborted).toBe(true);
    release(choices);
    await pending;
    expect(panel?.querySelectorAll(".emoji-picker-item")).toHaveLength(0);
    expect(toolbar.children).toHaveLength(0);
  });

  it("merges only validated custom entries before the base catalog", () => {
    expect(mergeEmojiChoices(choices.slice(1), [{ shortcode: "parrot", pack: "custom", file: "parrot.gif", aliases: ["party"] }, { shortcode: 4 }], "vault")).toEqual([
      { shortcode: "parrot", glyph: "", category: "custom", custom: true, aliases: ["party"], imageUrl: "/api/v1/vaults/vault/emoji/custom/parrot.gif" },
      choices[1],
    ]);
  });

  it("searches, keeps custom entries visible first, and inserts their readable shortcode", () => {
    const { editor, run } = fakeEditor();
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(editor, toolbar, choices);
    document.body.append(toolbar);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    const items = [...toolbar.querySelectorAll<HTMLButtonElement>(".emoji-picker-item")];
    expect(items.map((item) => item.textContent)).toEqual([":partyparrot:", "🎉"]);
    toolbar.querySelector<HTMLInputElement>("input")?.setAttribute("value", "parrot");
    const search = toolbar.querySelector<HTMLInputElement>("input");
    if (search === null) throw new Error("search input missing");
    search.value = "parrot";
    search.dispatchEvent(new Event("input"));
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-item")?.click();
    expect(run).toHaveBeenCalled();
    picker.destroy();
    expect(toolbar.querySelector(".emoji-picker-wrap")).toBeNull();
  });

  it("filters by category and appends the selected skin tone to Unicode emoji", () => {
    const { editor, insertContent } = fakeEditor();
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(editor, toolbar, [
      { shortcode: "partyparrot", glyph: "", category: "custom", custom: true },
      { shortcode: "wave", glyph: "👋", category: "people", custom: false, supportsSkinTone: true },
      { shortcode: "tada", glyph: "🎉", category: "activities", custom: false, supportsSkinTone: false },
    ]);
    document.body.append(toolbar);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    const people = [...toolbar.querySelectorAll<HTMLButtonElement>(".emoji-picker-category")]
      .find((button) => button.textContent === "people");
    people?.click();
    expect([...toolbar.querySelectorAll(".emoji-picker-item")].map((item) => item.textContent)).toEqual(["👋"]);
    toolbar.querySelector<HTMLButtonElement>('[aria-label="skin-tone-3"]')?.click();
    expect(toolbar.querySelector<HTMLButtonElement>(".emoji-picker-item")?.textContent).toBe("👋🏼");
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-item")?.click();
    expect(insertContent).toHaveBeenCalledWith("👋🏼");
    picker.destroy();
  });

  it("matches fuzzy names and records the selected emoji in the recent section", () => {
    localStorage.clear();
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const picker = mountEmojiPicker(editor, toolbar, [
      { shortcode: "partyparrot", glyph: "🦜", category: "animals", custom: false },
      { shortcode: "tada", glyph: "🎉", category: "activities", custom: false },
    ]);
    document.body.append(toolbar);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    const search = toolbar.querySelector<HTMLInputElement>("input");
    if (search === null) throw new Error("search input missing");
    search.value = "ppr";
    search.dispatchEvent(new Event("input"));
    expect([...toolbar.querySelectorAll(".emoji-picker-item")].map((item) => item.textContent)).toEqual(["🦜"]);
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-item")?.click();
    toolbar.querySelector<HTMLButtonElement>('[aria-label="Show recent emoji"]')?.click();
    expect([...toolbar.querySelectorAll(".emoji-picker-item")].map((item) => item.textContent)).toEqual(["🦜"]);
    picker.destroy();
  });

  it("imports one image without a pack-name prompt and adds it to the picker", async () => {
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const status = document.createElement("div");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    const picker = mountEmojiPicker(editor, toolbar, [], { vault: "vault", status });
    document.body.append(toolbar);
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    const file = new File([new Uint8Array([1, 2, 3])], "wave.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { manifest: { name: string; emoji: Array<{ shortcode: string }> } };
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/vaults/vault/emoji/packs/${body.manifest.name}`);
    expect(body.manifest.name).toMatch(/^emoji-[0-9a-f-]{36}$/);
    expect(body.manifest.emoji).toEqual([{ shortcode: "wave", file: "wave.png", aliases: [] }]);
    expect(prompt).not.toHaveBeenCalled();
    expect(status.textContent).toBe("Imported :wave:.");
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
    expect(toolbar.querySelector(".emoji-picker-item")?.getAttribute("aria-label")).toBe(":wave:");
    Object.defineProperty(input, "files", { configurable: true, value: [new File([new Uint8Array([7])], "fresh.png", { type: "image/png" })] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { manifest: { name: string } };
    expect(second.manifest.name).not.toBe(body.manifest.name);
    expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(2);
    expect(prompt).not.toHaveBeenCalled();
    picker.destroy();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "cancelled selection", files: [], message: "" },
    { name: "ZIP archive", files: [new File(["zip"], "pack.zip", { type: "application/zip" })], message: "Choose a non-empty PNG, GIF, JPEG or WebP image." },
    { name: "multiple selection", files: [new File(["a"], "a.png"), new File(["b"], "b.png")], message: "Choose one emoji image." },
    { name: "unsupported file", files: [new File(["text"], "notes.txt", { type: "text/plain" })], message: "Choose a non-empty PNG, GIF, JPEG or WebP image." },
    { name: "empty image", files: [new File([], "empty.png", { type: "image/png" })], message: "Choose a non-empty PNG, GIF, JPEG or WebP image." },
  ])("does not upload a $name", async ({ files, message }) => {
    const toolbar = document.createElement("div");
    const status = document.createElement("div");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const picker = mountEmojiPicker(fakeEditor().editor, toolbar, [], { vault: "vault", status });
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(status.textContent).toBe(message));
    expect(fetchMock).not.toHaveBeenCalled();
    picker.destroy();
    vi.unstubAllGlobals();
  });

  it("renames an imported image whose filename collides with an existing alias", async () => {
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompt = vi.spyOn(window, "prompt").mockReturnValueOnce("party-bird");
    const picker = mountEmojiPicker(editor, toolbar, [
      { shortcode: "existing", glyph: "🎉", category: "activities", custom: false, aliases: ["parrot"] },
    ], { vault: "vault" });
    document.body.append(toolbar);
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    const files = [new File([new Uint8Array([1, 2, 3])], "parrot.png", { type: "image/png" })];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { manifest: { emoji: Array<{ shortcode: string; file: string }> } };
    expect(body.manifest.emoji).toEqual([{ shortcode: "party-bird", file: "party-bird.png", aliases: [] }]);
    expect(prompt).toHaveBeenCalledExactlyOnceWith("Shortcode :parrot: already exists. Enter a replacement shortcode, or Cancel.");
    picker.destroy();
    vi.restoreAllMocks();
  });

});
