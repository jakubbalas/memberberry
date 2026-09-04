/**
 * The outline pane in a real browser (`SPEC.md` §9.5).
 *
 * What only a browser can say, and it is most of this feature: that the headings appear
 * beside the note, that a row *scrolls* it — jsdom lays nothing out, so every offset there is
 * zero and every scroll assertion would be vacuous — that the current section follows the
 * viewport, and that reordering a section rewrites the Markdown file a text editor would
 * open, which is C2.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const SCROLLER = ".note-pane";
const PANEL = ".outline-panel";

/** Read-only: the three tests below only look at it. The fourth takes its own copy. */
const SECTIONS = "Outline/Sections.md";

/** Opens a note with the Context sidebar showing, which is where the outline lives. */
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
  // why: waited for. A visible editor is not a *populated* one — the document arrives from
  // the local replica a moment later — and a test that scrolled to a heading before the
  // headings existed scrolled nowhere and then asserted on the highlight. It passed alone
  // and failed under a full parallel run, which is the definition of a flaky test
  // (`AGENTS.md` §2.3).
  await expect(page.locator(".outline-row").first()).toBeVisible();
}

test("lists the headings of the note in front", async ({ page }) => {
  await openWithContext(page, SECTIONS);

  const rows = page.locator(".outline-row");
  // Asserted on the rows rather than on the panel: the heading gives the panel a height, so
  // a panel whose tree is hidden still passes `toBeVisible` on the container (§22.6).
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toBeVisible();
  await expect(rows.nth(0)).toContainText("Outline scratch");
  await expect(rows.nth(1)).toContainText("Alpha");
  await expect(rows.nth(2)).toContainText("Alpha detail");
  await expect(rows.nth(3)).toContainText("Beta");
  // The level is what indents a row, and what a screen reader reads out.
  await expect(rows.nth(2)).toHaveAttribute("aria-level", "3");
});

test("a row scrolls the note to its heading", async ({ page }) => {
  await openWithContext(page, SECTIONS);
  const surface = page.locator(SCROLLER).first();
  expect(await surface.evaluate((element) => element.scrollTop)).toBe(0);

  await page.locator(".outline-row").filter({ hasText: "Beta" }).click();

  await expect
    .poll(async () => surface.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  // And the heading it scrolled to is the one at the top of the viewport.
  //
  // why: polled rather than read once. The pane is rebuilt whenever its tab changes
  // (`NotePane.svelte`), including when the restored layout arrives from the server a moment
  // after the note does, so a single read can land in the gap where the editor is being
  // remounted and see no heading at all. That is a flaky test, and a flaky test is a failing
  // one (`AGENTS.md` §2.3).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const scroller = document.querySelector(".note-pane");
          const heading = [...document.querySelectorAll(".note-pane h2")].find(
            (element) => element.textContent?.trim() === "Beta",
          );
          if (scroller === null || heading === undefined) return Number.NaN;
          return Math.abs(
            heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          );
        }),
      { timeout: 10_000, intervals: [200] },
    )
    .toBeLessThan(8);
});

test("the current section follows the scroll", async ({ page }) => {
  await openWithContext(page, SECTIONS);
  const current = page.locator('.outline-row[data-current="true"]');

  // Nothing is current at the top of a note, and that is a real state rather than a default:
  // the first heading is below the control strip, so the reader is not in a section yet.
  await expect(current).toHaveCount(0);

  // Scrolled by hand rather than through the pane, because the claim is that the highlight
  // follows *the viewport* — a wheel, a drag, a keyboard scroll — and not merely that the
  // pane agrees with the scroll it asked for itself. Polled for the reason above: the pane
  // can be rebuilt underneath, and the scroll is reapplied rather than assumed to have stuck.
  const scroller = page.locator(SCROLLER).first();
  await expect
    .poll(
      async () => {
        await scroller.evaluate((element) => {
          const beta = [...element.querySelectorAll("h2")].find(
            (heading) => heading.textContent?.trim() === "Beta",
          );
          if (beta === undefined) return;
          element.scrollTop =
            beta.getBoundingClientRect().top -
            element.getBoundingClientRect().top +
            element.scrollTop;
        });
        return current.textContent().catch(() => null);
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toContain("Beta");
});

test("Alt and an arrow move a section, and the file on disk moves with it", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  // §9.5: reordering sections "moves the underlying blocks". C2 says the blocks are lines in
  // a Markdown file, so that is what this asserts — not the panel, which would only prove the
  // panel agrees with itself. Its own scratch note, because it rewrites one.
  const note = scratchNote("outline", info.project.name);
  await openWithContext(page, note);

  const tree = page.getByRole("tree", { name: "Outline" });
  await tree.focus();
  // Down to `Alpha`, then move it past `Beta`. `Alpha` owns `Alpha detail`, so both travel —
  // and "down" means past the next *sibling*, not into the subsection going with it.
  await tree.press("ArrowDown");
  await tree.press("Alt+ArrowDown");

  await expect(page.locator(".outline-row").nth(1)).toContainText("Beta");

  const path = join(E2E_VAULT, ...note.split("/"));
  // Both indexes from one read: comparing against a value captured before the save would be
  // comparing the new file with the old one's layout.
  await expect
    .poll(
      () => {
        const saved = readFileSync(path, "utf8");
        return saved.indexOf("## Beta") < saved.indexOf("## Alpha");
      },
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);

  const markdown = readFileSync(path, "utf8");
  // The subsection travelled with its parent, and the front matter stayed above everything.
  expect(markdown.indexOf("### Alpha detail")).toBeGreaterThan(markdown.indexOf("## Alpha"));
  expect(markdown.indexOf("Front matter")).toBeLessThan(markdown.indexOf("## Beta"));
  // Levels are the user's: moving a section does not promote or demote it.
  expect(markdown).toContain("## Alpha\n");
  expect(markdown).toContain("### Alpha detail\n");
});
