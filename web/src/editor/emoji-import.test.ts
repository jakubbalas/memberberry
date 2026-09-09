// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";

import { emojiPackUploadBody, normalizeShortcode, planEmojiImport, planSlackEmojiImport, readEmojiImport } from "./emoji-import.js";

describe("emoji import", () => {
  it("normalizes filenames to server-safe shortcodes", () => {
    expect(normalizeShortcode(" Party Parrot! ")).toBe("party-parrot");
    expect(normalizeShortcode("---")).toBeUndefined();
    expect(normalizeShortcode("snow+day_2")).toBe("snow+day_2");
  });

  it("plans supported images and reports invalid files and collisions", () => {
    const plan = planEmojiImport([
      { name: "folder/Party Parrot.PNG", bytes: new Uint8Array([1]), type: "image/png" },
      { name: "party-parrot.jpg", bytes: new Uint8Array([2]), type: "image/jpeg" },
      { name: "notes.txt", bytes: new Uint8Array([3]), type: "text/plain" },
      { name: "empty.png", bytes: new Uint8Array(), type: "image/png" },
    ], new Set(["existing"]));
    expect(plan.assets.map((asset) => asset.file)).toEqual(["party-parrot.png", "party-parrot.jpg"]);
    expect(plan.collisions).toEqual(["party-parrot"]);
    expect(plan.invalid).toEqual(["notes.txt", "empty.png"]);
  });

  it("serializes image bytes into the server upload shape", () => {
    const plan = planEmojiImport([{ name: "wave.gif", bytes: new Uint8Array([0, 255]), type: "image/gif" }], new Set());
    expect(JSON.parse(emojiPackUploadBody("friendly", plan))).toEqual({
      manifest: { name: "friendly", version: 1, emoji: [{ shortcode: "wave", file: "wave.gif", aliases: [] }] },
      files: [{ name: "wave.gif", content_base64: "AP8=" }],
    });
  });

  it("imports Slack emoji JSON locally and preserves aliases without fetching URLs", () => {
    const plan = planSlackEmojiImport([
      { name: "emoji.json", bytes: new TextEncoder().encode(JSON.stringify({ partyparrot: "https://slack.test/partyparrot.png", parrot: "alias:partyparrot" })) },
      { name: "partyparrot.png", bytes: new Uint8Array([9]), type: "image/png" },
    ], new Set());
    expect(plan.invalid).toEqual([]);
    expect(plan.assets).toEqual([{ shortcode: "partyparrot", file: "partyparrot.png", bytes: new Uint8Array([9]), type: "image/png", aliases: ["parrot"] }]);
    expect(JSON.parse(emojiPackUploadBody("slack", plan)).manifest.emoji[0].aliases).toEqual(["parrot"]);
  });

  it("reports Slack names that normalize to the same shortcode without dropping either image", () => {
    const plan = planSlackEmojiImport([
      {
        name: "emoji.json",
        bytes: new TextEncoder().encode(JSON.stringify({
          "Party Parrot": "https://slack.test/first.png",
          "party-parrot": "https://slack.test/second.png",
        })),
      },
      { name: "first.png", bytes: new Uint8Array([1]), type: "image/png" },
      { name: "second.png", bytes: new Uint8Array([2]), type: "image/png" },
    ], new Set());

    expect(plan.assets.map((asset) => asset.shortcode)).toEqual(["party-parrot", "party-parrot"]);
    expect(plan.assets.map((asset) => [...asset.bytes])).toEqual([[1], [2]]);
    expect(plan.collisions).toEqual(["party-parrot"]);
  });

  it("reads image entries from a ZIP while ignoring path traversal", async () => {
    const archive = zipSync({ "emoji/wave.png": new Uint8Array([7]), "../secret.png": new Uint8Array([8]), "folder/": new Uint8Array() });
    const sources = await readEmojiImport([new File([archive], "pack.zip", { type: "application/zip" })]);
    expect(sources).toEqual([{ name: "emoji/wave.png", bytes: new Uint8Array([7]), type: "image/png" }]);
  });
});
