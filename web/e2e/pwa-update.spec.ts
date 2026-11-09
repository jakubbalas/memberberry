import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_NOTES, E2E_USER, E2E_WEB_ROOT, REPO } from "./environment.js";
import { expect, signIn, test as base } from "./fixtures.js";
import type { Page } from "@playwright/test";

// Two complete precache downloads run on the resource-limited release fixture.
base.setTimeout(90_000);

/** A server of this test's own, serving a disposable copy of the build. */
interface UpdateServer {
  readonly origin: string;
  /** The copy of `web/dist` this server serves; the test may rewrite it. */
  readonly webRoot: string;
  /** Scratch space on the same filesystem as `webRoot`, outside what the server serves. */
  readonly scratch: string;
}

/** The note the offline-edit test types into. Its own vault, so nothing else reads it. */
const EDIT_NOTE = "Edit.md";

/** Newest of the debug and release CLIs, the same choice `serve.ts` makes for the shared server. */
function memberberryBinary(): string {
  const newest = ["debug", "release"]
    .map((profile) => join(REPO, "target", profile, "memberberry"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) throw new Error("no memberberry binary in target/{debug,release}; run `cargo build -p mb-cli`");
  return newest.path;
}

/**
 * Provisions and runs a throwaway server whose `web_root` is a copy of `web/dist`.
 *
 * why: publishing a "next build" means rewriting the web root. Doing that to the shared
 * `web/dist` raced the other viewport's run of this spec (`ENOTEMPTY` on the asset rename,
 * staging folders left behind) and changed what a running `make dev` served. Port 0, because
 * nothing needs a stable address and every parallel run needs a different one.
 */
async function startUpdateServer(): Promise<{ server: UpdateServer; stop: () => Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), "memberberry-pwa-update-"));
  const webRoot = join(root, "web");
  const scratch = join(root, "scratch");
  const vault = join(root, "vault");
  const config = join(root, "server.toml");
  let stop = async (): Promise<void> => { rmSync(root, { recursive: true, force: true }); };
  try {
    cpSync(E2E_WEB_ROOT, webRoot, { recursive: true });
    mkdirSync(scratch);
    mkdirSync(vault);
    writeFileSync(join(vault, "Welcome.md"), E2E_NOTES["Welcome.md"] ?? "");
    writeFileSync(join(vault, EDIT_NOTE), "# Scratch\n\nA note this test may edit.\n");
    writeFileSync(join(vault, "access.toml"), `[[members]]\nuser = "${E2E_USER.username}"\nrole = "owner"\n`);
    writeFileSync(config, `bind = "127.0.0.1:0"\nweb_root = ${JSON.stringify(webRoot)}\n`);
    const binary = memberberryBinary();
    const run = (args: readonly string[]): void => {
      execFileSync(binary, [...args, "--config", config], { input: `${E2E_USER.password}\n`, stdio: ["pipe", "ignore", "pipe"] });
    };
    run(["user", "setup", "--username", E2E_USER.username, "--password-stdin"]);
    run(["vault", "create", "--slug", "personal", "--name", "Personal", "--path", vault, "--actor", E2E_USER.username, "--password-stdin"]);
    const child = spawn(binary, ["serve", "--config", config], { cwd: REPO });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    stop = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      rmSync(root, { recursive: true, force: true });
    };
    // Drain both pipes for the server's lifetime so it can never block on a full one.
    child.stderr.on("data", () => undefined);
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("PWA update server did not start")), 15_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("PWA update server exited before readiness")); });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (address !== undefined) { clearTimeout(timeout); output = ""; resolve(address); }
      });
    });
    return { server: { origin, webRoot, scratch }, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// why: `baseURL` follows the test's own server, so `signIn` and relative `goto`s reach it
// rather than the shared E2E server, whose web root is the real `web/dist`.
const test = base.extend<{ updateServer: UpdateServer }>({
  // why: an empty pattern, because Playwright reads fixture dependencies from the destructuring.
  updateServer: async ({}, use) => {
    const { server, stop } = await startUpdateServer();
    try { await use(server); } finally { await stop(); }
  },
  baseURL: async ({ updateServer }, use) => { await use(updateServer.origin); },
});

async function checkCurrentWorker(page: Page): Promise<void> {
  // Finish the startup update job before publishing a new worker; the browser coalesces
  // simultaneous update jobs and could otherwise finish checking the previous bytes.
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
}

async function downloadUpdate(page: Page): Promise<void> {
  await checkCurrentWorker(page);
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting?.state ?? registration?.installing?.state ?? "no update";
  }), { timeout: 30_000 }).toBe("installed");
}

/** Publish a second coherent asset identity inside this test's disposable web root only. */
function nextBuild({ webRoot, scratch }: UpdateServer): { entry: string } {
  const htmlFile = join(webRoot, "index.html");
  const workerFile = join(webRoot, "sw.js");
  const html = readFileSync(htmlFile, "utf8");
  const worker = readFileSync(workerFile, "utf8");
  const manifestFile = join(webRoot, "manifest.webmanifest");
  const manifest = readFileSync(manifestFile, "utf8");
  const entry = /src="([^\"]+\.js)"/.exec(html)?.[1];
  if (entry === undefined) throw new Error("missing built application entry");
  // Move the complete module graph together. Renaming just the entry would make lazy
  // chunks import a second copy of Yjs through their unchanged entry references.
  const prefix = "/assets/pwa-update-test/";
  const next = entry.replace("/assets/", prefix);
  // Staged outside `assets` (a directory cannot be copied into itself), then moved in whole
  // so the server never serves a half-rewritten graph.
  const staging = join(scratch, "pwa-update-test");
  cpSync(join(webRoot, "assets"), staging, { recursive: true });
  const rewrite = (directory: string): void => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) rewrite(path);
      else if (/\.(js|css)$/.test(file.name)) writeFileSync(path, readFileSync(path, "utf8").replaceAll("/assets/", prefix));
    }
  };
  rewrite(staging);
  renameSync(staging, join(webRoot, "assets", "pwa-update-test"));
  const nextWorker = worker.replace(/version:"([^\"]+)"/, 'version:"$1-update-test"').replaceAll("/assets/", prefix);
  if (nextWorker === worker || !nextWorker.includes(next)) throw new Error("missing worker precache identity");
  writeFileSync(htmlFile, html.replaceAll("/assets/", prefix));
  writeFileSync(manifestFile, manifest.replaceAll("/assets/", prefix));
  writeFileSync(workerFile, nextWorker);
  return { entry: next };
}

test("an update waits for a click, reloads the new build and leaves another window working", async ({ page, context, updateServer }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  const other = await context.newPage();
  await other.goto("/v/personal/Welcome.md");
  await expect(other.getByText("A note that already exists")).toBeVisible();
  await other.evaluate(() => { document.documentElement.dataset["keptWindow"] = "yes"; });
  await checkCurrentWorker(page);
  const build = nextBuild(updateServer);
  try {
    await downloadUpdate(page);
    await expect(page.getByRole("button", { name: "Reload to update" })).toBeVisible();
    expect(await page.locator('script[type="module"][src]').getAttribute("src")).not.toBe(build.entry);
    await page.screenshot({ path: test.info().outputPath("update-ready.png") });
    await page.getByRole("button", { name: "Reload to update" }).click();
    await expect(page.locator('script[type="module"][src]')).toHaveAttribute("src", build.entry);
    await expect(page.getByText("A note that already exists")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reload to update" })).toHaveCount(0);
    await expect(other.locator("html")).toHaveAttribute("data-kept-window", "yes");
    await expect(other.getByText("A note that already exists")).toBeVisible();
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
  } finally { await other.close(); }
});

test("an update cannot reload over unsent offline edits", async ({ page, context, failures, updateServer }) => {
  await signIn(page);
  await page.goto(`/v/personal/${EDIT_NOTE}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("A note this test may edit");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await checkCurrentWorker(page);
  const build = nextBuild(updateServer);
  try {
    await downloadUpdate(page);
    await expect(page.getByRole("button", { name: "Reload to update" })).toBeVisible();
    failures.allow(/ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource|WebSocket/);
    await context.setOffline(true);
    await editor.getByText("A note this test may edit").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Kept while updating.");
    await page.getByRole("button", { name: "Reload to update" }).click();
    await expect(page.getByText("Reconnect and sync your notes before updating.")).toBeVisible();
    await expect(editor).toContainText("Kept while updating.");
    expect(await page.locator('script[type="module"][src]').getAttribute("src")).not.toBe(build.entry);
    await context.setOffline(false);
    await expect(page.locator(".connection-status")).toBeHidden({ timeout: 15_000 });
  } finally { await context.setOffline(false); }
});
