import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { emptyVaultRoot, emptyVaultSlug } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

/** A one-pixel PNG, so the image the dialog lists is real artwork the browser decodes. */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("an owner manages appearance and custom emoji from vault settings", async ({ page }, info) => {
  const root = emptyVaultRoot(info.project.name, "settings");
  const slug = emptyVaultSlug(info.project.name, "settings");
  // why: this vault is this test's alone, but a retry starts from whatever the last attempt left.
  rmSync(join(root, ".memberberry", "emoji"), { recursive: true, force: true });
  rmSync(join(root, ".memberberry", "config.toml"), { force: true });
  writeFileSync(join(root, "Party.md"), "# Party\n\nHello :parrot: and `:parrot:`\n");

  await signIn(page);
  await page.goto(`/v/${slug}`);
  await page.getByRole("button", { name: "Vault settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Vault settings", exact: true });
  await expect(dialog.getByRole("heading", { name: "Appearance" })).toBeVisible();
  const viewport = page.viewportSize();
  const bounds = await dialog.boundingBox();
  if (viewport === null || bounds === null) throw new Error("dialog is not laid out");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);

  // Add: one image, under the shortcode its filename suggests.
  await dialog.locator('input[type="file"]').setInputFiles({ name: "parrot.png", mimeType: "image/png", buffer: PIXEL });
  await expect(dialog.getByRole("textbox", { name: "Shortcode for the new emoji" })).toHaveValue("parrot");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Added :parrot:");
  const image = dialog.getByRole("list", { name: "This vault's emoji" }).locator("img");
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // Rename: rewrites the note on disk, but not the code span, and keeps the old name.
  await dialog.getByRole("button", { name: "Rename :parrot:", exact: true }).click();
  await dialog.getByRole("textbox", { name: "New shortcode for :parrot:" }).fill("bird");
  await dialog.getByRole("button", { name: "Rename everywhere", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(":parrot: still works as an alias");
  expect(readFileSync(join(root, "Party.md"), "utf8")).toBe("# Party\n\nHello :bird: and `:parrot:`\n");
  await expect(dialog.getByRole("button", { name: "Remove alias :parrot:", exact: true })).toBeVisible();

  // Appearance: a dark accent on Charcoal is lightened until it reads.
  await dialog.getByRole("combobox", { name: "Default theme" }).selectOption("memberberry-dark");
  await dialog.getByRole("radio", { name: "Custom" }).check();
  await dialog.getByLabel("Custom accent colour").fill("#5b2a86");
  await dialog.getByRole("button", { name: "Save appearance", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Appearance saved");
  await page.screenshot({ path: info.outputPath("settings-dialog.png") });
  const painted = async (): Promise<{ theme: string | undefined; accent: string }> => page.evaluate(() => ({
    theme: document.documentElement.dataset["theme"],
    accent: document.documentElement.style.getPropertyValue("--accent-primary"),
  }));
  await expect.poll(painted).toEqual({ theme: "memberberry-dark", accent: expect.stringMatching(/^#[0-9a-f]{6}$/) as unknown as string });
  const live = await painted();
  expect(live.accent).not.toBe("#5b2a86");
  const config = readFileSync(join(root, ".memberberry", "config.toml"), "utf8");
  expect(config).toContain('theme = "memberberry-dark"');
  expect(config).toContain('accent = "#5b2a86"');

  // Delete: the image goes; the note keeps its text.
  await dialog.getByRole("button", { name: "Delete :bird:", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Notes keep the text :bird:");
  await expect(dialog.getByText("This vault has no custom emoji yet.")).toBeVisible();
  expect(readFileSync(join(root, "Party.md"), "utf8")).toContain(":bird:");

  // A fresh page load paints the saved accent from the server's bootstrap alone.
  await page.reload();
  await expect.poll(painted).toEqual(live);
});
