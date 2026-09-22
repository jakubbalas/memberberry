import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

test("folders move into another folder and back to root with their notes", async ({ page }, info) => {
  await signIn(page);
  const source = `Move source ${info.project.name}`;
  const destination = `Move destination ${info.project.name}`;
  for (const path of [source, destination, `${source}/Empty`]) {
    expect((await page.request.post("/api/v1/vaults/personal/folders", { data: { path } })).ok()).toBe(true);
  }
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path: `${source}/Nested/Note.md` } })).ok()).toBe(true);
  await page.goto("/v/personal");
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const tree = page.getByRole("tree", { name: "Notes", exact: true });
  const row = (path: string) => tree.getByTitle(path, { exact: true });
  await expect(row(source)).toHaveAttribute("draggable", "true");
  if (info.project.name === "desktop") {
    await row(source).dragTo(row(destination));
  } else {
    await page.getByRole("button", { name: `Move folder ${source}`, exact: true }).click();
    await page.getByRole("dialog", { name: "Move folder", exact: true }).getByLabel("Destination folder").fill(destination);
    await page.getByRole("button", { name: "Move", exact: true }).click();
  }
  await expect(row(`${destination}/${source}`)).toBeVisible();
  expect(readFileSync(join(E2E_VAULT, destination, source, "Nested/Note.md"), "utf8")).toBe("# Note\n");
  expect(existsSync(join(E2E_VAULT, destination, source, "Empty"))).toBe(true);
  expect(existsSync(join(E2E_VAULT, source))).toBe(false);
  if (info.project.name === "desktop") {
    await row(`${destination}/${source}`).dragTo(page.getByRole("group", { name: "Vault root", exact: true }));
  } else {
    await page.getByRole("button", { name: `Move folder ${source}`, exact: true }).click();
    await page.getByRole("button", { name: "Move", exact: true }).click();
  }
  await expect(row(source)).toBeVisible();
  expect(existsSync(join(E2E_VAULT, source, "Nested/Note.md"))).toBe(true);
});
