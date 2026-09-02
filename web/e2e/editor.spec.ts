/**
 * The editor, in a real browser, against a real server.
 *
 * M5 shipped a bundle where every asset 404'd, so this page rendered blank. A unit test
 * "covering" it requested the doubled path the bug required and passed — it encoded the
 * defect instead of catching it (AGENTS.md §2.3). The `failures` fixture makes that class
 * of bug impossible to miss here: any response ≥ 400 fails the test whether or not anyone
 * thought to assert on it.
 *
 * The last test is the one that matters most. C2 says the note is plain Markdown on disk and
 * that the application dying leaves the user's notes readable in a text editor. Nothing
 * proves that except typing in a browser and then opening the file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_NOTES, expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT } from "./environment.js";

/** The editor is mounted when Tiptap has taken over the surface. */
const EDITOR = ".editor-surface .tiptap";

test("opening a note loads the bundle and mounts an editable surface", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Personal" }).click();
  await page.getByRole("link", { name: "Welcome" }).click();

  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible();
  // Blank-page bugs pass a visibility check on the container. The content is what matters.
  await expect(editor).toContainText("A note that already exists");
  await expect(editor).toHaveAttribute("contenteditable", "true");
});

test("the bootstrap identifies the note without carrying its content", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");

  // The bootstrap sits on the Svelte mount element: the server fills these in before
  // sending `index.html`, and it is the only thing the client is told about the page.
  const mount = page.locator("#app");
  await expect(mount).toHaveAttribute("data-vault", "personal");
  await expect(mount).toHaveAttribute("data-note", "Welcome.md");
  await expect(mount).toHaveAttribute("data-user", "alice");

  // SPEC §3.3: body text reaches the browser over the CRDT, never inlined into the HTML.
  // Serving it both ways would make the bootstrap a second source of truth for content.
  // Checked against the HTML the server sent rather than the rendered DOM, which by now
  // holds the note because the CRDT put it there.
  const served = await page.request.get("/v/personal/Welcome.md");
  expect(await served.text()).not.toContain("A note that already exists");
});

test("typing is saved as plain Markdown in the note file", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");

  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("A note that already exists");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Typed in a browser.");

  // No sleep: poll the file until the 800ms debounce and the maintenance tick have run
  // (AGENTS.md §2.3). The assertion is on the file a text editor would open, not on
  // anything the application told us about itself.
  const path = join(E2E_VAULT, "Welcome.md");
  await expect
    .poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("Typed in a browser.");

  const markdown = readFileSync(path, "utf8");
  // Still canonical Markdown, and the original content is intact rather than replaced.
  expect(markdown).toContain("# Welcome");
  // The provisioned body, so the assertion cannot drift from what `serve.ts` wrote.
  const original = E2E_NOTES["Welcome.md"]?.split("\n")[2];
  expect(original, "the fixture note should have a body line").toBeDefined();
  expect(markdown).toContain(original);
  expect(markdown.endsWith("\n")).toBe(true);
});
