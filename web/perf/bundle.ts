/**
 * The critical-path bundle, measured off disk.
 *
 * `SPEC.md` §21.2 budgets "initial JS + WASM, gzip (excl. lazy Excalidraw)" at 350 KB. This
 * is the one §21 metric that is fully deterministic: the same build produces the same byte
 * count on every machine, so unlike every timing figure it can gate CI without a baseline
 * for the runner it happens to be on.
 *
 * It is measured statically rather than from what the browser fetched, on purpose. A static
 * sum answers "how much does this build weigh", which is the question a budget asks; what the
 * browser fetched answers "how much did this page need", which is a *smaller* number the
 * moment code-splitting lands. The harness reports both and flags the difference, because the
 * day they diverge is the day the gate should move to the observed number.
 */

import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Files that are deliberately not on the critical path.
 *
 * §21.2 excludes the Excalidraw island, which is lazily imported and only ever fetched by a
 * note containing a drawing (M12). Nothing matches this yet; the pattern is here so the
 * exclusion is a rule rather than something remembered later.
 */
const LAZY = [/excalidraw/i];

const COUNTED = new Set([".js", ".wasm"]);

export interface Asset {
  readonly name: string;
  readonly raw: number;
  readonly gzip: number;
}

export interface BundleMeasurement {
  readonly assets: readonly Asset[];
  readonly totalRaw: number;
  readonly totalGzip: number;
  /** Excluded by `LAZY`, reported so an exclusion is never silent. */
  readonly excluded: readonly string[];
}

/** Every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...walk(join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Sums the gzipped size of every eagerly loaded script and WebAssembly module under `dist`.
 *
 * Level 9 rather than the default 6: it is the level a CDN or an `nginx` with
 * `gzip_comp_level 9` produces, so the number is the smallest an operator can achieve and the
 * budget is not flattered by a compression setting nobody chose. Compressing at measure time
 * is not the same as serving compressed — see `measure.ts` for what the server actually sends.
 *
 * @throws if `dist` does not exist, because a missing build is not a passing budget.
 */
export function measureBundle(dist: string): BundleMeasurement {
  if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `${dist} is not a directory. The bundle budget needs a production build — ` +
        "`make web-build`, which `make perf` runs first.",
    );
  }
  const assets: Asset[] = [];
  const excluded: string[] = [];
  for (const name of walk(dist)) {
    if (!COUNTED.has(extname(name))) continue;
    if (LAZY.some((pattern) => pattern.test(name))) {
      excluded.push(name);
      continue;
    }
    const bytes = readFileSync(join(dist, name));
    assets.push({
      name,
      raw: bytes.byteLength,
      gzip: gzipSync(bytes, { level: 9 }).byteLength,
    });
  }
  if (assets.length === 0) {
    throw new Error(`${dist} contains no .js or .wasm — is this a production build?`);
  }
  return {
    assets: [...assets].sort((a, b) => b.gzip - a.gzip),
    totalRaw: assets.reduce((sum, asset) => sum + asset.raw, 0),
    totalGzip: assets.reduce((sum, asset) => sum + asset.gzip, 0),
    excluded,
  };
}
