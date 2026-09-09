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
});
