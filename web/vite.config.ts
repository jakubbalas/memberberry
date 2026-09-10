import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, type Plugin } from "vite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function excalidrawFonts(): Plugin {
  const fonts = join(process.cwd(), "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  return {
    name: "memberberry-excalidraw-fonts",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        output.code = output.code.replace(
          "https://esm.sh/${`${Ze.PKG_NAME}@${Ze.PKG_VERSION}`}/dist/prod/",
          "${window.location.origin}/assets/excalidraw/",
        );
      }
      const visit = (directory: string, relative = ""): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          const assetPath = join(relative, entry.name);
          if (entry.isDirectory()) visit(path, assetPath);
          else if (entry.name.endsWith(".woff2")) {
            this.emitFile({ type: "asset", fileName: `assets/excalidraw/fonts/${assetPath}`, source: readFileSync(path) });
          }
        }
      };
      visit(fonts);
    },
  };
}

// AGENTS.md §5.1 reserves 9011 for the frontend when it runs separately from the server on
// 9010. `strictPort` so a clash fails loudly instead of silently moving — a moved port is a
// confusing five minutes when the server's links stop matching.
export default defineConfig({
  plugins: [svelte(), excalidrawFonts()],

  // why: the manifest is what tells the performance harness which chunks a first visit
  // actually downloads. §21.2 budgets the *initial* JS, and from M8's graph onwards not every
  // chunk is initial — see `perf/bundle.ts`.
  build: { manifest: true },
  server: { port: 9011, strictPort: true },
  preview: { port: 9011, strictPort: true },

  // why: under Vitest, Svelte must resolve to its client build. Without this, `mount()` gets
  // the server entry and throws `lifecycle_function_unavailable` — the components render into
  // jsdom, which is a browser even though the runner is Node. Scoped to the test run so the
  // production build keeps resolving normally.
  ...(process.env["VITEST"] === undefined ? {} : { resolve: { conditions: ["browser"] } }),

  test: {
    environment: "node",
    // why: `e2e/` holds Playwright specs. Vitest's default glob would collect them, and they
    // fail confusingly out of a Playwright runner rather than reporting they were misrun.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // `.svelte` is included on purpose. AGENTS.md §4.4 keeps components presentational and
      // logic in plain `.ts`, which only holds if an untested component shows up as a hole
      // rather than as nothing at all.
      include: ["src/**/*.ts", "src/**/*.svelte", "perf/**/*.ts", "scripts/**/*.ts"],
      // `main.ts` is the entry shim that wires the DOM to the modules below it, the same
      // role `mb-cli/src/main.rs` plays; `src/wasm` is generated.
      //
      // `perf/` is included so the harness's arithmetic — the part that decides whether the
      // build fails — carries a floor like anything else. Three are excluded: `run.ts` is
      // the same kind of entry shim as `main.ts`, and `measure.ts` and `server.ts` are the
      // browser and process boundaries, exercised by `make perf` itself rather than by
      // vitest. Mocking a browser to cover them would test the mock (AGENTS.md §2.3).
      exclude: [
        "src/wasm/**",
        "src/main.ts",
        // The WebGL renderer and the worker's `onmessage`, for the reason `measure.ts` below
        // is excluded: both are boundaries rather than decisions. jsdom has no WebGL and no
        // worker scope, and a mock of either would test the mock (AGENTS.md §2.3). What
        // exercises them is `make e2e`, which reads the rendered pixels back out of the
        // canvas — see `web/e2e/global-graph.spec.ts`.
        "src/shell/graph-gl.ts",
        "src/shell/graph-worker.ts",
        // The service worker's event handlers, for the same reason: jsdom has no
        // `ServiceWorkerGlobalScope`, no `caches` and no `fetch` event. Everything that
        // decides anything was moved into `src/offline/{precache,routing,offline-page}.ts`
        // before this line was written, and all three are tested. What exercises this one is
        // `make e2e`, which disconnects a real browser (`web/e2e/offline.spec.ts`).
        "src/offline/sw.ts",
        // Reads a directory and shells out to a bundler; the one decision in it is
        // `planPrecache`, which is covered above. The same boundary `perf/run.ts` is.
        "scripts/build-sw.ts",
        // Like the service-worker builder: a filesystem/bundler boundary. Its integration
        // test executes the real build and verifies both directly loadable packages.
        "scripts/build-clipper.ts",
        "perf/run.ts",
        "perf/measure.ts",
        "perf/server.ts",
      ],
    },
  },
});
