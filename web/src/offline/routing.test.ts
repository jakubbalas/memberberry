/**
 * Which requests the service worker answers (`SPEC.md` §7.4).
 *
 * The case that matters most is the one asserting `/api/` is never cached: a permission
 * filter is applied per request for the user who asked (§6.4), and a cached answer is that
 * filter replayed after it changed.
 */

import { describe, expect, it } from "vitest";

import { offlineFallbackFor, strategyFor } from "./routing.js";

const ORIGIN = "https://notes.example";
const CONTEXT = {
  origin: ORIGIN,
  precached: new Set(["/assets/index-abc.js", "/app.html"]),
};

function request(url: string, overrides: { method?: string; mode?: string } = {}) {
  return { url, method: overrides.method ?? "GET", mode: overrides.mode ?? "cors" };
}

describe("choosing a strategy", () => {
  it("serves a precached asset from the cache", () => {
    expect(strategyFor(request(`${ORIGIN}/assets/index-abc.js`), CONTEXT)).toBe("cache-first");
  });

  it("passes an asset this build never cached to the network", () => {
    expect(strategyFor(request(`${ORIGIN}/assets/from-an-older-build.js`), CONTEXT)).toBe("network-only");
  });

  it("handles a page load itself", () => {
    expect(strategyFor(request(`${ORIGIN}/v/personal/Note.md`, { mode: "navigate" }), CONTEXT)).toBe("navigate");
  });

  it("never caches an API response", () => {
    // The invisibility rule (§6.5) is enforced per request, per user. A cached graph or note
    // index is a filtered answer that outlives its filter.
    for (const path of ["/api/v1/vaults", "/api/v1/vaults/personal/graph", "/api/v1/sync"]) {
      expect(strategyFor(request(`${ORIGIN}${path}`), CONTEXT)).toBe("network-only");
    }
  });

  it("leaves a write alone", () => {
    expect(strategyFor(request(`${ORIGIN}/app.html`, { method: "POST" }), CONTEXT)).toBe("network-only");
  });

  it("leaves another origin alone even when the path matches", () => {
    expect(strategyFor(request("https://elsewhere.example/assets/index-abc.js"), CONTEXT)).toBe("network-only");
  });

  it("passes a URL it cannot parse to the network rather than guessing", () => {
    expect(strategyFor(request("not a url"), CONTEXT)).toBe("network-only");
  });

  it("ignores a query string, which is not part of a precached path", () => {
    // The cache is keyed by the URL the install stored, so `?v=2` is a different request and
    // the network is the honest answer for it.
    expect(strategyFor(request(`${ORIGIN}/assets/index-abc.js?v=2`), CONTEXT)).toBe("cache-first");
  });
});

describe("falling back when the network is gone", () => {
  it("gives a note URL the application shell", () => {
    expect(offlineFallbackFor("/v/personal/Projects/Roadmap.md")).toBe("shell");
  });

  it("gives the vault list and the sign-in page the offline page", () => {
    // Both are server-rendered, and neither has an offline form. Handing them the shell
    // would render an editor over a URL that has never been one.
    expect(offlineFallbackFor("/")).toBe("offline-page");
    expect(offlineFallbackFor("/login")).toBe("offline-page");
  });

  it("gives a vault root the offline page, because it names no note", () => {
    expect(offlineFallbackFor("/v/personal")).toBe("offline-page");
    expect(offlineFallbackFor("/v/personal/")).toBe("offline-page");
  });
});
