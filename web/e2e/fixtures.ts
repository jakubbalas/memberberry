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
import { E2E_NOTES, E2E_ORIGIN, E2E_USER } from "./environment.js";

export { E2E_NOTES, E2E_USER };

export interface Failures {
  /** Permit responses or console messages matching `pattern` for the rest of this test. */
  allow(pattern: RegExp): void;
}

export const test = base.extend<{ failures: Failures }>({
  failures: [
    async ({ page, browserName }, use) => {
      const allowed: RegExp[] = [];
      const problems: string[] = [];
      const webkit = browserName === "webkit";
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
        // WebKit says "cancelled" for the same thing.
        if (reason.includes("net::ERR_ABORTED")) return;
        if (webkit && reason === "cancelled") return;
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

      const unexpected = problems.filter(
        (p) => !allowed.some((pattern) => pattern.test(p)) && !(webkit && cutOff(p)),
      );
      expect(unexpected, "the browser reported problems this test did not allow").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Moves the caret, or extends the selection, to the start or end of the line.
 *
 * why: macOS WebKit follows the Mac convention, as the desktop app's WKWebView does — `Home`
 * and `End` scroll the page and leave the caret where it is, and the line keys are Cmd+← and
 * Cmd+→. Chromium, and WebKitGTK on Linux, take `Home` and `End`.
 */
export async function lineKey(page: Page, key: "Home" | "End" | "Shift+Home" | "Shift+End"): Promise<void> {
  const macWebKit = process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit";
  if (!macWebKit) {
    await page.keyboard.press(key);
    return;
  }
  const mac = {
    Home: "Meta+ArrowLeft",
    End: "Meta+ArrowRight",
    "Shift+Home": "Shift+Meta+ArrowLeft",
    "Shift+End": "Shift+Meta+ArrowRight",
  } as const;
  await page.keyboard.press(mac[key]);
}

const ORIGIN_HOST = new URL(E2E_ORIGIN).host;

/**
 * Whether WebKit's `problem` only reports a load that navigation or teardown cut off.
 *
 * why: Chromium drops a load the page abandoned; WebKit reports it, and in its own words.
 * A `fetch` cut off by navigation becomes an uncaught "…due to access control checks" — for a
 * same-origin URL that can mean nothing else, since this app makes no cross-origin request.
 * (A dynamic `import()` cut off the same way is *not* excused: the app handles a failed
 * chunk load itself, so an uncaught one is a bug.) Closing a
 * sync socket that was still connecting — an editor torn down on a tab switch — is logged
 * as an error by WebKit, in one of two wordings. Each is the same event `net::ERR_ABORTED` excuses on Chromium;
 * anything else WebKit reports still fails the test.
 */
function cutOff(problem: string): boolean {
  if (problem.startsWith("uncaught exception: ") && problem.endsWith(" due to access control checks.")) {
    return problem.includes(`${ORIGIN_HOST}/`);
  }
  return (
    problem.startsWith(`console error: WebSocket connection to 'ws://${ORIGIN_HOST}/api/v1/sync' failed:`) &&
    (problem.endsWith("WebSocket is closed before the connection is established.") ||
      problem.endsWith("Socket is not connected"))
  );
}

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

/**
 * Opens a side panel (§8.2 desktop, §8.3 mobile drawer) if it is closed.
 *
 * why: waits for the top bar's toggle in either state before deciding. The old pattern,
 * `if (await show.isVisible()) await show.click()`, checks once with no wait: right after a
 * `goto` or `reload` the shell may not have rendered the toggle yet, so the check returned
 * false, the drawer stayed shut and the next click waited 30 s for a control inside it.
 */
export async function openSidebar(page: Page, side: "Navigation" | "Context"): Promise<void> {
  const toggle = page.getByRole("button", { name: new RegExp(`^(Show|Hide) ${side}$`) });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-label")) === `Show ${side}`) await toggle.click();
  await expect(page.getByRole("button", { name: `Hide ${side}`, exact: true })).toBeVisible();
}

/** The resolved value of a CSS custom property on an element. */
export async function tokenValue(page: Page, selector: string, token: string): Promise<string> {
  return page.locator(selector).evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name).trim(),
    token,
  );
}
