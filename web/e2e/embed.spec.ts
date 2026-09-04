/**
 * Transclusion in a real browser (`SPEC.md` §9.2, §22.6, §22.7).
 *
 * What only a browser can say. The unit suite drives an injected resolver against a jsdom
 * tree, so it can prove the DOM is built and *cannot* prove a reader sees it — jsdom applies
 * no stylesheet, which is exactly how the backlinks panel passed 10/10 with
 * `display: none` on it. So every assertion here is about visibility, layout or the round
 * trip through the real route: the SQLite index the server built at startup, the ACL, the
 * slice, and back as content on the page.
 *
 * The cycle case is here for a second reason: "a cycle must never hang or crash the
 * renderer" is a statement about a running page, and only a page can be asked.
 */

import { expect, signIn, test, type Failures } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const EMBED = ".note-embed";

/**
 * Opens a note and waits for every embed on it to have settled.
 *
 * `Embeds/Host.md` deliberately references a note that is not there, so the run *will* see
 * one 404 — that is the state under test, not a broken page. A ghost reference is an
 * ordinary thing for a note to contain, and the route answers it exactly as it answers a
 * target the reader may not see (§6.5), so the 404 is the design rather than a fault.
 *
 * Two things have to be allowed for one failed request, and the second is looser than
 * anyone would like: the *response* record carries the URL and is allowed by the exact
 * reference, but the browser also logs "Failed to load resource" to the console with **no
 * URL in it**, so it can only be allowed by shape. Scoped to this spec, which is the most
 * that can be said for it.
 */
async function open(
  page: import("@playwright/test").Page,
  note: string,
  failures: Failures,
): Promise<void> {
  failures.allow(/HTTP 404 .*embed\/Embeds%2FNothing/);
  failures.allow(/console error: Failed to load resource.*404/);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();
  await expect(page.locator(`${EMBED}[data-embed-state="loading"]`)).toHaveCount(0);
}

/**
 * The embeds on `Embeds/Host.md`, by the order the note writes them in.
 *
 * Indexed rather than filtered by text, because the whole-note embed contains every string
 * the narrower ones do — `filter({ hasText: "Only this section." })` matched the whole-note
 * embed first and the section assertion passed for the wrong reason. The order is a property
 * of the fixture, which is read-only and written next to this comment, and `EMBED_COUNT`
 * fails loudly if it ever stops matching.
 */
const EMBEDS = { whole: 0, section: 1, block: 2, missing: 3 } as const;
const EMBED_COUNT = 4;

function embed(page: import("@playwright/test").Page, which: keyof typeof EMBEDS) {
  return page.locator(EMBED).nth(EMBEDS[which]);
}

test("an embed renders the target's content where the reference is", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  await expect(page.locator(EMBED)).toHaveCount(EMBED_COUNT);
  const whole = embed(page, "whole");
  await expect(whole).toHaveAttribute("data-embed-state", "content");
  // The *body*, not the container. why: this assertion was wrong once already. `toBeVisible`
  // and a measured box on the container both pass with `display: none` on the body, because
  // the bar above it still has a height — and `toContainText` never cared about visibility
  // at all. Setting `display: none` on the body is precisely the bug that shipped in the
  // backlinks panel, so it is what this test is verified against.
  const body = whole.locator(".note-embed-body");
  await expect(body).toBeVisible();
  await expect(body).toContainText("The whole note body.");
  const box = await body.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(0);
  // And it is inside the note, not appended somewhere else on the page.
  await expect(page.locator(`${EDITOR} ${EMBED}`).first()).toBeVisible();
});

test("an embed is labelled with the note it came from", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  const source = page.locator(".note-embed-source").first();
  await expect(source).toBeVisible();
  await expect(source).toHaveText("Embed target");
});

test("a heading reference embeds only that section", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  const section = embed(page, "section").locator(".note-embed-body");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Only this section.");
  await expect(section).not.toContainText("The whole note body.");
});

test("a block reference embeds only that block", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  const block = embed(page, "block").locator(".note-embed-body");
  await expect(block).toBeVisible();
  await expect(block).toContainText("Just this block.");
  await expect(block).not.toContainText("Only this section.");
  // The `^pinned` marker is the reference, not the content, and it is not shown.
  await expect(block).not.toContainText("^pinned");
});

test("an unavailable target renders a neutral placeholder that does not name it", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  // §6.5: a target the reader may not see and one that is not there are one state, so the
  // placeholder cannot name it or say which of the two this is.
  const missing = embed(page, "missing");
  await expect(missing).toHaveAttribute("data-embed-state", "unavailable");
  await expect(page.locator(`${EMBED}[data-embed-state="unavailable"]`)).toHaveCount(1);
  await expect(missing.locator(".note-embed-status")).toBeVisible();
  await expect(missing).toHaveText("Content unavailable.");
  await expect(missing).not.toContainText("Nothing At All");
});

test("a self-embed renders as a link and the page keeps working", async ({ page, failures }) => {
  await open(page, "Embeds/Cycle.md", failures);

  const cycle = page.locator(`${EMBED}[data-embed-state="cycle"]`);
  await expect(cycle).toHaveCount(1);
  const badge = cycle.locator(".note-embed-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText("circular embed");
  await expect(cycle.locator(".note-embed-link")).toBeVisible();
  // "A cycle must never hang or crash the renderer" (§9.2). One embed, not a chain of them,
  // and the editor is still responsive afterwards — which a hung page could not be. The
  // `failures` fixture is what catches a crash: any uncaught exception fails this test.
  await expect(page.locator(EMBED)).toHaveCount(1);
  await expect(page.locator(EDITOR).first()).toContainText("Cycling");
});

test("an embed collapses and expands", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  const whole = embed(page, "whole");
  const body = whole.locator(".note-embed-body");
  const toggle = whole.locator(".note-embed-toggle");
  await expect(body).toBeVisible();

  await toggle.click();
  // Hidden, measured by the browser rather than inferred from an attribute: an attribute
  // that no stylesheet acts on is the backlinks bug in the other direction.
  await expect(body).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await toggle.click();
  await expect(body).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

test("an embed's controls are reachable and operable from the keyboard", async ({ page, failures }, info) => {
  test.skip(info.project.name === "mobile", "a soft keyboard is not a keyboard (§8.4)");
  await open(page, "Embeds/Host.md", failures);

  const toggle = page.locator(".note-embed-toggle").first();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("jumping to the source opens the note the embed came from", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  await page.locator(".note-embed-source").first().click();
  await expect(page.locator(EDITOR).first()).toContainText("The whole note body.");
  // The note itself, not a copy of it inside an embed.
  await expect(page.locator(EMBED)).toHaveCount(0);
});

test("clicking a wikilink follows it", async ({ page, failures }) => {
  await open(page, "Embeds/Host.md", failures);

  await page.locator(`${EDITOR} [data-wikilink]`).first().click();
  await expect(page.locator(EDITOR).first()).toContainText("The whole note body.");
});

test("Mod-clicking a wikilink opens it in a new tab", async ({ page, failures }, info) => {
  test.skip(info.project.name === "mobile", "§8.3 has one document and no modifier keys");
  await open(page, "Embeds/Host.md", failures);

  const tabs = page.locator('[role="tab"]');
  const before = await tabs.count();
  await page.locator(`${EDITOR} [data-wikilink]`).first().click({ modifiers: ["ControlOrMeta"] });
  await expect(tabs).toHaveCount(before + 1);
  // The note the reader was on is still open, which is the difference from following it.
  await expect(tabs.filter({ hasText: "Host" })).toHaveCount(1);
});

test("Mod-Alt-clicking a wikilink opens it in a split", async ({ page, failures }, info) => {
  test.skip(info.project.name === "mobile", "§8.3 gives a phone one pane");
  await open(page, "Embeds/Host.md", failures);

  await expect(page.locator(".pane")).toHaveCount(1);
  await page
    .locator(`${EDITOR} [data-wikilink]`)
    .first()
    .click({ modifiers: ["ControlOrMeta", "Alt"] });
  await expect(page.locator(".pane")).toHaveCount(2);
});
