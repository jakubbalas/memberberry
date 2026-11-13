/** Cut selected text/blocks between real notes, through Chromium's isolated clipboard. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, lineKey, signIn, test } from "./fixtures.js";

for (const selection of ["blocks", "text"] as const) {
  test(`Cmd/Ctrl+X cuts selected ${selection} and Cmd/Ctrl+V pastes into another note`, async ({ page, context, browserName }, info) => {
    // why: Playwright can grant clipboard access only to Chromium; WebKit has no such
    // permission, and its clipboard there cannot be read back. Not covered in WebKit.
    test.skip(browserName === "webkit", "Playwright cannot grant WebKit clipboard access");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page);
    const id = `${info.project.name} ${selection} ${randomUUID()}`;
    const source = `Cut source ${id}.md`, destination = `Cut destination ${id}.md`;
    const initial = "# Source\n\nBefore\n\n**Alpha** ✨\n\nملاحظات Beta\n\nAfter\n";
    for (const [path, content] of [[source, initial], [destination, "# Destination\n\nHere\n"]]) {
      expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } })).ok()).toBe(true);
    }
    await page.goto(`/v/personal/${encodeURIComponent(source)}`);
    const editor = page.locator(".editor-surface .tiptap");
    await editor.getByText("Alpha", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Move paragraph", exact: true, includeHidden: true })).toBeEnabled();
    await expect.poll(() => editor.evaluate(element => {
      const model = (element as HTMLElement & { editor?: { state: { selection: { $head: { parent: { textContent: string } } } } } }).editor;
      return model?.state.selection.$head.parent.textContent;
    })).toBe("Alpha ✨");
    if (selection === "blocks") {
      await page.keyboard.press("Escape"); await page.keyboard.press("Shift+ArrowDown");
      await expect(page.locator(".block-selection-highlight")).toHaveCount(2);
    } else {
      await editor.evaluate(element => {
        const first = element.querySelector("strong")?.firstChild;
        const last = [...element.querySelectorAll("p")].find(p => p.textContent === "ملاحظات Beta")?.firstChild;
        if (!first || !last) throw new Error("missing text selection endpoints");
        const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.textContent?.length ?? 0);
        const native = document.getSelection(); native?.removeAllRanges(); native?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toContain("Beta");
      await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
    }
    await page.keyboard.press("ControlOrMeta+x");
    const sourceDisk = () => readFileSync(join(E2E_VAULT, source), "utf8");
    await expect.poll(sourceDisk, { timeout: 15_000 }).not.toContain("Alpha");
    expect(sourceDisk()).not.toContain("Beta");
    expect(sourceDisk()).toContain("Before"); expect(sourceDisk()).toContain("After");
    await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
    // Undo is isolated to this cut; redo removes the exact same contents again.
    await page.keyboard.press("ControlOrMeta+z"); await expect.poll(sourceDisk).toBe(initial);
    await page.keyboard.press("ControlOrMeta+Shift+z"); await expect.poll(sourceDisk).not.toContain("Alpha");
    await page.goto(`/v/personal/${encodeURIComponent(destination)}`);
    await expect(editor).toBeVisible();
    await editor.getByText("Here", { exact: true }).click();
    await lineKey(page, "Home");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(editor).toContainText("Alpha ✨");
    await expect(editor).toContainText("ملاحظات Beta");
    await expect(editor.locator("strong")).toHaveText("Alpha");
    const destinationDisk = () => readFileSync(join(E2E_VAULT, destination), "utf8");
    await expect.poll(destinationDisk, { timeout: 15_000 }).toContain("**Alpha** ✨");
    expect(destinationDisk()).toContain("ملاحظات Beta");
    await page.reload(); await expect(editor).toContainText("ملاحظات Beta");
  });
}
