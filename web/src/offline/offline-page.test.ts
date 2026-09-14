/**
 * The page a navigation gets with no network and nothing cached for it (`SPEC.md` §7.4).
 *
 * It is synthesized by the service worker, so it inherits none of the server's headers —
 * including its `Content-Security-Policy`. That is the thing worth asserting: M5 shipped one
 * page with no policy at all and it was the one page that ran JavaScript.
 */

import { describe, expect, it } from "vitest";

import { offlinePage, offlinePageHeaders } from "./offline-page.js";

describe("the offline page", () => {
  it("says what happened", () => {
    expect(offlinePage()).toContain("You are offline");
  });

  it("links to resident notes without trusting their text as HTML", () => {
    const html = offlinePage([
      { vault: "personal", note: "Projects/Plan & ship.md", title: "<Plan>" },
    ]);
    expect(html).toContain("Notes available on this device");
    expect(html).toContain("href=\"/v/personal/Projects%2FPlan%20%26%20ship.md\"");
    expect(html).toContain("&lt;Plan&gt;");
    expect(html).not.toContain("<Plan>");
  });

  it("loads nothing at all", () => {
    // No script and no external reference, which is what makes `default-src 'none'` a policy
    // this document can actually be served under.
    const html = offlinePage();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/<img/i);
  });

  it("carries a policy of its own", () => {
    const csp = offlinePageHeaders()["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("is never stored, so it cannot outlive the outage", () => {
    expect(offlinePageHeaders()["cache-control"]).toBe("no-store");
  });

  it("declares no colour, because the token stylesheet is not loaded here", () => {
    // AGENTS.md §4.4: every colour in this project is a design token, and this document
    // cannot reach them. It declares none rather than becoming the one file with a hex code.
    expect(offlinePage()).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
