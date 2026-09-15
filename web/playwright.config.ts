/**
 * End-to-end configuration (SPEC.md §22, §23 M7).
 *
 * This suite exists because of a specific failure. M5 shipped a bundle where every asset
 * 404'd and a login form its own CSP blocked; both passed the unit suite *and* a `curl`
 * smoke test, and both took one browser load to find. `curl` parses no HTML, runs no
 * JavaScript and enforces no CSP, so a 200 from it says nothing about whether a page works.
 * The user has stated they will not open the application until the final milestone, which
 * makes a real browser in CI the only thing that can make that claim.
 *
 * Two viewports, because SPEC.md §8 is one state model with two layouts and the mobile one
 * is the primary performance target (§21.1).
 */

import { defineConfig } from "@playwright/test";

import { E2E_ORIGIN } from "./e2e/environment.js";

export default defineConfig({
  testDir: "./e2e",
  // why: no retries. AGENTS.md §2.3 — a flaky test is a failing test, and retrying one is
  // how a race gets to stay in the suite for a year.
  retries: 0,
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] === undefined ? "list" : [["list"], ["github"], ["html", { open: "never" }]],

  use: {
    baseURL: E2E_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // why: the viewport and pointer are set explicitly rather than spread from a device
  // descriptor. `devices["Desktop Chrome"]` also sets a **Windows** user agent, so a suite
  // running on a Mac had the shell resolving `Mod` to Ctrl while `ControlOrMeta` sent Cmd —
  // every keyboard shortcut silently did nothing, and the failure looked like a broken
  // palette rather than a spoofed platform. Emulating a foreign OS while pressing the host's
  // keys is not a configuration worth having.
  projects: [
    {
      // ≥ 1024px: the desktop layout of SPEC.md §8.2.
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // < 768px: the mobile layout of SPEC.md §8.3. Pixel-7a class, which is the device
      // §21.1 writes the budgets against. `hasTouch` matters — long-press drag handles and
      // the `VisualViewport` toolbar only exist on a touch pointer.
      name: "mobile",
      use: {
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],

  webServer: {
    command: "node --disable-warning=ExperimentalWarning --experimental-strip-types e2e/serve.ts",
    url: E2E_ORIGIN,
    timeout: 60_000,
    // Reusing a server locally keeps the inner loop fast; CI always provisions its own, so a
    // green run can never depend on state a previous run left behind.
    reuseExistingServer: process.env["CI"] === undefined,
    stdout: "pipe",
    stderr: "pipe",
  },
});
