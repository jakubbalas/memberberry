/** Full-vault search in a real browser (`SPEC.md` §14.3). */

import { expect, signIn, test } from "./fixtures.js";
import { emptyVaultSlug } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";
const SEARCH = ".search-panel";

test("keeps multiple matching blocks visible as a fedora prefix grows", async ({ page }, info) => {
  await signIn(page);
  const vault = emptyVaultSlug(info.project.name, "search");
  const path = "Linux.md";
  const created = await page.request.post(`/api/v1/vaults/${vault}/notes`, {
    data: { path, content: "# Linux\n\nInstall fedora\n\nUpdate fedora\n\nUpdate fedora\n" },
  });
  expect(created.ok()).toBe(true);
  await page.goto(`/v/${vault}/${path}`);
  await expect(page.locator(EDITOR).first()).toBeVisible();
  const navigation = page.getByRole("button", { name: /^Show Navigation$/ });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Search", exact: true }).click();
  const input = page.locator(`${SEARCH} input[type="search"]`);
  const results = page.locator(`${SEARCH} .search-result`).filter({ has: page.locator(".search-path", { hasText: path }) });
  for (const query of ["fe", "fed", "fedora", "fe"]) {
    await input.fill(query);
    await expect(results).toHaveCount(3);
    for (const result of await results.all()) await expect(result).toBeVisible();
    await expect(results.locator(".search-context")).toHaveText([
      /(?:Install|Update) fedora/, /(?:Install|Update) fedora/, /(?:Install|Update) fedora/,
    ]);
  }
  await results.last().click();
  await expect(page.locator(EDITOR).first()).toContainText("Install fedora");
});

test("shows exact online context and opens a matching note", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
  const navigation = page.getByRole("button", { name: /^Show Navigation$/ });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Search", exact: true }).click();

  const input = page.locator(`${SEARCH} input[type="search"]`);
  await input.fill("workspace shell");
  await expect(page.locator(`${SEARCH} .search-mode`)).toHaveText("Online — exact search");
  const result = page.locator(`${SEARCH} .search-result[data-path="Projects/Roadmap.md"]`);
  await expect(result).toBeVisible();
  await expect(result.locator(".search-context")).toContainText("Ship the workspace shell");
  const box = await result.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThan(0);
  await result.click();
  await expect(page.locator(EDITOR).first()).toContainText("Ship the workspace shell");
});
