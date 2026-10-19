/** Separate block highlighting and grouped movement through the real CRDT and Markdown. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
test("Delete removes the complete highlighted mixed range and undo restores it", async ({ page }, info) => {
  await signIn(page);
  const path = `Delete selection ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nBefore\n\n- Alpha\n- Beta\n\nMiddle\n\nAfter\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR); await editor.getByText("Alpha", { exact: true }).click();
  await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown"); await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(3);
  await page.keyboard.press("Delete");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Title\n\nBefore\n\nAfter\n");
  await expect(editor.locator("h1")).toHaveText("Title");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z"); await expect.poll(disk).toBe(initial);
  await page.reload(); await expect(editor.locator("ul li")).toHaveText(["Alpha", "Beta"]);
});

for (const [marker, tag] of [["-", "ul"], ["1.", "ol"]]) {
  test(`Tab and Shift+Tab indent and outdent highlighted ${tag} items together`, async ({ page }, info) => {
    await signIn(page);
    const path = `Indent selection ${tag} ${info.project.name} ${randomUUID()}.md`;
    const initial = `# Title\n\n${marker} Parent\n${marker} Alpha\n${marker} Beta\n${marker} Last\n`;
    expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
    await page.goto(`/v/personal/${encodeURIComponent(path)}`);
    const editor = page.locator(EDITOR);
    const select = async (): Promise<void> => {
      // why: reload restores a local body before the single-editor sync gate is ready.
      await expect(page.getByRole("button", { name: "Move list item", exact: true, includeHidden: true })).toBeEnabled();
      await editor.getByText("Alpha", { exact: true }).click();
      await expect.poll(() => editor.evaluate(element => {
        const model = (element as HTMLElement & { editor?: { state: { selection: { empty: boolean; $head: { parent: { textContent: string } } } } } }).editor;
        return model?.state.selection.empty && model.state.selection.$head.parent.textContent;
      })).toBe("Alpha");
      await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
      await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
    };
    await select(); await page.keyboard.press("Tab");
    const root = editor.locator(`:scope > ${tag}`);
    const nested = root.locator(":scope > li").first().locator(`:scope > ${tag} > li`);
    await expect(nested).toHaveText(["Alpha", "Beta"]);
    const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
    await expect.poll(disk, { timeout: 15_000 }).toMatch(/Parent\n(?:[ \t]*\n)* {2,}/);
    await page.reload(); await expect(nested).toHaveText(["Alpha", "Beta"]);
    await select(); await page.keyboard.press("Shift+Tab");
    await expect(root.locator(":scope > li")).toHaveText(["Parent", "Alpha", "Beta", "Last"]);
    await expect.poll(disk).toBe(initial);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(nested).toHaveText(["Alpha", "Beta"]);
    await expect.poll(disk).toMatch(/Parent\n(?:[ \t]*\n)* {2,}/);
    await page.screenshot({ path: info.outputPath(`selected-${tag}-indent.png`) });
  });
}

test("group indentation keeps nested children highlighted for a following Shift+Tab", async ({ page }, info) => {
  await signIn(page);
  const path = `Nested indent selection ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\n- Parent\n\n- Alpha\n\n  - Child\n\n- Beta\n\n  - Last child\n\n- After\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await editor.getByText("Alpha", { exact: true }).click();
  await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await page.keyboard.press("Tab");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  await expect(editor.locator(":scope > ul > li")).toHaveCount(2);
  await expect.poll(disk, { timeout: 15_000 }).not.toBe(initial);
  await expect(page.getByRole("button", { name: "Move 2 blocks", exact: true, includeHidden: true })).toBeEnabled();
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator(":scope > ul > li")).toHaveCount(4);
  await expect(editor.locator("ul ul li > p")).toHaveText(["Child", "Last child"]);
  await expect.poll(disk).toBe(initial);
  await page.reload();
  await expect(editor.locator(":scope > ul > li")).toHaveCount(4);
  await expect(editor.locator("ul ul li > p")).toHaveText(["Child", "Last child"]);
});

test("blank drags across the pane select rows without the grabber obstructing selection", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "touch retains native scrolling and menu selection");
  await signIn(page);
  const path = `Full pane ${randomUUID()}.md`;
  const initial = "# Title\n\nAlpha **marked** text\n\n- Beta\n\nGamma\n\nAfter\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  const alpha = editor.locator("p").filter({ hasText: "Alpha" });
  const gamma = editor.getByText("Gamma", { exact: true });
  await alpha.click();
  const [first, last, pane] = await Promise.all([alpha.boundingBox(), gamma.boundingBox(), editor.boundingBox()]);
  if (!first || !last || !pane) throw new Error("missing pane geometry");
  for (const gesture of [
    { x: first.x + first.width - 15, reverse: false },
    { x: first.x + first.width / 2, reverse: true },
    { x: first.x - 8, reverse: false },
    { x: pane.x + pane.width + 5, reverse: true },
  ]) {
    const top = first.y + first.height / 2; const bottom = last.y + last.height / 2;
    await page.mouse.move(gesture.x, gesture.reverse ? bottom : top); await page.mouse.down();
    await page.mouse.move(gesture.x, gesture.reverse ? top : bottom, { steps: 12 });
    await expect(page.locator(".block-selection-highlight")).toHaveCount(3);
    await expect(page.locator(".block-handles")).toHaveJSProperty("hidden", true);
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Move 3 blocks", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  // A click at the right of a paragraph remains an ordinary caret placement.
  await page.mouse.click(first.x + first.width - 15, first.y + first.height / 2);
  await page.keyboard.type("!");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk).toBe(initial.replace("marked** text", "marked** text!"));
  await page.keyboard.press("ControlOrMeta+z"); await expect.poll(disk).toBe(initial);
  const glyphs = await alpha.evaluate(element => {
    const text = element.firstChild; if (!text) throw new Error("missing text");
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 5);
    const box = range.getBoundingClientRect(); return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  for (const reverse of [false, true]) {
    await page.mouse.move(reverse ? glyphs.right - 1 : glyphs.left + 1, glyphs.y); await page.mouse.down();
    await page.mouse.move(reverse ? glyphs.left + 1 : glyphs.right - 1, glyphs.y, { steps: 8 }); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Alpha");
    await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
    await expect(page.locator(".block-handles")).toHaveJSProperty("hidden", true);
  }
  await page.screenshot({ path: info.outputPath("native-text-selection.png") });
  await expect.poll(disk).toBe(initial);
});

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

test("wrapped Unicode text keeps native glyph selection and blank-space row selection separate", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "touch retains native text selection and scrolling");
  await signIn(page);
  const path = `Wrapped selection ${randomUUID()}.md`;
  const initial = `# Title\n\n${"Wide α🌍 text ".repeat(16)}tail\n\nAfter\n`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR); const paragraph = editor.locator("p").filter({ hasText: "Wide" });
  await expect(paragraph).toBeVisible();
  const geometry = await paragraph.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rects = Array.from(range.getClientRects()); const last = rects.at(-1);
    if (!last || rects.length < 2) throw new Error("fixture must wrap onto multiple visual lines");
    const box = element.getBoundingClientRect();
    return { left: last.left, right: last.right, y: last.top + last.height / 2, blank: box.right - 8 };
  });
  expect(geometry.blank).toBeGreaterThan(geometry.right);
  const after = await editor.getByText("After", { exact: true }).boundingBox(); if (!after) throw new Error("missing endpoint");
  await page.mouse.move(geometry.blank, geometry.y); await page.mouse.down();
  await page.mouse.move(geometry.blank, after.y + after.height / 2, { steps: 8 });
  await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
  await expect(page.locator(".block-handles")).toHaveJSProperty("hidden", true);
  await page.mouse.up(); await page.screenshot({ path: info.outputPath("wrapped-purple-selection.png") });
  await page.keyboard.press("Escape");
  await page.mouse.move(geometry.left + 1, geometry.y); await page.mouse.down();
  await page.mouse.move(geometry.right - 1, geometry.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("tail");
  await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
  await expect(page.locator(".block-handles")).toHaveJSProperty("hidden", true);
  expect(readFileSync(join(E2E_VAULT, path), "utf8")).toBe(initial);
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
