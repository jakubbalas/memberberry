import { chmod, chown, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
import { activateFolderControl } from "./folder-actions.js";

test("opt-in checkbox skips real service-inaccessible folders and survives restart", async ({ page, failures }, info) => {
  const server = await folderServer("empty", true), mobile = info.project.name === "mobile";
  const project = join(server.root, "projects/Project");
  const act = async (name: string) => activateFolderControl(page.getByRole("button", { name, exact: true }), mobile);
  try {
    expect(server.serviceUid).not.toBe(0);
    await mkdir(project); await chown(project, server.serviceUid, server.serviceGid);
    for (const name of ["Real", "ReadOnly", "Private"]) {
      const folder = join(project, name); await mkdir(folder); await chown(folder, server.serviceUid, server.serviceGid);
      const note = join(folder, "Guide.md"); await writeFile(note, name === "Real" ? "# Visible guide\n" : "# Excluded confidential body\n"); await chown(note, server.serviceUid, server.serviceGid);
    }
    await symlink("Real/Guide.md", join(project, "Alias.md"));
    await symlink("Private", join(project, "Linked"));
    await chmod(join(project, "ReadOnly"), 0o555); await chmod(join(project, "Private"), 0);
    await loginFolderServer(page, server.origin);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name", { exact: true }).fill("Filtered notebook");
    await page.getByLabel("Vault address (optional)", { exact: true }).fill("filtered-project");
    await act("Choose folder"); await act("Project"); await act("Use this folder");
    const option = page.getByRole("checkbox", { name: "Ignore non-writable folders from vault", exact: true });
    await expect(option).not.toBeChecked();
    failures.allow(/HTTP 503 .*\/vault-locations\/projects\/preview$/);
    failures.allow(/console error: Failed to load resource: the server responded with a status of 503/);
    await act("Create vault");
    await expect(page.locator("#message")).toContainText("Storage, policy");
    await expect(option).not.toBeChecked();
    await option.check();
    if (mobile) await page.setViewportSize({ width: 320, height: 915 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("ignore-folders-option.png"), fullPage: true });
    await act("Create vault");
    await expect(page.getByRole("heading", { name: "Vault registered", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open vault", exact: true }).click();
    const check = async () => {
      if (mobile) await page.getByRole("button", { name: "Show Navigation", exact: true }).tap();
      const tree = page.locator('.sidebar[aria-label="Navigation"]');
      await expect(tree.getByRole("button", { name: "Folder actions for Real", exact: true })).toBeVisible();
      for (const hidden of ["ReadOnly", "Private", "Alias", "Linked", "Excluded confidential body"]) await expect(tree).not.toContainText(hidden);
      await tree.getByRole("button", { name: "Folder actions for Real", exact: true }).click();
      await page.getByRole("menuitem", { name: "Open in main panel", exact: true }).click();
      const contents = page.locator(".folder-contents");
      await expect(contents.getByRole("button", { name: "Guide.md", exact: true })).toBeVisible();
      await contents.getByRole("button", { name: "Go to parent folder", exact: true }).click();
      for (const hidden of ["ReadOnly", "Private", "Alias", "Linked"]) await expect(contents).not.toContainText(hidden);
      const catalog = await page.request.get(`${server.origin}/api/v1/vaults/filtered-project/notes`);
      expect(await catalog.json()).toMatchObject({ notes: [expect.objectContaining({ path: "Real/Guide.md" })] });
      for (const path of ["ReadOnly/Guide.md", "Private/Guide.md", "Alias.md", "Linked/Guide.md"]) expect((await page.request.get(`${server.origin}/v/filtered-project/${path}`)).status()).toBe(404);
    };
    await check();
    expect(await readFile(server.config, "utf8")).toContain("ignore_non_writable_folders = true");
    await page.goto("about:blank"); await server.restart(); await page.goto(`${server.origin}/v/filtered-project`); await check();
    expect((await stat(join(project, "ReadOnly"))).mode & 0o777).toBe(0o555);
    expect((await stat(join(project, "Private"))).mode & 0o777).toBe(0);
  } finally {
    await chmod(join(project, "ReadOnly"), 0o755).catch(() => undefined);
    await chmod(join(project, "Private"), 0o700).catch(() => undefined);
    await page.goto("about:blank"); await server.stop();
  }
});
