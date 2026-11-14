/** Deleting an open note from the note tree's context menu (`SPEC.md` §4.3, §8.2, §7.6). */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, openSidebar, signIn, test } from "./fixtures.js";
import { E2E_VAULT, scratchNote } from "./environment.js";

test("deleting the open note from the tree removes its row, its tab and its file", async ({ page }, info) => {
  // why: the desktop app's WKWebView answers every native `confirm()` with Cancel and shows
  // nothing, so Delete did nothing there. Playwright dismisses an unhandled dialog the same
  // way, so the flow has to work through the page's own dialog, and no native one may appear.
  const native: string[] = [];
  page.on("dialog", (dialog) => { native.push(dialog.type()); void dialog.dismiss(); });
  const note = scratchNote("tree-delete", info.project.name);
  const title = `Tree delete ${info.project.name}`;
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".editor-surface .tiptap", { hasText: "A note this test may edit." });
  await expect(editor).toHaveCount(1);

  await openSidebar(page, "Navigation");
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  const folder = tree.getByRole("treeitem", { name: "Scratch", exact: true });
  if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
  const row = tree.getByRole("treeitem", { name: title, exact: true });
  await row.getByRole("button", { name: `Note actions for ${title}`, exact: true }).click();
  await page.getByRole("menu", { name: "Note actions", exact: true }).getByRole("menuitem", { name: "Delete", exact: true }).click();

  const confirm = page.getByRole("dialog", { name: "Move note to trash?", exact: true });
  await expect(confirm).toContainText(note);
  await confirm.getByRole("button", { name: "Move to trash", exact: true }).click();

  await expect(row).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  expect(() => readFileSync(join(E2E_VAULT, note), "utf8")).toThrow();
  expect(native).toEqual([]);
});
