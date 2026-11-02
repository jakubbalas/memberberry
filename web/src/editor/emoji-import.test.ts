// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { emojiUploadBody, normalizeShortcode, planEmojiImport, readEmojiImport } from "./emoji-import.js";

describe("single emoji import", () => {
  it("normalizes filenames to server-safe shortcodes", () => {
    expect(normalizeShortcode(" Party Parrot! ")).toBe("party-parrot");
    expect(normalizeShortcode("---")).toBeUndefined();
    expect(normalizeShortcode("snow+day_2")).toBe("snow+day_2");
  });

  it("normalizes manually entered Unicode shortcodes idempotently", () => {
    const input = fc.array(fc.integer({ min: 0, max: 0x10ffff }), { maxLength: 64 }).map((points) => String.fromCodePoint(...points));
    fc.assert(fc.property(input, (value) => {
      const normalized = normalizeShortcode(value);
      if (normalized === undefined) return;
      expect(normalized).toMatch(/^[a-z0-9][a-z0-9_+-]*$/);
      expect(normalizeShortcode(normalized)).toBe(normalized);
    }), { seed: 20261102, numRuns: 100 });
  });

  it.each(["PNG", "gif", "jpg", "jpeg", "webp"])("plans one %s image from its filename", (extension) => {
    expect(planEmojiImport(`Party Parrot.${extension}`, new Uint8Array([7]))).toEqual({
      shortcode: "party-parrot", file: `party-parrot.${extension.toLowerCase()}`, bytes: new Uint8Array([7]),
    });
  });

  it.each(["pack.zip", "emoji.json", "picture.svg", "image"])("rejects unsupported image %s", (name) => {
    expect(planEmojiImport(name, new Uint8Array([7]))).toBeUndefined();
  });

  it.each(["---.png", "🎉.png", "日本語.png", "مرحبا.png"])("suggests an editable fallback for %s", (name) => {
    expect(planEmojiImport(name, new Uint8Array([7]))).toEqual({ shortcode: "custom-emoji", file: "custom-emoji.png", bytes: new Uint8Array([7]) });
  });

  it("rejects an empty image", () => {
    expect(planEmojiImport("empty.png", new Uint8Array())).toBeUndefined();
  });

  it("reads a selected PNG without requiring a directory or manifest", async () => {
    expect(await readEmojiImport(new File([new Uint8Array([7])], "wave.png", { type: "image/png" }))).toEqual({
      shortcode: "wave", file: "wave.png", bytes: new Uint8Array([7]),
    });
  });

  it("serializes one image into the existing server upload shape", () => {
    expect(JSON.parse(emojiUploadBody("emoji-123", { shortcode: "wave", file: "wave.gif", bytes: new Uint8Array([0, 255]) }))).toEqual({
      manifest: { name: "emoji-123", version: 1, emoji: [{ shortcode: "wave", file: "wave.gif", aliases: [] }] },
      files: [{ name: "wave.gif", content_base64: "AP8=" }],
    });
  });

  it("preserves arbitrary image bytes in the upload encoding", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 1, maxLength: 1024 }), (bytes) => {
      const body = JSON.parse(emojiUploadBody("emoji-123", { shortcode: "wave", file: "wave.png", bytes })) as { files: Array<{ content_base64: string }> };
      expect(Uint8Array.from(atob(body.files[0]?.content_base64 ?? ""), (char) => char.charCodeAt(0))).toEqual(bytes);
    }), { seed: 20261101, numRuns: 100 });
  });

  it("preserves image bytes across encoding chunk boundaries", () => {
    const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 256);
    const body = JSON.parse(emojiUploadBody("emoji-123", { shortcode: "wave", file: "wave.png", bytes })) as { files: Array<{ content_base64: string }> };
    expect(Uint8Array.from(atob(body.files[0]?.content_base64 ?? ""), (char) => char.charCodeAt(0))).toEqual(bytes);
  });
});
