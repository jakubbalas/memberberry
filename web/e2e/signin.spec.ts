/**
 * Signing in, in a real browser.
 *
 * M5 shipped a sign-in page whose own `Content-Security-Policy` set `form-action 'none'`,
 * so the browser refused to submit the only form in the application and nobody could
 * authenticate at all. Every unit test passed; a `curl` POST to `/login` passed too,
 * because `curl` enforces no CSP. This file is the check that could have caught it.
 */

import { E2E_USER, expect, signIn, test } from "./fixtures.js";

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
