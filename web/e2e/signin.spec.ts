/**
 * Signing in, in a real browser.
 *
 * M5 shipped a sign-in page whose own `Content-Security-Policy` set `form-action 'none'`,
 * so the browser refused to submit the only form in the application and nobody could
 * authenticate at all. Every unit test passed; a `curl` POST to `/login` passed too,
 * because `curl` enforces no CSP. This file is the check that could have caught it.
 */

import type { Page } from "@playwright/test";

import { E2E_USER, expect, signIn, test } from "./fixtures.js";

/** The vertical gap between the bottom of a label and the top of the input it names. */
async function labelToInputGap(page: Page, name: string): Promise<number> {
  const label = page.locator("label", { hasText: new RegExp(`^${name}$`) });
  const input = page.getByLabel(name);
  const labelBox = await label.boundingBox();
  const inputBox = await input.boundingBox();
  if (labelBox === null || inputBox === null) {
    throw new Error(`${name}: the label or its input is not laid out at all`);
  }
  return inputBox.y - (labelBox.y + labelBox.height);
}

test("the sign-in form can actually be submitted", async ({ page }) => {
  // `signIn` clicks the real submit button and waits for the authenticated root. A CSP that
  // blocks `form-action` fails here and nowhere else in the suite.
  await signIn(page);
  await expect(page.getByRole("link", { name: "Personal" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Log out" })).toBeVisible();
});

test("an authenticated visitor can log out", async ({ page, failures }) => {
  // why: an allowance, which `fixtures.ts` deliberately makes more effort than ignoring.
  // Revoking the session is what this test *does*, and the panel requests the shell already
  // had in flight when it happened come back refused — with a 404 rather than a 401, because
  // an unauthenticated caller is told nothing about whether a vault exists (§6.4). The
  // browser logs each one. Scoped to this vault's authenticated API: a refused *page*, or a
  // 404 for an asset, still fails here, because every response >= 400 is recorded with its
  // URL and only these are allowed. The matching console line carries no URL to scope by.
  failures.allow(/HTTP 404 .*\/api\/v1\/vaults\/personal\//);
  failures.allow(/console error: Failed to load resource: .* 404 /);
  // And the sync socket, for the same reason: it reconnects, the server refuses the
  // credentials this test just destroyed, and the browser logs it. Scoped to an
  // *authentication* failure on the sync route — a socket that drops for any other reason,
  // or on any other route, still fails here.
  failures.allow(
    /WebSocket connection to 'ws:\/\/[^']*\/api\/v1\/sync' failed: HTTP Authentication failed/,
  );
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  const navigationToggle = page.getByRole("button", { name: /Navigation/ });
  if (await navigationToggle.getAttribute("aria-expanded") === "false") {
    await navigationToggle.click();
  }
  await expect(page.getByRole("link", { name: "Log out" })).toBeVisible();

  await page.getByRole("link", { name: "Log out" }).click();

  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Username" })).toBeVisible();
});

test("an anonymous visitor is offered the form rather than any vault", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The invisibility rule (SPEC §6.5): not "access denied to Personal" — no mention of it.
  await expect(page.getByText("Personal")).toHaveCount(0);
});

test("a wrong password is refused and grants nothing", async ({ page, failures }) => {
  // The refusals are the point of the test, so they are allowed explicitly rather than
  // silently tolerated: 401 for the bad password, 404 for the note that must stay invisible.
  // Chromium reports each twice — once as a response, once as a console error — so the
  // pattern matches the code rather than either message's wording.
  failures.allow(/\b40[14]\b/);

  await page.goto("/");
  await page.getByRole("textbox", { name: "Username" }).fill(E2E_USER.username);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Invalid username or password.")).toBeVisible();
  // Still anonymous: the note the owner can read must remain invisible.
  const response = await page.goto("/v/personal/Welcome.md");
  expect(response?.status()).toBe(404);
});

test("each label sits above its input with space between them", async ({ page }) => {
  // The user's report on M7: "no padding between fields and labels". The label and input
  // were siblings inside one inline `<label>`, so they sat on the same line touching each
  // other. Only a browser can say whether the fix is painted — a string assertion on the
  // stylesheet cannot see layout, and neither can `curl` (AGENTS.md §2.3).
  await page.goto("/");

  for (const field of ["Username", "Password"]) {
    // --space-3 is 0.375rem = 6px. Asserted as a floor rather than an equality: this test
    // is about the gap existing, and pinning it here would make every spacing tweak a
    // two-file change for no gain.
    expect(await labelToInputGap(page, field), `${field}: label and input are touching`)
      .toBeGreaterThanOrEqual(4);
  }
});

test("every sign-in control clears the touch-target floor", async ({ page }) => {
  // SPEC §20.3 and §8.3: 44px for anything a finger has to hit. The sign-in page is the one
  // page every user must get through, and it is served to phones as well as laptops.
  await page.goto("/");

  for (const control of [
    page.getByRole("textbox", { name: "Username" }),
    page.getByLabel("Password"),
    page.getByRole("button", { name: "Sign in" }),
  ]) {
    const box = await control.boundingBox();
    expect(box, "the control is not laid out").not.toBeNull();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("a wrong password can be corrected without leaving the page", async ({ page, failures }) => {
  // Two failures at once if this breaks. The refusal used to render a message and no form,
  // so there was nothing to retry; and a refusal page carrying the note pages'
  // `form-action 'none'` would render the form and have the browser refuse to submit it —
  // the exact shape of the M5 outage, one page further in.
  failures.allow(/\b401\b/);

  await page.goto("/");
  await page.getByRole("textbox", { name: "Username" }).fill(E2E_USER.username);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("alert")).toHaveText("Invalid username or password.");
  // The username survived, so only the password has to be retyped.
  await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue(E2E_USER.username);

  await page.getByLabel("Password").fill(E2E_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Vaults" })).toBeVisible();
});
