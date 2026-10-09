/** Toggles are foldable callouts; folding is the reader's view, never an edit (SPEC §8.4). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

test("Turn into makes a toggle that folds by button and keyboard without changing the file", async ({ page }, info) => {
  await signIn(page);
  const path = `Toggle ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nMeeting notes\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Meeting notes");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");

  await editor.getByText("Meeting notes", { exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const popup = page.getByRole("toolbar", { name: "Selected text formatting" });
  await popup.getByRole("combobox", { name: "Turn into", exact: true }).selectOption("toggle");
  await expect.poll(disk, { timeout: 15_000 }).toContain("> [!note]+ Meeting notes");
  const saved = disk();

  const fold = editor.getByRole("button", { name: "Collapse toggle", exact: true });
  await expect(fold).toBeVisible();
  // The caret lands in the new toggle's empty body, ready to type.
  await page.keyboard.type("Ship on Friday");
  await expect.poll(disk, { timeout: 15_000 }).toContain("Ship on Friday");
  const withBody = disk();
  await page.screenshot({ path: info.outputPath("toggle-open.png") });

  await fold.click();
  await expect(editor.getByText("Ship on Friday")).toBeHidden();
  await page.screenshot({ path: info.outputPath("toggle-folded.png") });
  await editor.getByRole("button", { name: "Expand toggle", exact: true }).click();
  await expect(editor.getByText("Ship on Friday")).toBeVisible();

  const summary = editor.locator("[data-callout-title]");
  await expect(summary).toHaveText("Meeting notes");
  await summary.click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(editor.getByText("Ship on Friday")).toBeHidden();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(editor.getByText("Ship on Friday")).toBeVisible();
  expect(disk(), "folding is not an edit").toBe(withBody);
  expect(saved).not.toBe(withBody);
});
