import { expect, signIn, test } from "./fixtures.js";

test("folder expansion and collapse survive reload", async ({ page }, info) => {
  await signIn(page);
  const folder = `Expansion ${info.project.name}`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", {
    data: { path: `${folder}/Nested/Note.md` },
  })).ok()).toBe(true);
  await page.goto("/v/personal");
  const showNavigation = async (): Promise<void> => {
    const show = page.getByRole("button", { name: "Show Navigation", exact: true });
    if (await show.isVisible()) await show.click();
  };
  await showNavigation();
  const row = (path: string) => page.getByRole("tree", { name: "Notes", exact: true }).getByTitle(path, { exact: true });
  await row(folder).click();
  await row(`${folder}/Nested`).click();
  await page.reload();
  await showNavigation();
  await expect(row(`${folder}/Nested/Note.md`)).toBeVisible();
  await row(folder).click();
  await page.reload();
  await showNavigation();
  await expect(row(folder)).toHaveAttribute("aria-expanded", "false");
  await expect(row(`${folder}/Nested`)).toHaveCount(0);
  await row(folder).click();
  await expect(row(`${folder}/Nested/Note.md`)).toBeVisible();
});
