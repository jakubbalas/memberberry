/**
 * The backlinks panel in a real browser (`SPEC.md` §9.5).
 *
 * What only a browser can say: that the panel is *reachable* — on desktop it is a column
 * beside the note, on mobile a drawer that has to be opened — and that the whole path works
 * end to end, from the SQLite index the server built at startup through the HTTP route to a
 * row a reader can click. The component tests drive an injected loader and a jsdom tree;
 * neither of those can fail the way a wrong route or a cold index fails.
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANEL = ".backlinks-panel";

/** Opens a note and makes sure the Context sidebar holding the panel is showing. */
async function openWithContext(
  page: import("@playwright/test").Page,
  note: string,
): Promise<void> {
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();
  // §8.3: below the breakpoint the sidebars are drawers and start closed, so the panel has
  // to be opened. Above it they start open and this is a no-op.
  const toggle = page.getByRole("button", { name: /^Show Context$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator(PANEL)).toBeVisible();
}

test("lists the notes that link here, with the block each link sits in", async ({ page }) => {
  await openWithContext(page, "Projects/Roadmap.md");

  const rows = page.locator(".backlink-row");
  await expect(rows).toHaveCount(2);
  // Ordered by source path, so `Links/Notes.md` comes before `Links/Planning.md`.
  await expect(rows.nth(0)).toContainText("Loose notes");
  await expect(rows.nth(1)).toContainText("Quarter planning");
  await expect(page.locator(".backlink-text").nth(1)).toContainText(
    "We should ship Roadmap this quarter.",
  );
  // The anchor the link pointed at travels too, so a reader can see which part was meant.
  await expect(page.locator(".backlink-badge")).toContainText("#Goals");
});

test("opening a backlink row opens that note", async ({ page }) => {
  await openWithContext(page, "Projects/Roadmap.md");

  await page.locator(".backlink-row").filter({ hasText: "Quarter planning" }).click();
  await expect(page.locator(EDITOR).first()).toContainText("We should ship");
});

test("a backlink row is reachable and operable from the keyboard", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  await openWithContext(page, "Projects/Roadmap.md");

  const row = page.locator(".backlink-row").filter({ hasText: "Quarter planning" });
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(EDITOR).first()).toContainText("We should ship");
});

test("says nothing links here for a note nothing links to", async ({ page }) => {
  // The state that has to be distinguishable from a broken panel: an honest empty answer.
  await openWithContext(page, "Welcome.md");
  await expect(page.locator(PANEL)).toContainText("Nothing links here yet.");
  await expect(page.locator(".backlink-row")).toHaveCount(0);
});

test("the panel follows the note in front", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the mobile layout has no second tab (§8.3)");
  await openWithContext(page, "Welcome.md");
  await expect(page.locator(PANEL)).toContainText("Nothing links here yet.");

  // Open the linked-to note in a second tab and the panel has to change with it.
  await page.keyboard.press("ControlOrMeta+O");
  const switcher = page.getByRole("dialog", { name: "Open a note" });
  await expect(switcher).toBeVisible();
  await page.keyboard.type("roadmap");
  await expect(switcher.getByRole("option").first()).toContainText("Roadmap");
  await page.keyboard.press("Enter");

  await expect(page.locator(".backlink-row")).toHaveCount(2);
});
