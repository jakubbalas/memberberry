/**
 * The tag pane in a real browser (`SPEC.md` §9.3).
 *
 * What only a browser can say: that the pane is reachable — a column beside the note on
 * desktop, a drawer on mobile — and that the whole path works end to end, from the tags the
 * server extracted into SQLite at startup, through the HTTP route, to a row a reader can
 * click. The component tests drive an injected loader against a jsdom tree, and jsdom applies
 * no stylesheet: a pane hidden by CSS passes every one of them (§22.6).
 *
 * The fixtures are the three notes under `Tags/` in `environment.ts`, and the counts asserted
 * here are exactly those notes.
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANE = ".tag-pane";

/** Opens the workspace with the Navigation sidebar showing, which is where the pane lives. */
async function openWithNavigation(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
  // §8.3: below the breakpoint the sidebars are drawers and start closed. Above it this is
  // a no-op.
  const toggle = page.getByRole("button", { name: /^Show Navigation$/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Tags", exact: true }).click();
  await expect(page.locator(PANE)).toBeVisible();
}

const row = (page: import("@playwright/test").Page, tag: string) =>
  page.locator(`.tag-row[data-tag="${tag}"]`);

test("shows each tag once, with the notes counted under it", async ({ page }) => {
  await openWithNavigation(page);

  // Asserted on the row itself rather than on the pane: the heading gives the pane a height,
  // so a pane whose tree is hidden still passes `toBeVisible` on the container (§22.6).
  const project = row(page, "project");
  await expect(project).toBeVisible();
  // `#Project/…` and `#project/…` are one tag with one count, shown in one of the two
  // spellings the notes use.
  await expect(project).toContainText("Project");
  await expect(project.locator(".tag-count")).toHaveText("2");
  await expect(row(page, "reading").locator(".tag-count")).toHaveText("1");
  // A nested tag is not a top-level row until its parent is opened.
  await expect(row(page, "project/memberberry")).toHaveCount(0);
});

test("opening a tag reveals the tags nested under it", async ({ page }) => {
  await openWithNavigation(page);

  await page.getByRole("button", { name: /^Expand Project$/ }).click();
  const nested = row(page, "project/memberberry");
  await expect(nested).toBeVisible();
  await expect(nested.locator(".tag-count")).toHaveText("2");

  await page.getByRole("button", { name: /^Expand memberberry$/ }).click();
  const leaf = row(page, "project/memberberry/spec");
  await expect(leaf).toBeVisible();
  await expect(leaf.locator(".tag-count")).toHaveText("1");
});

test("selecting a tag lists the notes carrying it, and a row opens one", async ({ page }) => {
  await openWithNavigation(page);

  await row(page, "project").click();
  const notes = page.locator(".tree-row.is-tagged");
  // Both notes under `#project/…`, whichever spelling each of them wrote.
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toBeVisible();
  await expect(notes.nth(0)).toContainText("Alpha");
  await expect(notes.nth(1)).toContainText("Beta");

  await notes.nth(0).click();
  await expect(page.locator(EDITOR).first()).toContainText("Alpha");
});

test("selecting a tag again puts its notes away", async ({ page }) => {
  await openWithNavigation(page);

  await row(page, "reading").click();
  await expect(page.locator(".tree-row.is-tagged")).toHaveCount(1);
  await row(page, "reading").click();
  await expect(page.locator(".tree-row.is-tagged")).toHaveCount(0);
});

test("the tag tree is navigable from the keyboard alone", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  // §8.4: no mouse-only feature ships, and one tab stop plus arrows is what the `tree` role
  // promises. Enter selects the tag rather than toggling it — a parent tag has to be
  // selectable, which is where this differs from the note tree.
  await openWithNavigation(page);
  const tree = page.getByRole("tree", { name: "Tags" });
  await tree.focus();
  await expect(tree).toBeFocused();

  await tree.press("ArrowRight");
  await expect(row(page, "project/memberberry")).toBeVisible();
  await tree.press("Enter");
  await expect(page.locator(".tree-row.is-tagged")).toHaveCount(2);
});

test("the tag pane's controls clear the 44px touch floor on mobile", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the floor is a mobile requirement (§8.3, §20.3)");
  // The twisty is a 16px glyph on the desktop scale sitting next to a row that does
  // something else entirely, so it is the control here a finger can miss into. Measured from
  // the browser's box model, because a rule in a stylesheet is not a size on screen.
  await openWithNavigation(page);
  // why: an explicit wait for a row before enumerating. `locator.all()` does not auto-wait —
  // it returns whatever exists at that instant — so without this the loop measures an
  // unpopulated pane whenever the tag fetch has not resolved yet, and the failure is a
  // confusing "the pane should offer controls to press" rather than a timeout. Seen for real
  // in a full parallel run, and passing when the same spec ran alone.
  await expect(row(page, "project")).toBeVisible();

  const measured: Array<{ label: string; width: number; height: number }> = [];
  for (const control of await page.locator("button.tag-twisty, .tag-row").all()) {
    const box = await control.boundingBox();
    if (box === null) continue;
    measured.push({
      label: (await control.getAttribute("aria-label")) ?? (await control.textContent()) ?? "",
      width: box.width,
      height: box.height,
    });
  }

  expect(measured.length, "the pane should offer controls to press").toBeGreaterThan(0);
  expect(
    measured.filter((control) => control.width < 44 || control.height < 44),
    "every visible control must be reachable by a finger",
  ).toEqual([]);
});
