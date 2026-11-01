import { expect, it } from "vitest";
import { emojiName, nameEmojiQuery } from "./name-emoji.js";
const catalog = [{ shortcode: "tada", glyph: "🎉", aliases: ["party"], category: "activities", supportsSkinTone: false }];
it("resolves aliases case-insensitively while retaining unknown names and literal markup", () => {
  expect(emojiName("**:PARTY:** / :missing: / 🎉", catalog)).toBe("**🎉** / :missing: / 🎉");
});
it.each(["", "Name", "http:", ":tada:", "Folder/", "😀"])("does not open a query for %j", value => {
  expect(nameEmojiQuery(value, value.length, value.length)).toBeUndefined();
});
it("does not replace a selection", () => { expect(nameEmojiQuery(":ta", 1, 3)).toBeUndefined(); });
it("accepts an empty query immediately after a path separator", () => {
  expect(nameEmojiQuery("日本/: later", 4, 4)).toEqual({ from: 3, to: 4, text: "" });
});
