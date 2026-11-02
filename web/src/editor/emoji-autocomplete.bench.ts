/**
 * Host-only shortcode ranking over the vendored 1,814-entry Unicode catalog.
 * Run from web/: npm exec -- vitest bench --run src/editor/emoji-autocomplete.bench.ts --maxWorkers=1
 * Excludes DOM/layout and device input-to-paint; this does not establish SPEC §21 device budgets.
 */
import { readFileSync } from "node:fs";
import { bench, describe } from "vitest";
import { emojiSuggestions } from "../emoji-suggestions.js";

interface Source { emoji: string; shortcodes: string[]; order: number }
const source = JSON.parse(readFileSync("../vendor/emoji/emojibase-data.json", "utf8")) as Source[];
const catalog = source.sort((left, right) => left.order - right.order).map((entry) => ({
  shortcode: entry.shortcodes[0] ?? "", aliases: entry.shortcodes.slice(1), glyph: entry.emoji,
  category: "emoji", supportsSkinTone: false,
}));

describe("emoji autocomplete / full Unicode catalog", () => {
  for (const query of ["", "t", "ta"]) {
    bench(`rank ${JSON.stringify(query)}`, () => {
      if (emojiSuggestions(catalog, query).length !== 8) throw new Error("suggestion bound changed");
    }, { time: 200, warmupTime: 100 });
  }
});
