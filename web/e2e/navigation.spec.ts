import { expect, signIn, test } from "./fixtures.js";

test("navigation shows one tool at a time and preserves search when switching", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal/Themes/Notebook.md");
  await expect(page.locator(".editor-surface .tiptap").first()).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const tools = page.getByRole("group", { name: "Navigation views" });
  await expect(page.getByRole("tree", { name: "Notes", exact: true })).toBeVisible();
  await expect(page.locator(".search-panel")).toBeHidden();
  await expect(page.locator(".tag-pane")).toBeHidden();
  await expect(page.locator(".inbox-panel")).toBeHidden();
  for (const name of ["Notes", "Search", "Tags", "Tasks", "Calendar"]) {
    const button = tools.getByRole("button", { name, exact: true });
    const box = await button.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".navigation-view:visible")).toHaveCount(1);
    await expect(page.locator(".navigation-view:visible")).toHaveAttribute("aria-label", name);
  }
  const search = tools.getByRole("button", { name: "Search", exact: true });
  await search.focus();
  await page.keyboard.press("Enter");
  const input = page.locator('.search-panel input[type="search"]');
  await input.fill("workspace shell");
  await expect(page.locator(".search-result").first()).toBeVisible();
  await tools.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(input).toBeHidden();
  await search.click();
  await expect(input).toHaveValue("workspace shell");
  await tools.getByRole("button", { name: "Notes", exact: true }).click();
  await page.screenshot({ path: `/tmp/memberberry-navigation-${info.project.name}.png` });
});
