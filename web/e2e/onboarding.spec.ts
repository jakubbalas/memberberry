import { spawn } from "node:child_process";
import { chmod, chown, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.js";
import { REPO, E2E_WEB_ROOT } from "./environment.js";

const unprivileged=process.env["MEMBERBERRY_E2E_UID65534"]==="1";
async function startServer(config: string): Promise<{ origin: string; stop: () => Promise<void>; identity?: Readonly<Record<string,string>> }> {
  const binary=join(REPO,"target/debug/memberberry");
  // why: root chmod is not a permission fault; opt in only for the disposable Linux harness.
  const child = unprivileged?spawn("setpriv",["--reuid=65534","--regid=65534","--clear-groups","--bounding-set=-all","--inh-caps=-all","--ambient-caps=-all","--no-new-privs",binary,"serve","--config",config],{cwd:REPO}):spawn(binary,["serve","--config",config],{cwd:REPO});
  child.stderr?.on("data", (chunk: Buffer) => console.error(chunk.toString()));
  const stopped = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
  };
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Fresh server did not start")), 15_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Fresh server exited before readiness")); });
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const address = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
        if (address !== undefined) { clearTimeout(timeout); resolve(address); }
      });
    });
    if(unprivileged){
      if(child.pid===undefined)throw new Error("Missing service PID");const status=await readFile(`/proc/${child.pid}/status`,"utf8");const identity=Object.fromEntries(["Uid","Gid","Groups","CapInh","CapPrm","CapEff","CapBnd","CapAmb","NoNewPrivs"].map(key=>[key,new RegExp(`^${key}:([^\\n]*)$`,"m").exec(status)?.[1]?.trim() ?? "missing"]));
      for(const key of ["Uid","Gid"])expect(identity[key]?.split(/\s+/)).toEqual(["65534","65534","65534","65534"]);expect(identity["Groups"]).toBe("");for(const key of ["CapInh","CapPrm","CapEff","CapBnd","CapAmb"])expect(identity[key]).toBe("0000000000000000");expect(identity["NoNewPrivs"]).toBe("1");return {origin,stop,identity:{pid:String(child.pid),...identity}};
    }
    return { origin, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

test("first launch creates an account and notebooks entirely in the browser", async ({ page, failures }, info) => {
  const directory = await mkdtemp(join(tmpdir(), "memberberry-onboarding-"));
  const config = join(directory, "server.toml");
  await writeFile(config, 'bind = "127.0.0.1:0"\nweb_root = ' + JSON.stringify(E2E_WEB_ROOT) + "\n");
  if(unprivileged){expect(process.platform).toBe("linux");expect(process.getuid?.()).toBe(0);await chown(directory,65534,65534);await chown(config,65534,65534);}
  let server = await startServer(config);const identities=[];if(server.identity)identities.push(server.identity);
  try {
    await page.goto(server.origin);
    await expect(page.getByRole("heading", { name: "Make yourself at home" })).toBeVisible();
    await page.getByLabel("Your name").fill("Notebook Reader");
    await page.getByLabel("Username", { exact: true }).fill("reader");
    await page.getByLabel("Password", { exact: true }).fill("my notebook test password");
    await page.getByLabel("Confirm password").fill("my notebook test password");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Start a new notebook" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    await page.screenshot({ path: info.outputPath("new-vault.png") });
    await page.getByLabel("Vault name").fill("My notebook");
    await page.getByLabel("Vault address").fill("personal");
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await page.locator(".workspace-home").getByRole("button", { name: "New note", exact: true }).click();
    await page.getByRole("dialog", { name: "New note", exact: true }).getByLabel("Name", { exact: true }).fill("First page");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator(".editor-surface .tiptap")).toContainText("First page");
    if (!(await page.getByRole("link", { name: /Your vaults/ }).isVisible())) {
      await page.getByRole("button", { name: "Show Navigation" }).click();
    }
    const vaultLink = await page.getByRole("link", { name: /Your vaults/ }).boundingBox();
    expect(vaultLink?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.getByRole("link", { name: /Your vaults/ }).click();
    await page.getByRole("link", { name: "New vault", exact: true }).click();
    await page.getByLabel("Vault name").fill("Work ideas");
    await page.getByLabel("Vault address").fill("work");
    await page.getByRole("button", { name: "Create vault", exact: true }).click();
    await expect(page).toHaveURL(/\/v\/work$/);
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    if (process.platform !== "win32") {
      failures.allow(/HTTP 503 .*\/v\/work$/);
      failures.allow(/console error: Failed to load resource: the server responded with a status of 503/);
      const notes = join(directory, "vaults/work/notes");
      await page.goto("about:blank");
      await chmod(notes, 0o000);
      try {
        await page.goto(`${server.origin}/v/work`);
        await expect(page.getByRole("heading", { name: "Vault temporarily unavailable" })).toBeVisible();
        await page.getByRole("link", { name: "Back to your vaults" }).click();
        await expect(page.getByRole("link", { name: "My notebook" })).toBeVisible();
      } finally {
        await chmod(notes, 0o755);
      }
    }
    expect(await readFile(join(directory, "vaults/personal/notes/First page.md"), "utf8")).toContain("First page");
    await page.goto("about:blank");
    await server.stop();
    server = await startServer(config);if(server.identity)identities.push(server.identity);
    await page.goto(server.origin);
    await expect(page.getByRole("link", { name: "My notebook" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Work ideas" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    if(unprivileged){expect(identities).toHaveLength(2);await writeFile(info.outputPath("unprivileged-service.json"),JSON.stringify({identities,permission_refusal_observed:true,canonical_markdown_readback:true,fresh_process_catalog_reopened:true,completion_marker:"ONBOARDING-UID65534-COMPLETE"},null,2));console.log("ONBOARDING-UID65534-COMPLETE",info.project.name);}
  } finally {
    await page.goto("about:blank");
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
