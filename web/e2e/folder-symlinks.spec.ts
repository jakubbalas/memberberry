import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
import { activateFolderControl } from "./folder-actions.js";

test("a project containing symbolic links registers and only real files appear after restart", async ({ page }, info) => {
  const server = await folderServer("empty"), mobile = info.project.name === "mobile";
  const project = join(server.root, "projects/Project"), outside = join(server.root, "outside");
  const act = async (name: string) => activateFolderControl(page.getByRole("button", { name, exact: true }), mobile);
  try {
    await mkdir(join(project, "Real"), { recursive: true });
    await mkdir(join(project, "node_modules/.bin"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(project, "Real/Guide.md"), "# Visible guide\n");
    await writeFile(join(outside, "Secret.md"), "# Linked secret body\n");
    for (const [target, name] of [
      ["Real/Guide.md", "Alias.md"], ["Real", "Linked"], [outside, "External"],
      [join(outside, "Secret.md"), "Escape.md"], ["missing", "Broken.md"], [".", "Loop"],
      [join(outside, "Secret.md"), "node_modules/.bin/tool"],
    ]) {
      if (target === undefined || name === undefined) throw new Error("Invalid fixture");
      await symlink(target, join(project, name));
    }
    await loginFolderServer(page, server.origin);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name", { exact: true }).fill("Project notebook");
    await page.getByLabel("Vault address (optional)", { exact: true }).fill("link-project");
    await act("Choose folder"); await act("Project");
    for (const name of ["Linked", "External", "Loop"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await act("Use this folder"); await act("Create vault");
    await expect(page.getByRole("heading", { name: "Vault registered", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open vault", exact: true }).click();
    const checkTree = async () => {
      if (mobile) await page.getByRole("button", { name: "Show Navigation", exact: true }).tap();
      const tree = page.locator('.sidebar[aria-label="Navigation"]');
      await expect(tree.getByRole("button", { name: "Folder actions for Real", exact: true })).toBeVisible();
      for (const name of ["Alias", "Linked", "External", "Escape", "Broken", "Loop", "Linked secret body"]) await expect(tree).not.toContainText(name);
      await tree.getByRole("button", { name: "Folder actions for Real", exact: true }).click();
      await page.getByRole("menuitem", { name: "Open in main panel", exact: true }).click();
      const contents = page.locator(".folder-contents");
      await expect(contents.getByRole("button", { name: "Guide.md", exact: true })).toBeVisible();
      await contents.getByRole("button", { name: "Go to parent folder", exact: true }).click();
      for (const name of ["Alias", "Linked", "External", "Escape", "Broken", "Loop"]) await expect(contents).not.toContainText(name);
    };
    await checkTree();
    const catalog = await page.request.get(`${server.origin}/api/v1/vaults/link-project/notes`);
    expect(catalog.status()).toBe(200);
    expect(await catalog.json()).toMatchObject({ notes: [expect.objectContaining({ path: "Real/Guide.md" })] });
    for (const path of ["Alias.md", "Linked/Guide.md", "External/Secret.md", "Escape.md", "Broken.md", "Loop/Real/Guide.md"]) {
      expect((await page.request.get(`${server.origin}/v/link-project/${path}`)).status()).toBe(404);
    }
    await page.screenshot({ path: info.outputPath("symlinks-omitted.png") });
    await page.goto("about:blank"); await server.restart();
    await page.goto(`${server.origin}/v/link-project`); await checkTree();
    expect(await readFile(join(outside, "Secret.md"), "utf8")).toBe("# Linked secret body\n");
    expect(await readFile(server.config, "utf8")).toContain('slug = "link-project"');
  } finally { await page.goto("about:blank"); await server.stop(); }
});
