import { expect, signIn, test, openSidebar } from "./fixtures.js";

test("note and folder names offer emoji at the first colon and persist literal glyphs", async ({ page }, info) => {
  await signIn(page); await page.goto("/v/personal");
  await openSidebar(page, "Navigation");
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  for (const kind of ["folder", "note"]) {
    await navigation.getByRole("button", { name: `New ${kind}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `New ${kind}`, exact: true });
    const input = dialog.getByRole("combobox");
    await input.fill(":");
    const suggestions = dialog.getByRole("listbox", { name: "Emoji suggestions" });
    await expect(suggestions).toBeVisible();
    await input.press("Escape"); await expect(suggestions).toBeHidden(); await expect(dialog).toBeVisible();
    await input.fill(":tada");
    await expect(suggestions.getByRole("option").first()).toContainText(":tada:");
    if (info.project.name === "mobile") await suggestions.getByRole("option").first().tap();
    else await input.press("Enter");
    await expect(input).toHaveValue("🎉"); await expect(dialog).toBeVisible();
    const name = `🎉 Emoji ${kind} ${info.project.name}`;
    await input.fill(name);
    await dialog.getByRole("button", { name: kind === "folder" ? "Create folder" : "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    if (kind === "folder") await expect(navigation.getByRole("treeitem", { name, exact: true })).toBeVisible();
    else await expect(page.locator(".ProseMirror").getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await page.reload();
  await openSidebar(page, "Navigation");
  await expect(navigation.getByRole("treeitem", { name: `🎉 Emoji folder ${info.project.name}`, exact: true })).toBeVisible();
});

test("existing shortcode folder labels render glyphs and still target the literal folder", async ({ page }, info) => {
  await signIn(page);
  const path = `:tada: Existing ${info.project.name}`;
  const created = await page.request.post("/api/v1/vaults/personal/folders", { data: { path } });
  expect(created.ok()).toBe(true);
  await page.goto("/v/personal");
  await openSidebar(page, "Navigation");
  const row = page.getByRole("treeitem", { name: `🎉 Existing ${info.project.name}`, exact: true });
  await expect(row).toBeVisible(); await expect(row).toHaveAttribute("title", path);
  await row.getByRole("button").click();
  await page.getByRole("menuitem", { name: "New note", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New note", exact: true });
  await expect(dialog).toContainText(`In ${path}/`);
  await page.keyboard.press("Escape");
});
