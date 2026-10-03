/**
 * Synthetic permission-filtered 10k-note catalog: cold preparation and warm keystroke ranking.
 * Run: cd web && taskset -c 0 nice -n 10 npm exec -- vitest bench --run src/editor/document-link-autocomplete.bench.ts --maxWorkers=1
 * Laptop/host microbenchmark only: excludes network, DOM/layout and input-to-paint latency.
 * It is not evidence that SPEC §21's mid-range Android device budget passes.
 */
import { bench, describe } from "vitest";
import { createDocumentLinkIndex } from "./document-link-autocomplete.js";

const catalog = Array.from({ length: 10_000 }, (_, index) => ({
  path: `Projects/${String(index % 100).padStart(3, "0")}/Document ${String(index).padStart(5, "0")}.md`,
  title: index % 5 === 0 ? `Roadmap ${index}` : `Document ${index}`,
}));
const rank = createDocumentLinkIndex(catalog);
const queries = ["", "r", "ro", "road", "roadmap", "document 12", "Projects/012", "no matching title"];
let query = 0;

describe("document-link autocomplete / 10,000 authorized notes", () => {
  bench("cold catalog normalization and index preparation", () => {
    createDocumentLinkIndex(catalog);
  });
  bench("warm top-eight ranking per keystroke", () => {
    const result = rank(queries[query % queries.length] ?? "");
    query += 1;
    if (result.length > 8) throw new Error("suggestion bound violated");
  });
});
