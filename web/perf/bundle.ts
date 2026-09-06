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
 * Files that are deliberately not on the critical path, by name.
 *
 * §21.2 excludes the Excalidraw island (M12). The manifest below is what decides this in
 * general; this list is a second net for an asset the manifest cannot see — one copied into
 * `public/`, say, which Vite passes through without recording.
 */
const LAZY = [/excalidraw/i];

/** Where Vite records which chunk imports which. Written because `build.manifest` is on. */
const MANIFEST = ".vite/manifest.json";

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

/**
 * The chunks a first visit actually downloads: the entries, plus everything they import
 * *statically*, transitively.
 *
 * why: this is what "initial" means in §21.2's "initial JS + WASM, gzip (excl. lazy
 * Excalidraw)", and until M8's graph the distinction was theoretical — every chunk was
 * eager, so summing the directory and summing the entry's closure gave the same number. They
 * no longer do: the graph is behind a command most sessions never run (§9.4), and charging
 * the critical path for it would make the budget describe a download nobody performs.
 *
 * A `dynamicImports` edge is deliberately *not* followed. That is the whole rule: an
 * `import()` is a chunk fetched when something asks for it, and a static `import` is one
 * fetched before the page runs.
 *
 * Returns `undefined` when there is no manifest, which is a build that cannot be split —
 * every asset then counts, which is the safe direction to be wrong in.
 */
function eagerChunks(dist: string): Set<string> | undefined {
  const path = join(dist, MANIFEST);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return undefined;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, ManifestChunk>;
  const eager = new Set<string>();
  const queue = Object.values(manifest)
    .filter((chunk) => chunk.isEntry === true)
    .map((chunk) => chunk.file);
  const byFile = new Map(Object.values(manifest).map((chunk) => [chunk.file, chunk]));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || eager.has(file)) continue;
    eager.add(file);
    const chunk = byFile.get(file);
    if (chunk === undefined) continue;
    for (const asset of chunk.assets ?? []) eager.add(asset);
    for (const key of chunk.imports ?? []) {
      const imported = manifest[key];
      if (imported !== undefined) queue.push(imported.file);
    }
  }
  return eager;
}

/** The fields of a Vite manifest entry this reads. */
interface ManifestChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  /** Static imports, by manifest key. */
  readonly imports?: readonly string[];
  /** Non-script files the chunk pulls in — a `new URL(...)` wasm module lands here. */
  readonly assets?: readonly string[];
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
  const eager = eagerChunks(dist);
  const assets: Asset[] = [];
  const excluded: string[] = [];
  for (const name of walk(dist)) {
    if (!COUNTED.has(extname(name))) continue;
    if (LAZY.some((pattern) => pattern.test(name)) || eager?.has(name) === false) {
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
