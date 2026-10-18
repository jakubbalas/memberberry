/** Block movement through the real handles, gate, CRDT and disk (SPEC §8.4). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

for (const [kind, body, selected, label, expected] of [
  ["bullet", "- Alpha\n- **Beta α🌍**\n- Gamma", "Beta α🌍", "Move list item", "- **Beta α🌍**\n- Alpha\n- Gamma"],
  ["line", "Alpha\n**Beta α🌍**\nGamma", "Beta α🌍", "Move text line", "**Beta α🌍**\nAlpha\nGamma"],
] as const) {
  test(`individual ${kind} movement saves and undo restores the selected item`, async ({ page }, info) => {
    await signIn(page);
    const path = `Individual ${kind} ${info.project.name} ${randomUUID()}.md`;
    const initial = `# Title\n\n${body}\n\nAfter\n`;
    expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
    await page.goto(`/v/personal/${encodeURIComponent(path)}`);
    const editor = page.locator(EDITOR);
    await editor.getByText(selected, { exact: true }).click();
    await page.keyboard.press("Alt+Shift+F10");
    const menu = page.getByRole("menu", { name: label, exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "Move up", exact: true }).click();
    const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
    await expect.poll(disk, { timeout: 15_000 }).toBe(`# Title\n\n${expected}\n\nAfter\n`);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
    await page.reload();
    await expect(editor).toContainText(selected);
  });
  test(`individual ${kind} pointer drag and touch action target the hovered row`, async ({ page }, info) => {
    await signIn(page);
    const path = `Individual pointer ${kind} ${info.project.name} ${randomUUID()}.md`;
    const initial = `# Title\n\n${body}\n\nAfter\n`;
    expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
    await page.goto(`/v/personal/${encodeURIComponent(path)}`);
    const editor = page.locator(EDITOR);
    const beta = editor.getByText(selected, { exact: true });
    await beta.click();
    if (info.project.name === "mobile") {
      await page.getByLabel("More editing tools", { exact: true }).click();
      await page.getByRole("button", { name: "Move block up", exact: true }).click();
    } else {
      await beta.hover();
      const grip = page.getByRole("group", { name: "Block movement" }).getByRole("button", { name: label, exact: true });
      await expect(grip).toBeVisible();
      const source = await grip.boundingBox();
      const target = await editor.locator("p").filter({ hasText: "Alpha" }).first().boundingBox();
      const text = await beta.boundingBox();
      if (!source || !target || !text) throw new Error("missing row geometry");
      expect(Math.abs(source.y - text.y)).toBeLessThan(5);
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + 12, target.y - 2, { steps: 12 });
      await expect(page.locator(".block-drop-indicator")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`individual-${kind}-drag.png`) });
      await page.mouse.up();
    }
    const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
    await expect.poll(disk, { timeout: 15_000 }).toBe(`# Title\n\n${expected}\n\nAfter\n`);
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  });
}

test("the block menu moves a block, saves it, and undo puts it and the caret back", async ({ page }, info) => {
  await signIn(page);
  const path = `Block move ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nAlpha\n\nBeta\n\nGamma\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Gamma");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");

  await editor.getByText("Alpha", { exact: true }).click();
  await page.keyboard.press("Alt+Shift+F10");
  const menu = page.getByRole("menu", { name: "Move paragraph", exact: true });
  await expect(menu).toBeVisible();
  await expect(menu).not.toContainText("Single-editor rearrangement only");
  await expect(menu).toBeInViewport();
  await page.screenshot({ path: info.outputPath("block-menu.png") });
  await menu.getByRole("menuitem", { name: "Move down", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Title\n\nBeta\n\nAlpha\n\nGamma\n");

  await editor.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  await expect.poll(() => page.evaluate(() => {
    const selection = document.getSelection();
    return selection?.anchorNode?.parentElement?.closest("p")?.textContent;
  })).toBe("Alpha");
});

test("⋯ and the slim grip sit on one row in the gutter, 12px clear of the block text", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "coarse pointers show no floating handles (§8.4)");
  await signIn(page);
  const path = `Block handles ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nAlpha\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const alpha = page.locator(EDITOR).getByText("Alpha", { exact: true });
  await alpha.hover();
  const buttons = page.getByRole("group", { name: "Block movement" }).getByRole("button");
  await expect(buttons).toHaveCount(2);
  await expect(buttons.first()).toBeVisible();
  const [more, grip, text] = await Promise.all([
    buttons.getByText("⋯").boundingBox(), buttons.getByText("⠿").boundingBox(), alpha.boundingBox(),
  ]);
  await page.screenshot({ path: info.outputPath("block-handles.png") });
  expect({
    sameRow: Math.abs((grip?.y ?? 0) - (more?.y ?? -100)) < 1,
    gripRightOfMore: (grip?.x ?? 0) >= (more?.x ?? 0) + (more?.width ?? 0),
    clearOfText: (text?.x ?? 0) - ((grip?.x ?? 0) + (grip?.width ?? 0)) >= 11,
    slim: [more, grip].every(box => (box?.width ?? 99) <= 20.5 && (box?.height ?? 99) <= 24.5),
  }).toEqual({ sameRow: true, gripRightOfMore: true, clearOfText: true, slim: true });
});

test("the handles stay on the hovered block while the pointer crosses the gutter to them", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "coarse pointers show no floating handles (§8.4)");
  await signIn(page);
  const path = `Block handles gutter ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nAlpha\n\nBeta\n\nGamma\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const beta = page.locator(EDITOR).getByText("Beta", { exact: true });
  const group = page.getByRole("group", { name: "Block movement" });
  const grip = group.getByText("⠿");
  const text = await beta.boundingBox();
  const y = (text?.y ?? 0) + (text?.height ?? 0) / 2;
  await page.mouse.move((text?.x ?? 0) + 10, y);
  await expect(grip).toBeVisible();
  const handles = await group.boundingBox();
  const tops: number[] = [];
  // Walk left from the text to the grip a pixel at a time, as a real pointer does.
  for (let x = (text?.x ?? 0) + 10; x >= (handles?.x ?? 0) + (handles?.width ?? 0) - 8; x -= 1) {
    await page.mouse.move(x, y);
    tops.push(await page.locator(".block-handles").evaluate(el => ((el as HTMLElement).hidden ? -1 : el.getBoundingClientRect().top)));
  }
  await expect(grip).toBeVisible();
  expect(tops.filter(top => Math.abs(top - (handles?.y ?? 0)) >= 1)).toEqual([]);
});
