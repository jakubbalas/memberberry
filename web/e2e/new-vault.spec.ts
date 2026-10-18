import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
import { activateFolderControl, createVaultFolder } from "./folder-actions.js";

test("single New vault action creates managed storage with a blank address", async ({ page }, info) => {
  const server = await folderServer("none");
  try {
    await loginFolderServer(page, server.origin);
    await expect(page.getByRole("link", { name: "Add vault", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "New vault", exact: true })).toHaveCount(1);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await expect(page).toHaveURL(`${server.origin}/vaults/new`);
    await page.getByLabel("Vault name", { exact: true }).fill("Travel 日本");
    await expect(page.getByLabel("Vault address (optional)", { exact: true })).toHaveValue("");
    await expect(page.locator("#managed-path")).toHaveText(`${server.root}/vaults/<vault-address>/notes`);
    await expect(page.getByRole("button", { name: "Create vault", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("new-vault.png"), fullPage: true });
    const posts: string[] = [];
    page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page).toHaveURL(/\/v\/travel-[a-f0-9]{12}$/);
    const slug = new URL(page.url()).pathname.split("/").at(-1);
    if (slug === undefined) throw new Error("Missing created vault");
    expect((await stat(join(server.root, "vaults", slug, "notes"))).isDirectory()).toBe(true);
    expect(await readFile(join(server.root, "vaults", slug, "access.toml"), "utf8")).toContain('user = "alice"');
    expect(posts).toEqual(["/vaults/new"]);
  } finally { await page.goto("about:blank"); await server.stop(); }
});

test("folder overlay creates an exact folder and uses the typed vault address", async ({ page }, info) => {
  const server = await folderServer("empty"), mobile = info.project.name === "mobile";
  const activate = async (name: string) => activateFolderControl(page.getByRole("button", { name, exact: true }), mobile);
  try {
    await loginFolderServer(page, server.origin);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name", { exact: true }).fill("Project notebook");
    await page.getByLabel("Vault address (optional)", { exact: true }).fill("project-notes");
    await activate("Choose folder");
    await createVaultFolder(page, mobile, "New 日本 folder");
    await activate("Cancel");
    expect((await stat(join(server.root, "projects/New 日本 folder"))).isDirectory()).toBe(true);
    await expect(page.locator("#folder-selection")).toBeHidden();
    await activate("Choose folder"); await activate("New 日本 folder"); await activate("Use this folder");
    await activate("Choose folder"); await activate("Go to parent folder");
    await activate("Cancel");
    await expect(page.locator("#selected-path")).toContainText("New 日本 folder");
    await expect(page.getByLabel("Vault address (optional)", { exact: true })).toHaveValue("project-notes");
    await activate("Choose folder");
    await page.screenshot({ path: info.outputPath("folder-picker.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: info.outputPath("folder-picker-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");
    await activate("Create vault");
    await expect(page.getByRole("heading", { name: "Vault registered", exact: true })).toBeVisible();
    const root = join(server.root, "projects/New 日本 folder");
    await expect(stat(join(root, "notes"))).rejects.toThrow();
    expect(await readFile(join(root, "access.toml"), "utf8")).toContain('user = "alice"');
    expect(await readFile(server.config, "utf8")).toContain('slug = "project-notes"');
    await page.getByRole("link", { name: "Open vault", exact: true }).click();
    await expect(page).toHaveURL(`${server.origin}/v/project-notes`);
    await server.restart(); await page.reload();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  } finally { await page.goto("about:blank"); await server.stop(); }
});

test("clearing a selection restores managed storage and duplicate address errors keep the new form", async ({ page, failures }) => {
  const server = await folderServer();
  try {
    await loginFolderServer(page, server.origin);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name", { exact: true }).fill('My <notebook> "日本"');
    await page.getByLabel("Vault address (optional)", { exact: true }).fill("registered");
    await page.getByRole("button", { name: "Choose folder", exact: true }).click();
    await page.getByRole("button", { name: "Empty", exact: true }).click();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    await page.getByRole("button", { name: "Use default folder", exact: true }).click();
    await expect(page.locator("#folder-selection")).toBeHidden();
    failures.allow(/HTTP 409 .*\/vaults\/new$/);
    failures.allow(/console error: Failed to load resource: the server responded with a status of 409/);
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page.locator("#message")).toContainText("Try a different address");
    await expect(page.getByLabel("Vault name", { exact: true })).toHaveValue('My <notebook> "日本"');
    await expect(page.getByLabel("Vault address (optional)", { exact: true })).toHaveValue("registered");
    await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeVisible();
    await page.getByLabel("Vault address (optional)", { exact: true }).fill("managed-notes");
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page).toHaveURL(`${server.origin}/v/managed-notes`);
    expect((await stat(join(server.root, "vaults/managed-notes/notes"))).isDirectory()).toBe(true);
    await expect(stat(join(server.root, "projects/Empty/access.toml"))).rejects.toThrow();
  } finally { await page.goto("about:blank"); await server.stop(); }
});

test("managed creation with an automatic address still works without JavaScript", async ({ browser }) => {
  const server = await folderServer("none"), context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await loginFolderServer(page, server.origin);
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name", { exact: true }).fill("Offline form");
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page).toHaveURL(/\/v\/offline-form-[a-f0-9]{12}$/);
    expect(await readFile(server.config, "utf8")).toContain('name = "Offline form"');
  } finally { await context.close(); await server.stop(); }
});
