/**
 * The global graph in a real browser (`SPEC.md` §9.4).
 *
 * The only place this feature can be checked at all. Everything under it is unit-tested —
 * the layout, the quadtree, the camera, the filters, the keyboard — but the two things that
 * decide whether a reader sees anything are a **WebGL context**, which jsdom does not have,
 * and a **canvas with area**, which jsdom does not lay out. A suite that was green on both
 * while the picture was blank is exactly the failure §22.6 records twice already.
 *
 * So these assert on pixels: the canvas is sized, and it is not empty. Reading the drawing
 * buffer back is the one assertion that can tell "the graph rendered" from "the graph
 * mounted", and it is why `preserveDrawingBuffer` is on for the read (see `pixelsDrawn`).
 */

import { expect, signIn, test } from "./fixtures.js";

const SURFACE = ".graph-view-surface";
const GL = ".graph-view-gl";
const STATUS = ".graph-view-count";
const GRAPH = "[aria-label=\"Vault graph\"]";

/** Signs in, opens a note, and opens the graph from the command palette. */
async function openGraph(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Graph/Hub.md");
  await expect(page.locator(".editor-surface .tiptap").first()).toBeVisible();
  // `ControlOrMeta` because `Mod` is Cmd on a Mac and Ctrl elsewhere, and the suite runs
  // on both — the same reason `CommandCenter` takes its platform as a prop.
  await page.keyboard.press("ControlOrMeta+Shift+G");
  await expect(page.locator(SURFACE)).toBeVisible();
  // The layout settles asynchronously in a worker; the count is what says the payload
  // arrived, and it is the only thing here that is not a picture.
  //
  // why: a *positive* count rather than `/note/`. An empty graph renders "0 notes.", which
  // matched — so this wait passed before the payload arrived, and a keypress on a graph with
  // no nodes selects nothing. It showed up as `End` intermittently selecting nothing under a
  // full parallel run, which looks exactly like a broken keyboard path (§8.4) and was not one.
  await expect(page.locator(STATUS)).toContainText(/[1-9]\d* notes?\./);
}

/**
 * How many pixels the WebGL canvas actually painted.
 *
 * why: the whole reason this spec exists. A canvas of the right size with nothing in it
 * passes every assertion a DOM test can make, and that is precisely the bug the unit suite
 * cannot see — a shader that failed to compile, a buffer never uploaded, a camera whose
 * scale came out `NaN`. Counting non-transparent pixels is the smallest honest question:
 * *did anything get drawn*.
 */
async function pixelsDrawn(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector(selector);
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    // A second context on the same canvas would fail; read through a 2D copy instead, which
    // is what a screenshot would do and needs no flags on the original.
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (context === null) return -1;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let painted = 0;
    for (let at = 3; at < data.length; at += 4) {
      if ((data[at] ?? 0) > 8) painted += 1;
    }
    return painted;
  }, GL);
}

test("draws the vault, with area on screen and pixels in it", async ({ page }) => {
  await openGraph(page);

  const canvas = page.locator(GL);
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
  expect(box?.height ?? 0).toBeGreaterThan(200);

  // The assertion nothing below a browser can make.
  await expect
    .poll(async () => pixelsDrawn(page), {
      message: "the WebGL canvas painted nothing",
      timeout: 10_000,
    })
    .toBeGreaterThan(50);

  // …and the assertion that makes the one above mean what it says. Edges are most of the ink
  // in any graph, so "something was painted" passes with every node missing — which a probe
  // that deleted the node draw call demonstrated. With both edge kinds filtered off, anything
  // still on the canvas is a node.
  await page.locator(GRAPH).getByRole("button", { name: /^Filters/ }).click();
  await page.getByLabel("Links", { exact: true }).uncheck();
  await page.getByLabel("Embeds", { exact: true }).uncheck();
  await expect
    .poll(async () => pixelsDrawn(page), {
      message: "with the edges hidden, no node was drawn",
      timeout: 10_000,
    })
    .toBeGreaterThan(50);
});

test("says how many notes it is showing", async ({ page }) => {
  await openGraph(page);
  // The fixture vault is small, so nothing is capped and the count is a plain one. What
  // matters is that the number is the picture's rather than a placeholder.
  const status = page.locator(STATUS);
  await expect(status).toContainText(/\d+ notes\./);
});

test("opens a note when one of its dots is clicked", async ({ page }) => {
  await openGraph(page);

  // Keyboard rather than a pixel: which pixel a node lands on depends on the layout, and
  // §8.4 requires this path to work anyway. `End` rather than an arrow because it picks the
  // *last* node by key — nodes sort after ghosts, so this is always a note that can be
  // opened, where the first node in a vault with an unresolved link is a ghost and opening
  // one is deliberately nothing (§6.5).
  await page.locator(SURFACE).focus();
  await page.keyboard.press("End");
  await expect(page.locator(".graph-view-selection")).not.toContainText("Nothing selected");
  await expect(page.locator(".graph-view-selection")).not.toContainText("no note yet");
  await page.keyboard.press("Enter");

  // The graph closes and the note it named is open.
  await expect(page.locator(SURFACE)).toHaveCount(0);
  await expect(page.locator(".editor-surface .tiptap").first()).toBeVisible();
});

test("closes on Escape, leaving the workspace as it was", async ({ page }) => {
  await openGraph(page);
  await page.locator(SURFACE).focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(SURFACE)).toHaveCount(0);
  await expect(page.locator(".editor-surface .tiptap").first()).toBeVisible();
});

test("filters the picture, and says that it is filtering", async ({ page }) => {
  await openGraph(page);
  const before = await page.locator(STATUS).textContent();

  await page.locator(GRAPH).getByRole("button", { name: /^Filters/ }).click();
  await page.getByLabel("Path", { exact: true }).fill("Graph/**");

  await expect(page.getByRole("button", { name: /^Filters \(on\)/ })).toBeVisible();
  // §9.4's honesty requirement, in its second form: a picture that is hiding notes has to
  // say so, or a reader reads the gap as the shape of their vault.
  await expect(page.locator(STATUS)).toContainText(/Showing \d+ of \d+ notes\./);
  expect(await page.locator(STATUS).textContent()).not.toBe(before);
});

test("zooms without losing the picture", async ({ page }) => {
  await openGraph(page);
  await page.locator(SURFACE).focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");

  await expect
    .poll(async () => pixelsDrawn(page), { message: "zooming emptied the canvas" })
    .toBeGreaterThan(50);

  // And back to the whole vault.
  await page.keyboard.press("0");
  await expect.poll(async () => pixelsDrawn(page)).toBeGreaterThan(50);
});
