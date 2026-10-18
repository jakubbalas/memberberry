/** Separate block highlighting and grouped movement through the real CRDT and Markdown. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
test("margin marquee selects bullets and a paragraph and drags them together", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "touch uses the block menu without taking over scrolling");
  await signIn(page);
  const path = `Marquee ${randomUUID()}.md`;
  const initial = "# Title\n\nBefore\n\n- **Alpha**\n- Beta\n\nMiddle\n\nAfter\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  const alpha = editor.getByText("Alpha", { exact: true }); await alpha.click();
  await expect(page.locator(".block-handles")).toHaveJSProperty("hidden", false);
  const [first, last, box, paragraph] = await Promise.all([alpha.boundingBox(), editor.getByText("Middle", { exact: true }).boundingBox(), editor.boundingBox(), editor.getByText("Before", { exact: true }).boundingBox()]);
  if (!first || !last || !box || !paragraph) throw new Error("missing marquee geometry");
  await page.mouse.move(paragraph.x - 5, first.y - 3); await page.mouse.down();
  await info.attach("margin-hit", { body: JSON.stringify(await page.evaluate(({ x, y }) => ({ target: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500), selecting: document.querySelector(".tiptap")?.className }), { x: paragraph.x - 5, y: first.y - 3 })), contentType: "application/json" });
  await page.mouse.move(box.x + box.width - 10, last.y + last.height - 2, { steps: 16 });
  await expect(page.locator(".block-selection-marquee")).toBeVisible();
  await expect(page.locator(".block-selection-highlight")).toHaveCount(3);
  await page.screenshot({ path: info.outputPath("purple-marquee.png") });
  await page.mouse.up();
  const grip = page.getByRole("button", { name: "Move 3 blocks", exact: true });
  const source = await grip.boundingBox(); const after = await editor.getByText("After", { exact: true }).boundingBox();
  if (!source || !after) throw new Error("missing group drag geometry");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down();
  await page.mouse.move(after.x + 20, after.y + after.height + 3, { steps: 12 });
  await expect(page.locator(".block-drop-indicator")).toBeVisible(); await page.mouse.up();
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Title\n\nBefore\n\nAfter\n\n- **Alpha**\n- Beta\n\nMiddle\n");
  await page.keyboard.press("ControlOrMeta+z"); await expect.poll(disk).toBe(initial);
  await page.reload(); await expect(editor).toContainText("Middle");
});

test("keyboard and touch menus select a range, move it once and clear with Escape", async ({ page }, info) => {
  await signIn(page);
  const path = `Block range ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nAlpha\n\nBeta\n\nGamma\n\nAfter\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR); await editor.getByText("Alpha", { exact: true }).click();
  if (info.project.name === "mobile") {
    await page.getByLabel("More editing tools", { exact: true }).click();
    await page.getByRole("button", { name: "Select or move blocks", exact: true }).click();
    await page.getByRole("menuitem", { name: "Select block", exact: true }).click();
    await page.getByLabel("More editing tools", { exact: true }).click();
    await page.getByRole("button", { name: "Select or move blocks", exact: true }).click();
    await page.getByRole("menuitem", { name: "Extend selection down", exact: true }).click();
  } else {
    await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
  }
  await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  await expect(page.locator(".block-selection-status")).toContainText("2 blocks selected");
  if (info.project.name === "desktop") {
    await editor.getByText("Gamma", { exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.locator(".block-selection-highlight")).toHaveCount(3);
    await editor.getByText("Beta", { exact: true }).click({ modifiers: ["Shift"] });
    await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  }
  await page.screenshot({ path: info.outputPath("purple-block-selection.png") });
  await page.keyboard.press("Alt+Shift+F10");
  await page.getByRole("menu", { name: "Move 2 blocks", exact: true }).getByRole("menuitem", { name: "Move down", exact: true }).click();
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk).toBe("# Title\n\nGamma\n\nAlpha\n\nBeta\n\nAfter\n");
  await page.keyboard.press("Escape"); await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z"); await expect.poll(disk).toBe(initial);
  await editor.getByText("Beta", { exact: true }).click(); await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("B");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
});

test("numbered groups adopt destination numbering and source survivors restart correctly", async ({ page }, info) => {
  await signIn(page);
  const path = `Numbered range ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\n1. Alpha\n1. Beta\n1. Gamma\n\nBetween\n\n7. Delta\n1. Epsilon\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR); await editor.getByText("Alpha", { exact: true }).click();
  await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  await page.keyboard.press("Alt+Shift+F10");
  await page.getByRole("menu", { name: "Move 2 blocks", exact: true }).getByRole("menuitem", { name: "Move down", exact: true }).click();
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk).toBe("# Title\n\n1. Gamma\n1. Alpha\n1. Beta\n\nBetween\n\n7. Delta\n1. Epsilon\n");
  // Re-select after each acknowledged edit, then step the group past the separator.
  await editor.getByText("Alpha", { exact: true }).click(); await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+F10"); await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect.poll(disk).toBe("# Title\n\n1. Gamma\n\nBetween\n\n7. Alpha\n1. Beta\n1. Delta\n1. Epsilon\n");
  await editor.getByText("Alpha", { exact: true }).click(); await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Alt+Shift+F10"); await page.getByRole("menuitem", { name: "Move down", exact: true }).click();
  const expected = "# Title\n\n1. Gamma\n\nBetween\n\n7. Delta\n1. Alpha\n1. Beta\n1. Epsilon\n";
  await expect.poll(disk).toBe(expected);
  const lists = editor.locator("ol"); await expect(lists).toHaveCount(2);
  await expect(lists.first()).toHaveAttribute("start", "1"); await expect(lists.last()).toHaveAttribute("start", "7");
  await expect(lists.last().locator(":scope > li")).toHaveText(["Delta", "Alpha", "Beta", "Epsilon"]);
  await page.screenshot({ path: info.outputPath("numbered-group.png") });
  await page.reload(); await expect(lists.last()).toHaveAttribute("start", "7"); await expect.poll(disk).toBe(expected);
});
