/**
 * Unlinked mentions in a real browser (`SPEC.md` §9.5).
 *
 * What only a browser can say: that the section is *visible* — a second heading and list in a
 * panel that already had one, below the links rather than replacing them — and that the whole
 * path works, from the Tantivy index the server built at startup, through the readable-set
 * clause in the query, to a row a reader can click. The component tests drive an injected
 * loader and a jsdom tree, and jsdom lays nothing out: the backlinks panel was once fully
 * green there while set to `display: none` (§22.6).
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANEL = ".backlinks-panel";
const MENTION_ROW = ".mention-row";

/** Opens a note and makes sure the Context sidebar holding the panel is showing. */
async function openWithContext(
  page: import("@playwright/test").Page,
  note: string,
): Promise<void> {
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();
  // §8.3: below the breakpoint the sidebars are drawers and start closed.
  const toggle = page.getByRole("button", { name: /^Show Context$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.locator(PANEL)).toBeVisible();
}

test("names the notes that mention this one without linking to it", async ({ page }) => {
  await openWithContext(page, "Mentions/Orchard.md");

  // `Mentions/Linked.md` says "the Orchard release" too, and is a backlink rather than a
  // mention because it also links here. One note, one list.
  await expect(page.locator(".backlink-row")).toHaveCount(1);
  await expect(page.locator(".backlink-row")).toContainText("Mentions linked");
  const rows = page.locator(MENTION_ROW);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Mentions talk");
});

test("shows every mentioning sentence, and the section has real height", async ({ page }) => {
  // why: measured rather than asserted visible. `toBeVisible` on the panel passes with the
  // mentions list at zero height, which is the mistake the embed spec made once (§22.6) —
  // the heading above the list gives the panel a box with no rows in it.
  await openWithContext(page, "Mentions/Orchard.md");

  const contexts = page.locator(".mention-list .backlink-text");
  await expect(contexts).toHaveCount(2);
  await expect(contexts.nth(0)).toHaveText("We agreed the Orchard release ships Friday.");
  await expect(contexts.nth(1)).toHaveText("The Orchard release still needs a date.");
  const box = await page.locator(".mention-list").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(0);
  expect(box?.width ?? 0).toBeGreaterThan(0);
});

test("the mentions section sits below the links section", async ({ page }) => {
  // The order is the claim: a backlink is deliberate and a mention is a coincidence of
  // words, so the deliberate one comes first. Only layout can say which is on top.
  await openWithContext(page, "Mentions/Orchard.md");

  const links = await page.locator(".backlink-list:not(.mention-list)").boundingBox();
  const mentions = await page.locator(".mention-list").boundingBox();
  expect(links).not.toBeNull();
  expect(mentions).not.toBeNull();
  expect(mentions?.y ?? 0).toBeGreaterThan(links?.y ?? 0);
});

test("opening a mention row opens that note", async ({ page }) => {
  await openWithContext(page, "Mentions/Orchard.md");

  await page.locator(MENTION_ROW).filter({ hasText: "Mentions talk" }).click();
  await expect(page.locator(EDITOR).first()).toContainText("We agreed the Orchard release");
});

test("a mention row is reachable and operable from the keyboard", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  await openWithContext(page, "Mentions/Orchard.md");

  const row = page.locator(MENTION_ROW).filter({ hasText: "Mentions talk" });
  await row.focus();
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(EDITOR).first()).toContainText("We agreed the Orchard release");
});

test("a note nothing mentions gets no mentions heading at all", async ({ page }) => {
  // Unlike "nothing links here", an empty mentions list answers a question nobody asked.
  await openWithContext(page, "Welcome.md");
  await expect(page.locator(PANEL)).toContainText("Nothing links here yet.");
  await expect(page.locator(MENTION_ROW)).toHaveCount(0);
  await expect(page.locator("#mentions-heading")).toHaveCount(0);
});
