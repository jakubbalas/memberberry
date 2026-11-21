import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { REPO } from "./environment.js";

// The fixture generates disposable credentials. Avoid collecting them in test artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function port(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("fixture port unavailable");
  listener.close();
  await once(listener, "close");
  return address.port;
}

test("Settings requires vault selection, edits token vaults live and shows secrets once", async ({ page, request, browserName }) => {
  const root = await mkdtemp(join(tmpdir(), "mb-mcp-"));
  const [adminPort, mcpPort] = await Promise.all([port(), port()]);
  const origin = `http://127.0.0.1:${adminPort}`;
  const endpoint = `http://127.0.0.1:${mcpPort}/mcp`;
  const config = join(root, "server.toml");
  const password = "disposable fixture password";
  const executable = ["debug", "release"].map((profile) => join(REPO, "target", profile, "memberberry"))
    .filter(existsSync).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (executable === undefined) throw new Error("Build the Memberberry test binary first.");

  const vaults = [
    { slug: "one", name: "Research notebook", title: "Milestone draft" },
    { slug: "two", name: "Project decisions", title: "Milestone decision" },
  ];
  const registrations = await Promise.all(vaults.map(async ({ slug, name, title }) => {
    const path = join(root, slug);
    await mkdir(path);
    await writeFile(join(path, "access.toml"), "[[members]]\nuser = 'alice'\nrole = 'owner'\n");
    await writeFile(join(path, "Update.md"), `# ${title}\n\nDelivery milestone note.\n`);
    return `[[vaults]]\nslug = "${slug}"\nname = "${name}"\npath = ${JSON.stringify(path)}\n`;
  }));
  await writeFile(config, `bind = "127.0.0.1:${adminPort}"\n[mcp]\nlisten = "127.0.0.1:${mcpPort}"\nnote_origin = "${origin}"\n${registrations.join("\n")}`);
  execFileSync(executable, ["user", "setup", "--config", config, "--username", "alice", "--password-stdin"], { input: `${password}\n` });
  const server = spawn(executable, ["serve", "--config", config], { stdio: "ignore" });
  try {
    await expect.poll(async () => {
      try { return (await request.get(origin)).status(); } catch { return 0; }
    }).toBe(200);
    await page.goto(origin);
    await page.getByLabel("Username").fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "MCP access" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Endpoint URL" })).toHaveValue(endpoint);

    // Failed toggle recovery before enabling MCP access.
    const settingsRoute = `**/api/v1/settings/mcp`;
    await page.route(settingsRoute, async (route) => {
      if (route.request().method() === "PATCH") await route.abort();
      else await route.continue();
    });
    const enableToggle = page.getByRole("checkbox", { name: "Enable MCP access" });
    await enableToggle.click();
    await expect(page.getByText("Couldn’t confirm the change.")).toBeVisible();
    await expect(enableToggle).not.toBeChecked();
    await page.unroute(settingsRoute);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(enableToggle).toBeChecked();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();

    // Creating a token requires at least one vault and shows vault display names (not slugs).
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create token" });
    await expect(createDialog.getByRole("checkbox", { name: "one", exact: true })).toHaveCount(0);
    const createSubmit = createDialog.getByRole("button", { name: "Create", exact: true });
    await expect(createSubmit).toBeDisabled();
    await createDialog.getByRole("textbox", { name: "Name", exact: true }).fill("Nod fixture");
    await expect(createSubmit).toBeDisabled();
    await expect(createDialog.getByText("Select at least one vault.")).toBeVisible();
    await createDialog.getByRole("checkbox", { name: "Research notebook", exact: true }).click();
    await expect(createSubmit).toBeEnabled();
    await createSubmit.click();

    const secretField = page.getByRole("textbox", { name: "Access token", exact: true });
    await expect(secretField).toBeVisible();
    const token = await secretField.inputValue();
    expect(token.startsWith("mbm_") && token.length === 68).toBe(true);
    if (browserName === "chromium") {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await page.getByRole("button", { name: "Copy token" }).click();
      await expect(page.getByText("Copied", { exact: true })).toBeVisible();
      const clipboard = await page.evaluate(async () => navigator.clipboard.readText());
      expect(clipboard === token).toBe(true);
      await page.evaluate(async () => navigator.clipboard.writeText(""));

      // Simulate a plain-HTTP LAN/Tailscale page where navigator.clipboard is unavailable:
      // both clicking Copy token and tapping the token box must still write directly to the clipboard.
      await page.evaluate(() => {
        const read = navigator.clipboard.readText.bind(navigator.clipboard);
        const write = navigator.clipboard.writeText.bind(navigator.clipboard);
        (window as unknown as {
          __clipboard?: { read: () => Promise<string>; write: (value: string) => Promise<void> };
        }).__clipboard = { read, write };
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
        const statusEl = document.getElementById("mcp-copy-status");
        if (statusEl) statusEl.textContent = "";
      });
      await page.getByRole("button", { name: "Copy token" }).click();
      await expect(page.getByText("Copied", { exact: true })).toBeVisible();
      const fallbackViaButton = await page.evaluate(async () => {
        const clip = (window as unknown as {
          __clipboard: { read: () => Promise<string>; write: (value: string) => Promise<void> };
        }).__clipboard;
        const text = await clip.read();
        await clip.write("");
        return text;
      });
      expect(fallbackViaButton === token).toBe(true);

      await page.evaluate(() => {
        const statusEl = document.getElementById("mcp-copy-status");
        if (statusEl) statusEl.textContent = "";
      });
      await secretField.click();
      await expect(page.getByText("Copied", { exact: true })).toBeVisible();
      const fallbackViaField = await page.evaluate(async () => {
        const clip = (window as unknown as {
          __clipboard: { read: () => Promise<string>; write: (value: string) => Promise<void> };
        }).__clipboard;
        const text = await clip.read();
        await clip.write("");
        return text;
      });
      expect(fallbackViaField === token).toBe(true);
    }
    await page.getByRole("button", { name: "Done" }).click();
    await expect(secretField).toBeHidden();
    expect((await page.locator("#mcp-secret").inputValue()) === "").toBe(true);
    await page.reload();
    const tokenSection = page.getByRole("region", { name: "Access tokens" });
    await expect(tokenSection.getByText("Nod fixture", { exact: true })).toBeVisible();
    await expect(tokenSection.getByText("Research notebook", { exact: true })).toBeVisible();
    expect((await page.locator("#mcp-secret").inputValue()) === "").toBe(true);

    let id = 0;
    async function mcp(method: string, params: object) {
      return request.post(endpoint, { headers: {
        Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      }, data: { jsonrpc: "2.0", id: ++id, method, params } });
    }
    const initialized = await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Browser fixture", version: "1" } });
    expect(initialized.ok()).toBe(true);
    const search = { name: "search_notes", arguments: { query: "milestone" } };
    const before = await (await mcp("tools/call", search)).json();
    expect(before.result.structuredContent.hits.map((hit: { vault: string }) => hit.vault)).toEqual(["Research notebook"]);
    const firstId: string = before.result.structuredContent.hits[0].id;

    // Edit token vaults: cannot save empty, recovers cleanly from a failed PATCH, applies live.
    await page.getByRole("button", { name: "Edit vaults for Nod fixture" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit vaults" });
    const editFirst = editDialog.getByRole("checkbox", { name: "Research notebook", exact: true });
    const editSecond = editDialog.getByRole("checkbox", { name: "Project decisions", exact: true });
    const editSave = editDialog.getByRole("button", { name: "Save", exact: true });
    await expect(editFirst).toBeChecked();
    await expect(editSecond).not.toBeChecked();
    await expect(editSave).toBeDisabled();

    await editFirst.click();
    await expect(editSave).toBeDisabled();
    await expect(editDialog.getByText("Select at least one vault, or revoke this token.")).toBeVisible();

    await editSecond.click();
    await expect(editSave).toBeEnabled();

    const tokenEditRoute = `**/api/v1/settings/mcp/tokens/*`;
    await page.route(tokenEditRoute, async (route) => {
      if (route.request().method() === "PATCH") await route.abort();
      else await route.continue();
    });
    await editSave.click();
    await expect(editDialog.getByText("Couldn’t confirm the change. Try saving again.")).toBeVisible();
    await expect(editSecond).toBeChecked();
    await page.unroute(tokenEditRoute);
    await editSave.click();
    await expect(editDialog).toBeHidden();
    await expect(page.getByText("Vaults updated", { exact: true })).toBeVisible();
    await expect(tokenSection.getByText("Project decisions", { exact: true })).toBeVisible();
    await expect(tokenSection.getByText("Research notebook", { exact: true })).toHaveCount(0);

    const after = await (await mcp("tools/call", search)).json();
    expect(after.result.structuredContent.hits.map((hit: { vault: string }) => hit.vault)).toEqual(["Project decisions"]);
    const revoked = await (await mcp("tools/call", { name: "fetch_note", arguments: { id: firstId } })).json();
    expect(revoked.result.isError).toBe(true);
    const fetched = await (await mcp("tools/call", { name: "fetch_note", arguments: { id: after.result.structuredContent.hits[0].id } })).json();
    expect(fetched.result.structuredContent.markdown).toContain("Milestone decision");

    await page.getByRole("button", { name: "Revoke Nod fixture" }).click();
    await page.getByRole("dialog", { name: "Revoke token?" }).getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Token revoked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit vaults for Nod fixture" })).toHaveCount(0);
    expect((await mcp("ping", {})).status()).toBe(401);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await rm(root, { force: true, recursive: true });
  }
});
