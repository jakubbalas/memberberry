/** Selection-only Markdown formatting, with real keyboard/pointer and independent reopen. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { EditorView } from "@tiptap/pm/view";
import { E2E_ORIGIN, E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("document mapping cannot revive retained controls; fresh native keyboard and pointer selections work", async ({ page }, info) => {
  await signIn(page);
  const path = `Capture repair ${info.project.name} ${randomUUID()}.md`;
  const initial = "# Title\n\nFirst body\n\nLater words\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toBeFocused();
  await selectLater(page);
  const popup = page.getByRole("toolbar", { name: "Selected text formatting" });
  await popup.getByRole("button", { name: "Link", exact: true }).click();
  await expect(popup.getByRole("textbox", { name: "Link destination", exact: true })).toBeFocused();
  await editor.evaluate((element) => {
    const view = (element as HTMLElement & { editor: { view: EditorView } }).editor.view;
    const bold = document.querySelector<HTMLButtonElement>(".selection-menu [aria-label='Bold']");
    const form = document.querySelector<HTMLFormElement>(".selection-menu form");
    const input = form?.querySelector("input");
    view.dispatch(view.state.tr.insertText("fresh ", (view.state.doc.firstChild?.nodeSize ?? 0) + 1));
    bold?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    bold?.click();
    if (input) input.value = "https://example.com";
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    view.focus();
  });
  const changed = initial.replace("First body", "fresh First body");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk).toBe(changed);
  await expect(popup).toBeHidden();
  // No intervening click/fill/focus repair: Alt-F10 alone cannot bless the mapped range.
  await page.keyboard.press("Alt+F10");
  await expect(popup).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Later");
  await expect(popup).toBeVisible();
  await page.keyboard.press("Alt+F10");
  await expect(popup.getByRole("button", { name: "Bold", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(disk).toBe(changed.replace("Later", "**Later**"));
  // Invalidate again, then form a native pointer range with browser default actions.
  await editor.evaluate((element) => {
    const view = (element as HTMLElement & { editor: { view: EditorView } }).editor.view;
    view.dispatch(view.state.tr.insertText("again ", (view.state.doc.firstChild?.nodeSize ?? 0) + 1));
  });
  await expect(popup).toBeHidden();
  const positions = await editor.locator("p").last().evaluate((element) => {
    const text = element.querySelector("strong")?.firstChild;
    if (!(text instanceof Text)) throw new Error("missing selected text");
    const edge = (offset: number) => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect(); };
    const first = edge(0), last = edge(4);
    return { x1: first.left + 1, x2: last.right - 1, y: (first.top + first.bottom) / 2 };
  });
  // A mousedown inside the still-selected native range starts drag/drop, not reselection.
  // Collapse with a real pointer click before dragging the range again.
  await page.mouse.click(positions.x2 + 15, positions.y);
  await page.mouse.move(positions.x1, positions.y);
  await page.mouse.down();
  await page.mouse.move(positions.x2, positions.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Later");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: "Clear formatting" }).click();
  await expect.poll(disk).toBe(changed.replace("fresh First", "again fresh First"));
  await page.screenshot({ path: info.outputPath("renewed-native-selection.png") });
});

test("destination-only link edits preserve authored titles on disk and independent reopen; unlink and Clear remain explicit", async ({ page, browser }, info) => {
  await signIn(page);
  const path = `Title repair ${info.project.name} ${randomUUID()}.md`;
  const initial = '# Title\n\n[Later](https://example.com "authored title")\n';
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  const popup = page.getByRole("toolbar", { name: "Selected text formatting" });
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  const select = async () => { await editor.locator("p").click(); await page.keyboard.press("Home"); await page.keyboard.press("Shift+End"); await expect(popup).toBeVisible(); };
  await select();
  await popup.getByRole("button", { name: "Link", exact: true }).click();
  await expect(popup.getByRole("textbox", { name: "Link destination", exact: true })).toHaveValue("https://example.com");
  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await expect.poll(disk).toBe(initial);
  await popup.getByRole("button", { name: "Link", exact: true }).click();
  await popup.getByRole("textbox", { name: "Link destination", exact: true }).fill("https://new.example");
  await page.keyboard.press("Enter");
  const changed = initial.replace("https://example.com", "https://new.example");
  await expect.poll(disk).toBe(changed);
  const context = await browser.newContext({ baseURL: E2E_ORIGIN });
  try {
    const other = await context.newPage();
    await signIn(other);
    await other.goto(`/v/personal/${encodeURIComponent(path)}`);
    await expect(other.locator(`${EDITOR} a`)).toHaveAttribute("title", "authored title");
    await expect(other.locator(`${EDITOR} a`)).toHaveAttribute("href", "https://new.example");
  } finally { await context.close(); }
  await page.bringToFront();
  await popup.getByRole("button", { name: "Link", exact: true }).click();
  await popup.getByRole("button", { name: "Remove link" }).click();
  await expect.poll(disk).toBe("# Title\n\nLater\n");
  const clearPath = `Clear title ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path: clearPath, content: initial } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(clearPath)}`);
  await expect(editor.locator("a")).toHaveAttribute("title", "authored title");
  await select();
  await popup.getByRole("button", { name: "Clear formatting" }).click();
  await expect.poll(() => readFileSync(join(E2E_VAULT, clearPath), "utf8")).toBe("# Title\n\nLater\n");
});

const EDITOR = ".editor-surface .tiptap";
async function selectLater(page: Page): Promise<void> {
  await page.locator(`${EDITOR} p`).last().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Later words");
}

test("first render stays compact; keyboard and pointer Bold/Clear save canonical Markdown and reopen independently", async ({ page, browser }, info) => {
  await signIn(page);
  const name = `Selection ${info.project.name} ${randomUUID()}`;
  const path = `${name}.md`;
  const initial = `# ${name}\n\nFirst body\n\nLater words\n`;
  const created = await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } });
  expect(created.ok()).toBe(true);
  const start = Date.now();
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Later words");
  // Before click/fill/scroll: these must not conceal an offscreen editing handoff.
  await expect(editor).toBeInViewport();
  await expect(editor).toBeFocused();
  const popup = page.getByRole("toolbar", { name: "Selected text formatting" });
  await expect(popup).toBeHidden();
  await expect(page.locator(".editor-toolbar > [aria-label='Insert task block']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Toggle Markdown source view" })).toBeVisible();
  await expect(page.getByLabel("More editing tools")).toBeVisible();
  await selectLater(page);
  await expect(popup).toBeVisible();
  console.log(`FIRST_RENDER ${info.project.name}: ${Date.now() - start}ms from navigation to selected-text popup`);
  const bounds = await popup.boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(info.project.use.viewport?.width ?? 1280);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(info.project.use.viewport?.height ?? 800);
  }
  await page.screenshot({ path: info.outputPath("first-selection-popup.png") });
  await page.keyboard.press("Alt+F10");
  await expect(popup.getByRole("button", { name: "Bold", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(editor.locator("strong")).toHaveText("Later words");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial.replace("Later words", "**Later words**"));
  await selectLater(page);
  await popup.getByRole("button", { name: "Clear formatting" }).click();
  await expect(editor.locator("strong")).toHaveCount(0);
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  await selectLater(page);
  await popup.getByRole("button", { name: "Bold", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial.replace("Later words", "**Later words**"));
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Later words");
  const otherContext = await browser.newContext({ baseURL: E2E_ORIGIN });
  const other = await otherContext.newPage();
  const errors: string[] = [];
  other.on("pageerror", (error) => errors.push(error.message));
  other.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await signIn(other);
    await other.goto(`/v/personal/${encodeURIComponent(path)}`);
    await expect(other.locator(`${EDITOR} strong`)).toHaveText("Later words");
    await expect(other.locator(`${EDITOR} h1`)).toHaveText(name);
    await expect(other.locator(`${EDITOR} h1 strong`)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await otherContext.close(); }
});

test("native inline marks and safe link dialog retain selection on desktop and touch layouts", async ({ page }, info) => {
  await signIn(page);
  const name = `Inline ${info.project.name} ${randomUUID()}`;
  const path = `${name}.md`;
  const initial = `# ${name}\n\nFirst body\n\nLater words\n`;
  const created = await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: initial } });
  expect(created.ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await expect(editor).toContainText("Later words");
  const popup = page.getByRole("toolbar", { name: "Selected text formatting" });
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  const activate = async (label: string) => {
    const control = popup.getByRole("button", { name: label, exact: true });
    if (info.project.name === "mobile") await control.tap();
    else await control.click();
  };
  for (const [label, tag, text] of [
    ["Italic", "em", "*Later words*"], ["Strikethrough", "s", "~~Later words~~"],
    ["Highlight", "mark", "==Later words=="], ["Inline code", "code", "`Later words`"],
  ] as const) {
    await selectLater(page);
    await activate(label);
    await expect(editor.locator(tag)).toHaveText("Later words");
    await expect.poll(disk, { timeout: 15_000 }).toBe(initial.replace("Later words", text));
    await activate("Clear formatting");
    await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  }
  await selectLater(page);
  await page.keyboard.press("Alt+F10");
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect(popup.getByRole("button", { name: "Link", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const input = popup.getByRole("textbox", { name: "Link destination", exact: true });
  await expect(input).toBeFocused();
  await expect(popup).toBeInViewport();
  const linkBounds = await popup.boundingBox();
  if (!linkBounds) throw new Error("link popup has no geometry");
  expect(linkBounds.x).toBeGreaterThanOrEqual(0);
  expect(linkBounds.y).toBeGreaterThanOrEqual(0);
  expect(linkBounds.x + linkBounds.width).toBeLessThanOrEqual(info.project.use.viewport?.width ?? 1280);
  expect(linkBounds.y + linkBounds.height).toBeLessThanOrEqual(info.project.use.viewport?.height ?? 800);
  await page.screenshot({ path: info.outputPath("selection-link-dialog.png") });
  await page.keyboard.insertText("javascript:alert(1)");
  await page.keyboard.press("Enter");
  await expect(popup.getByRole("status")).toContainText("Enter a safe");
  expect(disk()).toBe(initial);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("https://example.com/path");
  await page.keyboard.press("Enter");
  await expect(editor.locator("a")).toHaveText("Later words");
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial.replace("Later words", "[Later words](https://example.com/path)"));
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe("Later words");
  await activate("Clear formatting");
  await expect.poll(disk, { timeout: 15_000 }).toBe(initial);
  await selectLater(page);
  await activate("Bold");
  await expect(popup.getByRole("button", { name: "Inline code", exact: true })).toBeDisabled();
  await activate("Clear formatting");
  await selectLater(page);
  await page.getByRole("button", { name: "Toggle Markdown source view" }).click();
  await expect(popup).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Markdown source", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle Markdown source view" }).click();
  await expect(editor).toBeVisible();
  await editor.locator("h1").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await expect(popup).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
