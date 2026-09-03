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
