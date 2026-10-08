/** Real Rust/WASM namespace parsing and binary materialization, not copied TS parsing. */
import { readFileSync } from "node:fs";
import { bench } from "vitest";
import { load, normalize, updateFromMarkdown, markdownFromUpdate } from "../notes.js";

await load(readFileSync(new URL("../wasm/mb_bg.wasm", import.meta.url)));
for (const paragraphs of [32, 256]) {
  const plain = Array.from({ length: paragraphs }, (_, i) => `paragraph ${i} **bold** [link](https://example.test)`).join("\n\n");
  const styled = Array.from({ length: paragraphs }, (_, i) => `:mb-style[paragraph ${i} **bold** [link](https://example.test) [[Wiki]] $x[y]$]{underline="true" color="red" background="yellow" size="large"}`).join("\n\n");
  const canonical = await normalize(styled);
  if (await normalize(canonical) !== canonical) throw new Error("benchmark input must converge");
  const update = await updateFromMarkdown(canonical);
  if (await markdownFromUpdate(update) !== canonical) throw new Error("real binary input must reopen");
  const unmatched = ":mb-style[".repeat(paragraphs * 32) + "KEEP";
  bench(`WASM native Markdown normalize/${paragraphs} paragraphs`, async () => { await normalize(plain); }, { time: 500, iterations: 8 });
  bench(`WASM four namespace marks normalize/${paragraphs} paragraphs`, async () => { await normalize(styled); }, { time: 500, iterations: 8 });
  bench(`WASM Yrs namespace update reopen/${paragraphs} paragraphs`, async () => { await markdownFromUpdate(update); }, { time: 500, iterations: 8 });
  bench(`WASM malformed directive fallback/${paragraphs * 32} unmatched openers`, async () => { await normalize(unmatched); }, { time: 500, iterations: 8 });
}
