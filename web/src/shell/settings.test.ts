import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { checkShortcode, parseSettings, takenNames } from "./settings.js";

const row = { shortcode: "parrot", aliases: ["bird"], pack: "emoji-a", file: "parrot.png", shared: false };

describe("parsing settings from the wire", () => {
  it("accepts a well-formed payload and builds vault-scoped image URLs", () => {
    const parsed = parseSettings({ theme: "memberberry-dark", accent: "#AABBCC", emoji: [row] }, "my vault");
    expect(parsed?.theme).toBe("memberberry-dark");
    expect(parsed?.accent).toBe("#aabbcc");
    expect(parsed?.emoji[0]?.imageUrl).toBe("/api/v1/vaults/my%20vault/emoji/emoji-a/parrot.png");
  });

  it("lists the vault's own emoji before shared ones", () => {
    const parsed = parseSettings({ theme: "system", accent: null, emoji: [{ ...row, shortcode: "a", shared: true }, { ...row, shortcode: "z" }] }, "v");
    expect(parsed?.emoji.map((entry) => entry.shortcode)).toEqual(["z", "a"]);
  });

  it.each([
    null, "html", {}, { theme: "custom", accent: null, emoji: [] },
    { theme: "system", accent: "red", emoji: [] },
    { theme: "system", accent: null, emoji: [{ ...row, file: "https://evil.test/x.png" }] },
    { theme: "system", accent: null, emoji: [{ ...row, pack: "../secret" }] },
    { theme: "system", accent: null, emoji: [{ ...row, aliases: [7] }] },
    { theme: "system", accent: null, emoji: [{ ...row, shared: "no" }] },
  ])("refuses %j", (body) => {
    expect(parseSettings(body, "v")).toBeUndefined();
  });

  it("never builds an image URL outside the vault's emoji route (seeded property)", () => {
    fc.assert(fc.property(fc.string(), fc.string(), fc.string(), (pack, file, vault) => {
      const parsed = parseSettings({ theme: "system", accent: null, emoji: [{ ...row, pack, file }] }, vault);
      for (const entry of parsed?.emoji ?? []) {
        expect(entry.imageUrl.startsWith(`/api/v1/vaults/${encodeURIComponent(vault)}/emoji/`)).toBe(true);
        expect(entry.imageUrl).not.toContain("..");
      }
    }), { seed: 20_261_102, numRuns: 200 });
  });
});

describe("checking a typed shortcode", () => {
  const emoji = parseSettings({ theme: "system", accent: null, emoji: [row, { ...row, shortcode: "cat", aliases: ["kitty"] }] }, "v")?.emoji ?? [];
  const taken = takenNames(emoji);
  const parrot = emoji.find((entry) => entry.shortcode === "parrot");

  it("normalizes colons, case and spaces", () => {
    expect(checkShortcode(" :Party Time: ", taken)).toEqual({ shortcode: "party-time" });
  });

  it("refuses names other emoji use, canonical or alias", () => {
    expect(checkShortcode("cat", taken)).toHaveProperty("error");
    expect(checkShortcode("kitty", taken)).toHaveProperty("error");
  });

  it("allows renaming onto the emoji's own alias, but not onto its current name", () => {
    expect(checkShortcode("bird", taken, parrot)).toEqual({ shortcode: "bird" });
    expect(checkShortcode("parrot", taken, parrot)).toHaveProperty("error");
  });

  it("refuses a name with nothing usable in it", () => {
    expect(checkShortcode("🎉", taken)).toHaveProperty("error");
    expect(checkShortcode("", taken)).toHaveProperty("error");
  });
});
