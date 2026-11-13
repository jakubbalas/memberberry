/** A failed load of the emoji catalog is retried on the next use, not kept (offline, aborted). */

import { expect, it, vi } from "vitest";

let attempts = 0;
vi.mock("./wasm/emoji/emoji.js", () => {
  attempts += 1;
  if (attempts === 1) throw new Error("the catalog could not be loaded");
  return {
    default: async () => undefined,
    emojiCatalog: () => [{ shortcode: "smile", glyph: "😄", aliases: [] }],
  };
});

it("loads the catalog on the next use after a failed load", async () => {
  const { emojiCatalog } = await import("./emoji-catalog.js");
  await expect(emojiCatalog()).rejects.toThrow();
  await expect(emojiCatalog()).resolves.toEqual([{ shortcode: "smile", glyph: "😄", aliases: [] }]);
});
