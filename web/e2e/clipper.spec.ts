import { test, expect, signIn } from "./fixtures.js";

test("the PWA share screen creates a text clip", async ({ page }, info) => {
  await signIn(page);
  const project = info.project.name;
  const title = `Shared thought ${project}`;
  await page.goto(`/share?title=${encodeURIComponent(title)}&text=${encodeURIComponent("Remember this from another app.")}`);

  await expect(page.getByRole("heading", { name: "Clip to Memberberry" })).toBeVisible();
  await page.getByLabel("Vault").selectOption("personal");
  await page.getByLabel("Folder").fill("Clips");
  await page.getByRole("button", { name: "Save clip" }).click();
  await expect(page.getByRole("status")).toHaveText(`Clipped to Clips/${title}.md`);

  await page.goto(`/v/personal/Clips/${encodeURIComponent(title)}.md`);
  await expect(page.locator(".editor-surface .tiptap")).toContainText("Remember this from another app.");
});
