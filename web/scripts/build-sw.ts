/**
 * Builds the service worker, with this build's precache list baked into it (`SPEC.md` §7.4).
 *
 * A second Vite build rather than a second entry in the first one. A service worker has to
 * land at a fixed, root-scoped URL — `/sw.js`, never `/assets/sw-a1b2c3.js` — and it has to
 * be one self-contained file, because a classic worker cannot `import`. Both are exactly
 * what Vite's library mode produces, and neither is something the application build can do
 * without giving every other chunk the same treatment.
 *
 * It runs *after* the application build because it reads that build's output: the list of
 * URLs to precache is the list of files Vite just emitted.
 *
 * A boundary, like `perf/run.ts`: it walks a directory and shells out to a bundler. The one
 * decision in it — what belongs in the precache and what version that makes — is
 * `src/offline/precache.ts`, which is pure and tested.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { planPrecache } from "../src/offline/precache.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(WEB, "dist");

/** Every file under `dir`, recursively, relative to it and with `/` separators. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

if (!statSync(DIST, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`${DIST} is missing — the service worker is built from the application build.`);
}

const plan = planPrecache(walk(DIST));

await build({
  root: WEB,
  // why: no plugins, and `configFile: false`. The application's config carries the Svelte
  // plugin and a `manifest: true` that would overwrite the one the perf harness reads.
  configFile: false,
  define: { __PRECACHE__: JSON.stringify(plan) },
  build: {
    outDir: "dist",
    // The application build is the one that owns this directory. Emptying it here would
    // delete everything the worker was just told to cache.
    emptyOutDir: false,
    // A classic service worker: one file, no imports, no hash in the name.
    lib: {
      entry: join(WEB, "src", "offline", "sw.ts"),
      formats: ["iife"],
      name: "memberberryServiceWorker",
      fileName: () => "sw.js",
    },
  },
});

process.stdout.write(`service worker: ${plan.urls.length} precached URLs, version ${plan.version}\n`);
