/** Relative dates remain fixed ISO Markdown through edits, local rendering and reload. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test.use({ locale: "en-US", timezoneId: "Europe/Berlin" });

test("relative dates show hover details, edit date/time and persist readable source", async ({ page }, info) => {
  await signIn(page);
  await page.clock.setFixedTime(new Date("2026-10-19T09:20:00Z"));
  const path = `Relative dates ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: "# Dates\n\n2026-10-19 11:19\n\n2026-10-18\n\n2026-10-12\n\n2026-10-25\n\n2026-10-11\n\n2027-07-01\n\nType here\n" },
  })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  const mentions = editor.locator(".mb-date-mention");
  await expect(mentions).toHaveText(["@Today 11:19 AM", "@Yesterday", "@Last Monday", "@Next Sunday", "@October 11, 2026", "@July 1, 2027"]);
  await expect(mentions.first()).toHaveAttribute("title", "Monday, October 19, 2026 at 11:19 AM");
  await mentions.first().click();
  const dialog = page.getByRole("dialog", { name: "Edit date and time" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("2026-10-19");
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveValue("11:19");
  await dialog.getByLabel("Date", { exact: true }).fill("2026-10-20");
  await dialog.getByLabel("Time", { exact: true }).fill("14:30");
  await page.screenshot({ path: info.outputPath("date-dialog.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(mentions.first()).toHaveText("@Tomorrow 2:30 PM");
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toContain("2026-10-20 14:30");
  await page.reload();
  await expect(mentions.first()).toHaveText("@Tomorrow 2:30 PM");
  await mentions.first().focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Include time").uncheck();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(mentions.first()).toHaveText("@Tomorrow");
  await expect.poll(disk).toContain("\n2026-10-20\n");
  await mentions.first().click();
  await dialog.getByLabel("Date", { exact: true }).fill("2027-01-01");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(mentions.first()).toHaveText("@Tomorrow");
  await page.screenshot({ path: info.outputPath("relative-dates.png") });
});

test("typed @now and @today confirm through keyboard and touch choices", async ({ page }, info) => {
  await signIn(page);
  await page.clock.setFixedTime(new Date("2026-10-19T09:20:00Z"));
  const path = `Typed dates ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: "# Typed dates\n\nType here\n" },
  })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  await editor.locator(":scope > p").click();
  await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Type here");
  await page.keyboard.type("@now");
  await expect(page.getByRole("listbox", { name: "Date mentions" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(editor.locator(".mb-date-mention")).toHaveText("@Today 11:20 AM");
  await page.keyboard.type(" @today"); await page.keyboard.press("Tab");
  await page.keyboard.type(" @yesterday ");
  await page.keyboard.type("@tom");
  await page.getByRole("option").filter({ hasText: "@tomorrow" }).click();
  await expect(editor.locator(".mb-date-mention")).toHaveText(["@Today 11:20 AM", "@Today", "@Yesterday", "@Tomorrow"]);
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toBe("# Typed dates\n\n2026-10-19 11:20 2026-10-19 2026-10-18 2026-10-20\n");
  await page.reload();
  await expect(editor.locator(".mb-date-mention")).toHaveCount(4);
  await page.clock.setFixedTime(new Date("2026-10-20T09:20:00Z"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(editor.locator(".mb-date-mention").first()).toHaveText("@Yesterday 11:20 AM");
  await expect.poll(disk).toBe("# Typed dates\n\n2026-10-19 11:20 2026-10-19 2026-10-18 2026-10-20\n");
});

test("source mode, inline code and fenced code preserve literal dates and triggers", async ({ page }, info) => {
  await signIn(page);
  await page.clock.setFixedTime(new Date("2026-10-19T09:20:00Z"));
  const path = `Literal dates ${info.project.name} ${randomUUID()}.md`;
  const content = "# Literal dates\n\n`@today 2026-10-19`\n\n```text\n@now 2026-10-19\n```\n\n2026-10-19\n";
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  await expect(editor.locator(".mb-date-mention")).toHaveText("@Today");
  const toggle = page.getByRole("button", { name: "Toggle Markdown source view", exact: true });
  await toggle.click();
  const source = page.getByRole("textbox", { name: "Markdown source", exact: true });
  await expect(source).toHaveValue(content);
  const changed = content.replace(/2026-10-19\n$/, "2026-10-20\n\n@today\n");
  await source.fill(changed); await toggle.click();
  await expect(editor.locator(".mb-date-mention")).toHaveText("@Tomorrow");
  await expect(editor.locator("code").first()).toHaveText("@today 2026-10-19");
  await expect(editor.locator("pre code")).toHaveText("@now 2026-10-19");
  await expect.poll(() => readFileSync(join(E2E_VAULT, path), "utf8"), { timeout: 15_000 }).toBe(changed);
});

test("date mentions inside typed numbered lists retain editing and Enter continuation", async ({ page }, info) => {
  await signIn(page);
  await page.clock.setFixedTime(new Date("2026-10-19T09:20:00Z"));
  const path = `Combined editor ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: "# Combined editor\n\nType here\n" },
  })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(".editor-surface .tiptap");
  await editor.locator(":scope > p").click();
  await page.keyboard.press("Home"); await page.keyboard.press("Shift+End");
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe("Type here");
  await page.keyboard.type("1. @today"); await page.keyboard.press("Enter");
  const list = editor.locator("ol");
  await expect(list.locator(".mb-date-mention")).toHaveText("@Today");
  await list.locator(".mb-date-mention").click();
  const dialog = page.getByRole("dialog", { name: "Edit date and time" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".block-selection-highlight")).toHaveCount(0);
  await dialog.getByLabel("Date", { exact: true }).fill("2026-10-20");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.keyboard.press("Enter"); await page.keyboard.type("Second");
  await expect(list.locator(":scope > li")).toHaveCount(2);
  await expect(list.locator(".mb-date-mention")).toHaveText("@Tomorrow");
  await expect(list.locator(":scope > li").nth(1)).toHaveText("Second");
  const expected = "# Combined editor\n\n1. 2026-10-20\n1. Second\n";
  await expect.poll(() => readFileSync(join(E2E_VAULT, path), "utf8"), { timeout: 15_000 }).toBe(expected);
  await page.reload();
  await expect(list.locator(":scope > li")).toHaveCount(2);
  await expect(list.locator(".mb-date-mention")).toHaveText("@Tomorrow");
});
