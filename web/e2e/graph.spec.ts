/**
 * The local graph in a real browser (`SPEC.md` §9.4).
 *
 * What only a browser can say. The component tests drive an injected loader and a jsdom
 * tree, and jsdom applies no stylesheet — so a panel with `display: none`, a `viewBox` that
 * collapses to nothing, or an SVG whose nodes have zero size all pass the unit suite while
 * the picture is not on screen. These assert the picture is **visible and has area**, and
 * that the whole path works end to end: the SQLite index the server built at startup,
 * through the HTTP route, to a dot a reader can click and land on the note it names.
 */

import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PANEL = ".graph-panel";
const CANVAS = ".graph-canvas";
const NODE = ".graph-node";
// What a pointer actually lands on. Not the group — its own centre falls in the gap between
// the dot and the label above it, where the canvas takes the click — and not the dot either:
// a *ghost* is drawn `fill: none`, so its interior is unpainted and takes no pointer events
// at all. The transparent hit circle is the element a person's finger hits, which makes it
// the element a test should click.
const HIT = `${NODE} .graph-hit`;

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

test("draws the note and its neighbours, with room on screen to see them", async ({ page }) => {
  await openWithContext(page, "Projects/Roadmap.md");

  // `toBeVisible` on the panel would pass with the picture collapsed to nothing — the
  // heading and the hop control give the panel its height. The canvas is what has to have
  // area, and this is the assertion the embed panel's first version got wrong (§22.6).
  const canvas = page.locator(CANVAS);
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(80);
  expect(box?.height ?? 0).toBeGreaterThan(80);

  // Two notes link to `Projects/Roadmap.md` (`Links/Planning.md` and `Links/Notes.md`), so
  // a one-hop picture is those two plus the note itself.
  await expect(page.locator(NODE)).toHaveCount(3);
  await expect(page.locator(`${NODE}.is-origin`)).toHaveCount(1);
  await expect(canvas).toContainText("Quarter planning");
  await expect(canvas).toContainText("Loose notes");

  // A node is a dot with a real radius; a circle of radius 0 is a picture of nothing.
  const dot = await page.locator(`${NODE}.is-origin .graph-dot`).boundingBox();
  expect(await page.locator(HIT).count()).toBe(3);
  expect(dot?.width ?? 0).toBeGreaterThan(1);
});

test("clicking a node opens the note it names", async ({ page }) => {
  await openWithContext(page, "Projects/Roadmap.md");

  await page
    .locator(NODE)
    .filter({ hasText: "Quarter planning" })
    .locator(".graph-hit")
    .click();
  await expect(page.locator(EDITOR).first()).toContainText("We should ship");
});

test("widening the walk brings in a note two links away", async ({ page }) => {
  // `Graph/Hub.md` links to `Graph/Near.md`, which links to `Graph/Far.md`. One hop is the
  // hub, its neighbour and the ghost; the second hop reaches `Far`, which no one-hop picture
  // can show. The fixtures are in a folder of their own precisely so this arithmetic does
  // not change the next time a note is added somewhere else.
  await openWithContext(page, "Graph/Hub.md");
  await expect(page.locator(NODE)).toHaveCount(3);
  await expect(page.locator(CANVAS)).not.toContainText("Graph far");

  await page.getByRole("radio", { name: "2 links away" }).click();
  await expect(page.getByRole("radio", { name: "2 links away" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator(NODE)).toHaveCount(4);
  await expect(page.locator(CANVAS)).toContainText("Graph far");
});

test("a ghost is drawn for a link to a note that is not there", async ({ page }) => {
  // §6.5: a note that does not exist and one this reader may not see are the same state, so
  // the picture shows one shape for both. `Graph/Missing` is never written.
  await openWithContext(page, "Graph/Hub.md");
  const ghost = page.locator(`${NODE}.is-ghost`);
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toContainText("Graph/Missing");
  // A ghost is not a note, so activating it must not navigate anywhere or ask for anything.
  await ghost.locator(".graph-hit").click();
  await expect(page.locator(EDITOR).first()).toContainText("Graph hub");
});

test("the picture is reachable and operable from the keyboard", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  await openWithContext(page, "Projects/Roadmap.md");

  // §8.4: one tab stop for the whole picture, arrows to move, Enter to open — the same
  // shape as the note tree and the tag pane. A picture that only a pointer can use does
  // not ship.
  const canvas = page.locator(CANVAS);
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveAttribute("aria-activedescendant", "graph-node-0");
  await page.keyboard.press("ArrowDown");
  await expect(canvas).toHaveAttribute("aria-activedescendant", "graph-node-1");
  await page.keyboard.press("Enter");
  // Node 1 is the first neighbour by key: `Links/Notes.md`, titled "Loose notes".
  await expect(page.locator(EDITOR).first()).toContainText("See also");
});

test("says nothing is near a note that nothing links to", async ({ page }) => {
  // The state that has to be distinguishable from a broken panel: an honest empty answer.
  await openWithContext(page, "Welcome.md");
  await expect(page.locator(PANEL)).toContainText("Nothing links to or from this note yet.");
  await expect(page.locator(NODE)).toHaveCount(0);
});

test("the picture follows the note in front", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the mobile layout has no second tab (§8.3)");
  await openWithContext(page, "Welcome.md");
  await expect(page.locator(PANEL)).toContainText("Nothing links to or from this note yet.");

  await page.keyboard.press("ControlOrMeta+O");
  const switcher = page.getByRole("dialog", { name: "Open a note" });
  await expect(switcher).toBeVisible();
  await page.keyboard.type("roadmap");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${NODE}.is-origin`)).toHaveCount(1);
  await expect(page.locator(CANVAS)).toContainText("Quarter planning");
});
