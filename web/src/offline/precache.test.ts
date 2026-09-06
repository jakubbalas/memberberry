/**
 * What a build precaches, and when a cache is retired (`SPEC.md` §7.4).
 *
 * The version is the load-bearing part. A worker whose precache list changed but whose
 * version did not would install over the previous cache without retiring it, and a browser
 * would go on serving the assets of a build that no longer exists.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { ALWAYS, SHELL_URL, cacheName, planPrecache, staleCaches } from "./precache.js";

describe("planning a precache", () => {
  it("takes everything the build emitted under assets/", () => {
    const plan = planPrecache(["assets/index-abc.js", "assets/index-abc.css", "assets/mb_bg-x.wasm"]);
    expect(plan.urls).toContain("/assets/index-abc.js");
    expect(plan.urls).toContain("/assets/index-abc.css");
    expect(plan.urls).toContain("/assets/mb_bg-x.wasm");
  });

  it("includes the lazy chunks, unlike the bundle budget", () => {
    // §21.2 excludes a chunk behind a command because a first paint does not download it.
    // Offline is the opposite question: a graph that cannot open on a train is a feature
    // that does not work offline.
    const plan = planPrecache(["assets/index-abc.js", "assets/GlobalGraph-def.js"]);
    expect(plan.urls).toContain("/assets/GlobalGraph-def.js");
  });

  it("always carries the shell, the manifest and the icon", () => {
    expect(planPrecache([]).urls).toEqual([...ALWAYS].sort());
  });

  it("skips source maps, which are only ever fetched by devtools", () => {
    const plan = planPrecache(["assets/index-abc.js", "assets/index-abc.js.map"]);
    expect(plan.urls).not.toContain("/assets/index-abc.js.map");
  });

  it("ignores anything outside assets/, including the worker itself", () => {
    // `sw.js` is fetched by the browser, not by the page, and a worker that precached its
    // own previous copy would serve it back to the update check.
    const plan = planPrecache(["sw.js", "index.html", ".vite/manifest.json"]);
    expect(plan.urls).toEqual([...ALWAYS].sort());
  });

  it("serves the shell from a path the server answers", () => {
    expect(SHELL_URL).toBe("/app.html");
    expect(planPrecache([]).urls).toContain(SHELL_URL);
  });

  it("changes version when the file list changes", () => {
    const before = planPrecache(["assets/index-abc.js"]);
    const after = planPrecache(["assets/index-def.js"]);
    expect(after.version).not.toBe(before.version);
  });

  it("keeps the same version for the same files in a different order", () => {
    const a = planPrecache(["assets/one.js", "assets/two.js"]);
    const b = planPrecache(["assets/two.js", "assets/one.js"]);
    expect(b.version).toBe(a.version);
    expect(b.urls).toEqual(a.urls);
  });

  it("never repeats a URL, whatever the build listed twice", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { size: "large" }), (names) => {
        const files = names.map((name) => `assets/${name}`);
        const { urls } = planPrecache([...files, ...files]);
        expect(new Set(urls).size).toBe(urls.length);
      }),
    );
  });
});

describe("retiring old caches", () => {
  it("deletes this application's older caches and nothing else", () => {
    const current = cacheName("v2");
    const names = [cacheName("v1"), current, "someone-elses-cache", "images"];
    expect(staleCaches(names, current)).toEqual([cacheName("v1")]);
  });

  it("keeps the current one", () => {
    const current = cacheName("v1");
    expect(staleCaches([current], current)).toEqual([]);
  });

  it("names a cache after its version, so two builds cannot share one", () => {
    expect(cacheName("a")).not.toBe(cacheName("b"));
  });
});
