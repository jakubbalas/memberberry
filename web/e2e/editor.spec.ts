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
import { E2E_VAULT, scratchNote } from "./environment.js";

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

test("the critical-path bundle arrives gzipped", async ({ page }) => {
  // SPEC §21.2 budgets initial JS + WASM **in gzip**, and until `mb-server` grew a
  // compression layer the same server sent 1.39 MB where the budget was measured against
  // 515.9 KB. Both numbers were true; only one of them was what a browser downloaded.
  //
  // Asserted from a real page load rather than from a request this file constructs, because
  // what matters is the encoding the *browser's* `Accept-Encoding` gets back — and no
  // hand-written header can stand in for that. The Rust suite covers the negotiation; this
  // covers the header a real Chromium actually sends.
  const encodings = new Map<string, string | null>();
  page.on("response", (response) => {
    const url = response.url();
    if (/\.(?:js|wasm)(?:\?|$)/.test(url)) {
      encodings.set(new URL(url).pathname, response.headers()["content-encoding"] ?? null);
    }
  });

  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR)).toBeVisible();

  // The premise: if a future build stops emitting these, the loop below passes vacuously.
  expect(encodings.size, `saw ${[...encodings.keys()].join(", ")}`).toBeGreaterThan(0);
  for (const [path, encoding] of encodings) {
    expect(encoding, `${path} must be compressed on the wire`).toBe("gzip");
  }
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

/**
 * What a note actually looks like (`SPEC.md` §8.2, §10.2).
 *
 * These two were the first things anyone opening the application would have mentioned, and
 * neither was visible to any other kind of test. The control strip's own JavaScript set
 * `hidden` correctly on the slash menu — a stylesheet cancelled it, so `hidden` read `true`
 * in jsdom while the menu stood open in the browser. And a task rendered as a plain bullet
 * with its metadata intact in the DOM, so every document assertion in the repository passed.
 *
 * A browser is what can see either. That is the whole reason this file exists (AGENTS §2.3).
 */

/** How tall the strip above the note may be before it is chrome rather than a toolbar. */
const CONTROL_STRIP_LIMIT = 160;

test("the note is not buried under the editor's own controls", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR)).toContainText("A note that already exists");

  // Through M7 all three rows were permanently visible — about 380px above every note, and
  // twice that in a split. The slash menu belongs to a `/` being typed and the inspector to
  // a task being selected; on a note being read, neither applies.
  await expect(page.locator(".slash-menu")).toBeHidden();
  await expect(page.locator(".task-inspector")).toBeHidden();

  const strip = await page.locator(".editor-controls").boundingBox();
  expect(strip, "the control strip should be laid out").not.toBeNull();
  expect(strip?.height ?? 0).toBeLessThan(CONTROL_STRIP_LIMIT);
});

test("typing a slash opens the command menu, and a space closes it again", async ({ page }, info) => {
  // Its own note: this test types, and both viewport projects run against one server.
  await signIn(page);
  await page.goto(`/v/personal/${scratchNote("slash-menu", info.project.name)}`);

  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("A note this test may edit");

  // why: the caret is placed with the pointer, not with `End` or `ControlOrMeta+End`.
  // Neither moves the caret at all under mobile emulation, so the slash landed mid-sentence
  // and the menu correctly stayed shut — a green desktop run and a red mobile one, for a
  // reason with nothing to do with the menu. Clicking past the end of the last line is the
  // one way to say "put the cursor here" that both viewports agree on.
  const paragraph = editor.getByText("A note this test may edit");
  const line = await paragraph.boundingBox();
  expect(line, "the note body should be laid out").not.toBeNull();
  await paragraph.click({ position: { x: (line?.width ?? 1) - 2, y: (line?.height ?? 1) - 2 } });

  const menu = page.locator(".slash-menu");
  await expect(menu).toBeHidden();

  const before = await editor.boundingBox();
  expect(before, "the editor should be laid out").not.toBeNull();

  // A space first: the menu opens on a slash that starts a word, not on any slash anywhere.
  await page.keyboard.type(" /");
  await expect(menu).toBeVisible();

  // Positioned rather than in flow. A menu that took space in the column would shove the
  // note — and the line being typed — down the screen on the keystroke that opened it.
  const after = await editor.boundingBox();
  expect(after?.y).toBe(before?.y);

  await page.keyboard.type("quote ");
  await expect(menu).toBeHidden();
});

test("a task renders as a checkbox and a due-date chip, not a plain bullet", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Projects/Roadmap.md");

  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Ship the workspace shell");

  const checkbox = editor.getByRole("checkbox");
  await expect(checkbox).toHaveCount(1);
  await expect(checkbox).toHaveAttribute("aria-checked", "false");

  // §10.2: "metadata renders as inline chips, not raw emoji". The emoji are the file's.
  await expect(editor.locator("[data-task-chip='due']")).toHaveText("Due2026-09-30");
  await expect(editor.locator("[data-task-chip='priority']")).toHaveText("PriorityHigh");
  await expect(editor).not.toContainText("📅");
  await expect(editor).not.toContainText("⏫");
});

test("ticking a task writes it back to the Markdown file", async ({ page }, info) => {
  // Its own note, for the same reason: this one changes what is on disk, and the test above
  // asserts on the metadata `Projects/Roadmap.md` was provisioned with.
  const note = scratchNote("task-toggle", info.project.name);
  await signIn(page);
  await page.goto(`/v/personal/${note}`);

  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Ship the workspace shell");
  await editor.getByRole("checkbox").click();
  await expect(editor.getByRole("checkbox")).toHaveAttribute("aria-checked", "true");

  // C2 again: the assertion is on the file a text editor would open. `- [x]` with a `✅`
  // date, and the metadata that was already there still in §10.1's order beside it.
  const path = join(E2E_VAULT, ...note.split("/"));
  await expect
    .poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("- [x] ");

  const markdown = readFileSync(path, "utf8");
  expect(markdown).toContain("Ship the workspace shell");
  expect(markdown).toContain("📅 2026-09-30");
  expect(markdown).toContain("⏫");
  expect(markdown).toMatch(/✅ \d{4}-\d{2}-\d{2}/);
});

test("a note heading is sized for a pane, not for a page", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");

  const heading = page.locator(`${EDITOR} h1`);
  await expect(heading).toContainText("Welcome");

  // The bare `h1` rule this replaces gave every `# ` in a note the workspace header's
  // display size — up to 4.75rem, which dominated a pane and swamped a split entirely.
  const size = await heading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(size).toBeGreaterThan(20);
  expect(size).toBeLessThan(40);
});
