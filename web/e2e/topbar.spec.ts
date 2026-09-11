/**
 * The workspace top bar, in a real browser (`SPEC.md` §8.2).
 *
 * `TopBar.dom.test.ts` covers what the controls are wired to. Everything here is a claim
 * about *layout*, which jsdom has no engine for and which is where this shell's chrome has
 * gone wrong before:
 *
 * - A bar added to a `100dvh` grid without a row for it makes the page scroll (§22.6).
 * - A bar that floats over the content covers the first tab and silently eats taps meant
 *   for it — the exact bug §8.2 records from the mobile drawers.
 * - A panel that overlays the bar hides the toggle that closes it again, which on a phone
 *   with no keyboard is a dead end.
 *
 * None of those is visible to a unit test, and each of them is a shell nobody can use.
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

async function openWorkspace(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
}

test("spans the window at the top, above the panels and the document", async ({ page }) => {
  await openWorkspace(page);

  const viewport = page.viewportSize();
  const bar = await page.locator(".topbar").boundingBox();
  expect(bar?.y ?? -1).toBe(0);
  expect(bar?.width ?? 0).toBeCloseTo(viewport?.width ?? 0, -1);
  // Thin, and the same height the contract says (§20.1's `--topbar-height`).
  expect(bar?.height ?? 0).toBeCloseTo(44, 0);

  // Everything else starts below it. A bar that overlaps the pane is the §8.2 bug where
  // chrome swallows the click meant for the first tab.
  const main = await page.locator(".workspace-main").boundingBox();
  expect(main?.y ?? 0).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0) - 1);

  // And the page still does not scroll: the bar is a grid row, not an extra element on top
  // of a full-height layout.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow, "the page itself must not scroll").toBeLessThanOrEqual(1);
});

test("toggles each panel from the bar, and the control to reopen it stays on screen", async ({ page }) => {
  await openWorkspace(page);

  for (const [side, label] of [
    ["left", "Navigation"],
    ["right", "Context"],
  ] as const) {
    const panel = page.getByRole("complementary", { name: label, exact: true });
    const hide = page.getByRole("button", { name: `Hide ${label}`, exact: true });
    const show = page.getByRole("button", { name: `Show ${label}`, exact: true });

    // On a phone the panels start closed (§8.3), so open before closing.
    if (await show.isVisible()) {
      await show.click();
      await expect(panel).toBeVisible();
    }
    await expect(hide).toBeVisible();
    await hide.click();

    await expect(panel).toBeHidden();
    // The one that brings it back is in the bar, has a box, and is not the panel's child.
    const box = await show.boundingBox();
    expect(box?.width ?? 0, `${side} toggle must still be clickable`).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(28);
    await show.click();
    await expect(panel).toBeVisible();
  }
});

test("closing both panels gives the document the whole width", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the panels are drawers over the document (§8.3)");
  await openWorkspace(page);

  const before = await page.locator(".note-pane").first().boundingBox();
  await page.getByRole("button", { name: "Hide Navigation", exact: true }).click();
  await page.getByRole("button", { name: "Hide Context", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Navigation", exact: true })).toBeHidden();

  const after = await page.locator(".note-pane").first().boundingBox();
  // A collapsed panel must give its width back rather than leaving a dead strip — the
  // toggles used to be that strip, which is why they are in the bar now.
  expect(after?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 100);
  expect(after?.width ?? 0).toBeCloseTo(page.viewportSize()?.width ?? 0, -1);
});

test("quick find opens the switcher and lands on the note it chooses", async ({ page }, info) => {
  await openWorkspace(page);

  const find = page.getByRole("button", { name: /Quick find/ });
  await expect(find).toBeVisible();
  const box = await find.boundingBox();
  expect(box?.height ?? 0, "§8.3's floor applies to the bar's controls").toBeGreaterThanOrEqual(
    info.project.name === "mobile" ? 44 : 28,
  );

  await find.click();
  const palette = page.getByRole("dialog", { name: "Open a note" });
  await expect(palette).toBeVisible();
  await page.getByRole("combobox", { name: "Open a note" }).fill("roadmap");
  await page.keyboard.press("Enter");

  await expect(page.locator(EDITOR).first()).toContainText("Roadmap");
});

test("the appearance control repaints the shell and the document together", async ({ page }) => {
  await openWorkspace(page);

  // The bar is chrome and the note is the document, and they take their colours from two
  // different tokens. A theme that only reached one of them is the failure this catches —
  // which is exactly what happened while the control was a card inside a panel that could
  // be closed.
  const selector = page.getByRole("combobox", { name: /^Theme/ });
  await selector.selectOption("memberberry-pastel");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "memberberry-pastel");
  await expect(page.locator(".topbar")).toHaveCSS("background-color", "rgb(24, 24, 37)");
  await expect(page.locator(".editor-panel").first()).toHaveCSS(
    "background-color",
    "rgb(30, 30, 46)",
  );

  await selector.selectOption("memberberry-light");
  await expect(page.locator(".topbar")).toHaveCSS("background-color", "rgb(247, 247, 245)");
  await expect(page.locator(".editor-panel").first()).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});

test("the vault switcher is reachable from the bar and leads to the vault list", async ({ page }) => {
  await openWorkspace(page);

  const link = page.getByRole("link", { name: /Your vaults/ });
  await expect(link).toBeVisible();
  const box = await link.boundingBox();
  expect(box?.height ?? 0, "SPEC §8.3: 44px for anything a finger has to hit").toBeGreaterThanOrEqual(44);

  await link.click();
  await expect(page.getByRole("heading", { name: "Your vaults" })).toBeVisible();
});

test("on a phone the panels open over the document without covering the bar", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "this is the §8.3 drawer layout");
  await openWorkspace(page);

  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  await expect(show).toBeVisible();
  await show.click();

  const panel = page.getByRole("complementary", { name: "Navigation", exact: true });
  await expect(panel).toBeVisible();
  const [bar, drawer] = await Promise.all([
    page.locator(".topbar").boundingBox(),
    panel.boundingBox(),
  ]);
  // Below the bar, not over it: the control that closes the drawer is in the bar, and a
  // drawer on top of it is a drawer that cannot be closed.
  expect(drawer?.y ?? 0).toBeGreaterThanOrEqual((bar?.y ?? 0) + (bar?.height ?? 0) - 1);
  await expect(page.getByRole("button", { name: "Hide Navigation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide Navigation", exact: true }).click();
  await expect(panel).toBeHidden();
});
