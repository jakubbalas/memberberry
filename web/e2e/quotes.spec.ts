/** Quotes must be visually distinct in the editor and exported HTML without changing Markdown. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("quotes have a themed vertical rule and inset in editor and HTML export", async ({ page, context }, info) => {
  await signIn(page);
  const path = `Quote styling ${info.project.name} ${randomUUID()}.md`;
  const markdown = "# Title\n\nOrdinary text\n\n> A **quoted** thought 🫐\n>\n> Another paragraph\n>\n> > Nested quote\n\nAfter\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: markdown } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  const quote = editor.locator(":scope > blockquote");
  await expect(quote).toContainText("A quoted thought 🫐");
  await expect(quote).toHaveCSS("border-inline-start-style", "solid");
  await expect(quote).toHaveCSS("border-inline-start-width", "3px");
  expect(await quote.evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart))).toBeGreaterThan(0);
  await expect(quote.locator("blockquote")).toHaveCSS("border-inline-start-style", "solid");
  await expect(editor.locator("p").filter({ hasText: /^Ordinary text$/u })).toHaveCSS("border-inline-start-width", "0px");
  const selector = page.getByRole("combobox", { name: /^Theme/ });
  if (!(await selector.isVisible())) await page.getByRole("button", { name: "Show Context" }).click();
  for (const theme of ["memberberry-light", "memberberry-dark", "memberberry-pastel"]) {
    if (!(await selector.isVisible())) await page.getByRole("button", { name: "Show Context" }).click();
    await selector.selectOption(theme);
    const styles = await quote.evaluate(element => {
      const probe = document.createElement("span"); probe.style.color = "var(--text-muted)"; element.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return { color: getComputedStyle(element).borderInlineStartColor, expected };
    });
    expect(styles.color).toBe(styles.expected);
    if (info.project.name === "mobile" && await page.getByRole("button", { name: "Hide Context" }).isVisible()) await page.getByRole("button", { name: "Hide Context" }).click();
    await page.screenshot({ path: info.outputPath(`quote-${theme}.png`) });
  }
  if (info.project.name === "mobile" && await page.getByRole("button", { name: "Hide Context" }).isVisible()) await page.getByRole("button", { name: "Hide Context" }).click();
  await page.getByLabel("More editing tools", { exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export note as self-contained HTML", exact: true }).click();
  const downloadPath = await (await downloadPromise).path();
  if (!downloadPath) throw new Error("missing exported HTML");
  const exported = await context.newPage();
  try {
    await exported.setContent(readFileSync(downloadPath, "utf8"));
    await expect(exported.locator(".tiptap > blockquote")).toHaveCSS("border-inline-start-style", "solid");
  } finally { await exported.close(); }
  expect(readFileSync(join(E2E_VAULT, path), "utf8")).toBe(markdown);
});
