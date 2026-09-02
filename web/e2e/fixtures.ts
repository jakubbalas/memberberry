/**
 * Shared E2E fixtures.
 *
 * The important one is `failures`, which is automatic: **every** test fails if the browser
 * logged an error, threw, or received a response ≥ 400. That is the generalised form of both
 * M5 browser bugs — one was a wall of 404s, the other a CSP violation the console reported
 * and nothing read. Neither needed a clever assertion to catch, only something that looked.
 *
 * A test that legitimately expects a bad response says so with `failures.allow(...)`, which
 * is deliberately more effort than ignoring it.
 */

import { test as base, expect, type Page } from "@playwright/test";

// `environment.ts` is the single source of truth for what the E2E server contains, so the
// credentials and note paths asserted here cannot drift from what was provisioned. It is a
// separate module from `serve.ts` because importing that one would start a second server.
import { E2E_NOTES, E2E_USER } from "./environment.js";

export { E2E_NOTES, E2E_USER };

export interface Failures {
  /** Permit responses or console messages matching `pattern` for the rest of this test. */
  allow(pattern: RegExp): void;
}

export const test = base.extend<{ failures: Failures }>({
  failures: [
    async ({ page }, use) => {
      const allowed: RegExp[] = [];
      const problems: string[] = [];
      const record = (message: string): void => {
        problems.push(message);
      };

      page.on("console", (message) => {
        if (message.type() === "error") record(`console error: ${message.text()}`);
      });
      page.on("pageerror", (error) => record(`uncaught exception: ${error.message}`));
      page.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText ?? "no reason given";
        // why: an abort is not a failure of the application. It means the page navigated or
        // closed while a request was in flight — which is exactly what happens to the
        // debounced layout save on every `page.goto`. Recording it would mean every test
        // that navigates twice has to allow it, and an allowlist everyone copies is not a
        // check. Every *other* failure, and every response >= 400, still counts.
        if (reason.includes("net::ERR_ABORTED")) return;
        record(`request failed: ${request.method()} ${request.url()} — ${reason}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400) record(`HTTP ${response.status()} ${response.url()}`);
      });

      await use({
        allow(pattern: RegExp): void {
          allowed.push(pattern);
        },
      });

      const unexpected = problems.filter((p) => !allowed.some((pattern) => pattern.test(p)));
      expect(unexpected, "the browser reported problems this test did not allow").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Signs in as the provisioned owner and waits for the authenticated root.
 *
 * Drives the real form rather than forging a session cookie: submitting that form is
 * precisely what a CSP `form-action` mistake breaks, so a shortcut here would delete the
 * regression test for the M5 login bug.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Username" }).fill(E2E_USER.username);
  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
}

/** The resolved value of a CSS custom property on an element. */
export async function tokenValue(page: Page, selector: string, token: string): Promise<string> {
  return page.locator(selector).evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name).trim(),
    token,
  );
}
