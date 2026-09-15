// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
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

  it("uploads a custom pack and adds its emoji to the picker", async () => {
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const status = document.createElement("div");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "prompt").mockReturnValue("Friendly Pack");
    const picker = mountEmojiPicker(editor, toolbar, [], { vault: "vault", status });
    document.body.append(toolbar);
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    const file = new File([new Uint8Array([1, 2, 3])], "wave.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/vaults/vault/emoji/packs/friendly-pack");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { manifest: { name: string } };
    expect(body.manifest.name).toBe("friendly-pack");
    expect(status.textContent).toBe("Imported 1 custom emoji.");
    toolbar.querySelector<HTMLButtonElement>(".emoji-picker-toggle")?.click();
    expect(toolbar.querySelectorAll(".emoji-picker-item")).toHaveLength(1);
    expect(toolbar.querySelector(".emoji-picker-item")?.getAttribute("aria-label")).toBe(":wave:");
    picker.destroy();
    vi.restoreAllMocks();
  });

  it("uploads a Slack export with its alias in the manifest", async () => {
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "prompt")
      .mockReturnValueOnce("slack-emoji")
      .mockReturnValueOnce("party-bird");
    const picker = mountEmojiPicker(editor, toolbar, [
      { shortcode: "existing", glyph: "🎉", category: "activities", custom: false, aliases: ["parrot"] },
    ], { vault: "vault" });
    document.body.append(toolbar);
    const input = toolbar.querySelector<HTMLInputElement>(".emoji-import-controls input");
    if (input === null) throw new Error("import input missing");
    const files = [
      new File([JSON.stringify({ partyparrot: "https://slack.test/partyparrot.png", parrot: "alias:partyparrot" })], "emoji.json"),
      new File([new Uint8Array([1, 2, 3])], "partyparrot.png", { type: "image/png" }),
    ];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    toolbar.querySelector<HTMLButtonElement>("[aria-label='Import a local Slack emoji export']")?.click();
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { manifest: { emoji: Array<{ aliases: string[] }> } };
    expect(body.manifest.emoji[0]?.aliases).toEqual(["party-bird"]);
    picker.destroy();
    vi.restoreAllMocks();
  });

  it("lists and deletes a vault-local pack from the management panel", async () => {
    const { editor } = fakeEditor();
    const toolbar = document.createElement("div");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ name: "friendly", emoji_count: 2 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const picker = mountEmojiPicker(editor, toolbar, [{ shortcode: "wave", glyph: "", category: "friendly", custom: true }], { vault: "vault" });
    document.body.append(toolbar);
    toolbar.querySelector<HTMLButtonElement>("[aria-label='Manage vault custom emoji packs']")?.click();
    await vi.waitFor(() => expect(toolbar.querySelector(".emoji-pack-row")).not.toBeNull());
    toolbar.querySelector<HTMLButtonElement>("[aria-label='Delete friendly emoji pack']")?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/vaults/vault/emoji/packs/friendly");
    expect(toolbar.querySelector(".emoji-picker-item")).toBeNull();
    picker.destroy();
    vi.restoreAllMocks();
  });
});
