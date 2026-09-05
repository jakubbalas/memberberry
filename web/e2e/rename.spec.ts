/**
 * Renaming a note in a real browser (`SPEC.md` §6.6).
 *
 * What only a browser can say here is the whole of it. The unit suite proves the rewriter is
 * correct and the DOM suite proves the prompt is wired; neither can prove that the command
 * appears in a palette a person can open, that the dialog takes focus, or that the file a
 * text editor would open came back renamed with its inbound links following it. That last
 * one is C2, and the only way to assert it is to read the `.md` files off disk.
 *
 * The test **renames back** at the end. `reuseExistingServer` is on locally, so a run that
 * left the vault renamed would make the next run fail against a fixture that is not there —
 * and the round trip is worth asserting anyway: it is the strongest statement that the
 * rewrite lost nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PROMPT = "dialog.rename-prompt";

/** The note file as a text editor would see it (C2). */
function onDisk(note: string): string {
  return readFileSync(join(E2E_VAULT, note), "utf8");
}

/** Opens the palette and runs the rename command, returning once the prompt has focus. */
async function openRenamePrompt(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expect(page.getByRole("option", { name: /^Rename note/ })).toBeVisible();
  await page.getByRole("option", { name: /^Rename note/ }).click();
  const prompt = page.locator(PROMPT);
  await expect(prompt).toBeVisible();
  // Asserted on the input rather than on the dialog: the title gives the dialog a height, so
  // a prompt whose form was hidden would still pass `toBeVisible` on the container (§22.6).
  await expect(prompt.locator(".rename-input")).toBeFocused();
}

test("renames the open note and rewrites the links that point at it", async ({ page }, info) => {
  const note = scratchNote("rename", info.project.name);
  const source = scratchNote("rename-source", info.project.name);
  const original = note.slice("Scratch/".length, -".md".length);
  const renamed = `renamed-${original}`;

  // The link is there before anything happens, so a passing assertion below cannot be a
  // fixture that never had one.
  expect(onDisk(source)).toContain(`[[${original}]]`);

  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();

  await openRenamePrompt(page);
  // Prefilled with the note's name, not its path — the folder is not what anyone retypes.
  await expect(page.locator(`${PROMPT} .rename-input`)).toHaveValue(original);
  // And the warning that the rewrite reaches notes the person cannot read is on screen
  // *before* they commit: §6.9 gives the audit log no UI, so this is the only place it is
  // ever said.
  await expect(page.locator(`${PROMPT} .rename-warning`)).toContainText("cannot see");

  await page.locator(`${PROMPT} .rename-input`).fill(renamed);
  await page.locator(`${PROMPT} .rename-confirm`).click();
  await expect(page.locator(PROMPT)).toBeHidden();

  // What the user is told, and how it is phrased. "notes you can see" is not a nicety: the
  // rewrite reached further and the reply deliberately does not say how much further (§6.5).
  await expect(page.locator(".rename-notice")).toHaveText(/Renamed to Scratch\/.*\. Updated/);
  await expect(page.locator(".rename-notice")).toContainText("you can see");
  // The workspace followed the note rather than leaving a pane on a path that is gone.
  await expect(page.locator(EDITOR).first()).toContainText("Rename scratch");
  // The tab strip is desktop-only (§8.3), so this is the one assertion with a viewport.
  if (info.project.name === "desktop") {
    await expect(page.locator(".tab", { hasText: renamed })).toBeVisible();
  }

  // C2: the file a text editor would open, at its new name, with the inbound references
  // following it — the plain link and the embed both.
  await expect
    .poll(() => onDisk(`Scratch/${renamed}.md`))
    .toContain("A note this test may rename.");
  const rewritten = onDisk(source);
  expect(rewritten).toContain(`[[${renamed}]]`);
  expect(rewritten).toContain(`![[${renamed}]]`);
  expect(rewritten).not.toContain(`[[${original}]]`);
  // Only the link spans moved: everything else in the source note is byte-for-byte what it
  // was. This is §6.6's third bullet, seen from the far end of the whole system.
  expect(rewritten).toContain("# Rename source");
  expect(rewritten).toContain("for the plan.");

  // Rename back, which restores the fixture and asserts the round trip lost nothing.
  await openRenamePrompt(page);
  await page.locator(`${PROMPT} .rename-input`).fill(original);
  await page.locator(`${PROMPT} .rename-confirm`).click();
  await expect(page.locator(PROMPT)).toBeHidden();
  await expect.poll(() => onDisk(source)).toContain(`[[${original}]]`);
  expect(onDisk(source)).toBe(
    `# Rename source\n\nSee [[${original}]] for the plan.\n\n![[${original}]]\n`,
  );
});

test("a rename can be abandoned without touching anything", async ({ page }) => {
  // A read-only fixture on purpose: this test commits nothing, so it needs no scratch note
  // of its own — and taking one would make it race the rename test above, which shares a
  // server and a vault with it under `fullyParallel`.
  const note = "Welcome.md";
  const before = onDisk(note);

  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();

  await openRenamePrompt(page);
  await page.locator(`${PROMPT} .rename-input`).fill("something-else");
  // Escape, because a `<dialog>` closing on Escape is the browser's behaviour and the whole
  // reason the prompt is one — a hand-rolled overlay is where that stops working.
  await page.keyboard.press("Escape");
  await expect(page.locator(PROMPT)).toBeHidden();

  expect(onDisk(note)).toBe(before);
  await expect(page.locator(".rename-notice")).toHaveText("");
});
