/** Task presentation and main-panel placement through the real desktop/mobile shell. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

async function openTasks(page: Page): Promise<Locator> {
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Tasks", exact: true }).click();
  const pane = page.locator("#navigation-tasks .inbox-panel");
  await expect(pane).toBeVisible();
  return pane;
}

async function chooseOption(page: Page, pane: Locator, name: string): Promise<void> {
  await pane.getByRole("button", { name: "Task options", exact: true }).click();
  await page.getByRole("menu", { name: "Task options", exact: true }).getByRole("menuitemcheckbox", { name, exact: true }).click();
}

async function openMain(page: Page, pane: Locator): Promise<Locator> {
  await pane.getByRole("button", { name: "Task options", exact: true }).click();
  await page.getByRole("menu", { name: "Task options", exact: true }).getByRole("menuitem", { name: "Open in main panel", exact: true }).click();
  const main = page.locator("main .inbox-main");
  await expect(main).toBeVisible();
  return main;
}

test("task display preferences persist independently, and both headings stick while scrolling", async ({ page }, info) => {
  const filename = `Task display ${info.project.name} ${randomUUID()}.md`;
  const path = `Display/${filename}`;
  await signIn(page);
  const response = await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: `# A different task source heading\n\n${Array.from({ length: 32 }, (_, index) => `- [ ] Display task ${index}`).join("\n")}\n` },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/v/personal/Welcome.md");
  let pane = await openTasks(page);
  const source = pane.locator(`.inbox-task[data-path="${path}"]`).first();
  await expect(source.locator(".inbox-task-source")).toHaveText("A different task source heading");
  await expect(source.locator(".inbox-task-path")).toHaveCount(0);
  await chooseOption(page, pane, "Show filenames");
  await chooseOption(page, pane, "Show file paths");
  await expect(source.locator(".inbox-task-source")).toHaveText(filename);
  await expect(source.locator(".inbox-task-path")).toHaveText(path);

  // The sticky header must stay at the actual sidebar scrollport, not just have sticky CSS.
  const body = page.locator("#sidebar-left .sidebar-body");
  const before = await pane.locator(".inbox-heading").boundingBox();
  if (before === null) throw new Error("Missing tasks heading bounds");
  await body.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => pane.locator(".inbox-heading").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(Math.round(before.y));
  await expect(body).toHaveJSProperty("scrollTop", 400);

  const main = await openMain(page, pane);
  if (info.project.name === "mobile") await expect(page.locator("#sidebar-left")).toBeHidden();
  await expect(main.locator(`.inbox-task[data-path="${path}"]`).first().locator(".inbox-task-source")).toHaveText(filename);
  await expect(page).toHaveURL(/\/v\/personal$/);
  const mainBefore = await main.locator(".inbox-heading").boundingBox();
  if (mainBefore === null) throw new Error("Missing main tasks heading bounds");
  await main.evaluate((element) => { element.scrollTop = 400; });
  await expect.poll(() => main.locator(".inbox-heading").evaluate((element) => Math.round(element.getBoundingClientRect().top))).toBe(Math.round(mainBefore.y));
  await expect(main).toHaveJSProperty("scrollTop", 400);
  const ids = await page.locator("[id]").evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await main.getByRole("button", { name: "Close tasks main panel", exact: true }).click();
  await expect(main).toHaveCount(0);
  await page.reload();
  pane = await openTasks(page);
  await expect(pane.locator(`.inbox-task[data-path="${path}"]`).first().locator(".inbox-task-source")).toHaveText(filename);
  await expect(pane.locator(`.inbox-task[data-path="${path}"]`).first().locator(".inbox-task-path")).toHaveText(path);
  await chooseOption(page, pane, "Show filenames");
  await expect(pane.locator(`.inbox-task[data-path="${path}"]`).first().locator(".inbox-task-source")).toHaveText("A different task source heading");
  await expect(pane.locator(`.inbox-task[data-path="${path}"]`).first().locator(".inbox-task-path")).toHaveText(path);
});

test("the leading checkbox in the main panel completes the canonical source task", async ({ page }, info) => {
  const path = `Task checkbox ${info.project.name} ${randomUUID()}.md`;
  await signIn(page);
  const response = await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path, content: "# Checkbox source\n\n- [ ] Complete from main\n" },
  });
  expect(response.ok()).toBe(true);
  await page.goto("/v/personal/Welcome.md");
  const pane = await openTasks(page);
  const main = await openMain(page, pane);
  const row = main.locator(`.inbox-task-row[data-path="${path}"]`);
  const checkbox = row.getByRole("checkbox", { name: "Complete task: Complete from main", exact: true });
  const box = await checkbox.boundingBox();
  const text = await row.locator(".inbox-task-text").boundingBox();
  if (box === null || text === null) throw new Error("Missing task control geometry");
  expect(box.x + box.width).toBeLessThanOrEqual(text.x);
  const hit = await row.locator(".inbox-task-check").boundingBox();
  if (hit === null) throw new Error("Missing task checkbox target");
  expect(hit.width).toBeGreaterThanOrEqual(44);
  expect(hit.height).toBeGreaterThanOrEqual(44);
  if (info.project.name === "mobile") await checkbox.tap();
  else await checkbox.click();
  await expect(main).toHaveCount(0);
  await expect(page.locator(".editor-surface .tiptap .task-checkbox")).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => readFileSync(join(E2E_VAULT, path), "utf8"), { timeout: 15_000 }).toContain("- [x] Complete from main");
  // Cached inbox rows may survive a source edit. A fresh completion click must not undo it.
  const completed = readFileSync(join(E2E_VAULT, path), "utf8");
  const again = await openMain(page, await openTasks(page));
  const repeated = again.locator(`.inbox-task-row[data-path="${path}"]`).getByRole("checkbox");
  if (info.project.name === "mobile") await repeated.tap();
  else await repeated.click();
  await expect(again).toHaveCount(0);
  await expect(page.locator(".editor-surface .tiptap .task-checkbox")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".connection-status")).toHaveAttribute("data-state", "online");
  await expect(page.locator(".connection-status")).toBeHidden();
  expect(readFileSync(join(E2E_VAULT, path), "utf8")).toBe(completed);
});
