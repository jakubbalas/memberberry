// @vitest-environment jsdom

/**
 * The vault settings dialog (`SPEC.md` §11.2, §20.4).
 *
 * Driven against a small in-memory stand-in for the owner-only routes — the network is the
 * genuine external boundary here — so each test can assert what was *sent*, not only what
 * was drawn.
 */

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import SettingsDialog from "./SettingsDialog.svelte";

interface Row { shortcode: string; aliases: string[]; pack: string; file: string; shared: boolean }

function server(initial: { theme?: string; accent?: string | null; emoji?: Row[]; status?: number } = {}) {
  const state = {
    theme: initial.theme ?? "system",
    accent: initial.accent ?? null,
    emoji: initial.emoji ?? [
      { shortcode: "parrot", aliases: ["bird"], pack: "emoji-a", file: "parrot.png", shared: false },
      { shortcode: "ship", aliases: [], pack: "server", file: "ship.png", shared: true },
    ],
  };
  const calls: Array<{ method: string; url: string; body: unknown; signal: AbortSignal | undefined }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body, signal: init?.signal ?? undefined });
    if (initial.status !== undefined) return new Response("", { status: initial.status });
    if (url.endsWith("/settings") && method === "GET") return Response.json(state);
    if (url.endsWith("/settings") && method === "PUT") {
      const update = body as { theme: string; accent: string | null };
      state.theme = update.theme;
      state.accent = update.accent;
      return new Response(null, { status: 204 });
    }
    const alias = /\/emoji-entries\/([^/]+)\/aliases\/([^/]+)$/.exec(url);
    if (alias !== null && method === "DELETE") {
      const row = state.emoji.find((entry) => entry.shortcode === alias[1]);
      if (row !== undefined) row.aliases = row.aliases.filter((name) => name !== alias[2]);
      return new Response(null, { status: 204 });
    }
    const entry = /\/emoji-entries\/([^/]+)$/.exec(url);
    if (entry !== null && method === "DELETE") {
      state.emoji = state.emoji.filter((row) => row.shortcode !== entry[1]);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/rename") && method === "POST") {
      const { from, to } = body as { from: string; to: string };
      const row = state.emoji.find((value) => value.shortcode === from);
      if (row !== undefined) {
        row.aliases = [...row.aliases.filter((name) => name !== to), from];
        row.shortcode = to;
      }
      return Response.json({ to: `:${to}:`, notes: 2, references: 3 });
    }
    const pack = /\/emoji\/packs\/(emoji-[^/]+)$/.exec(url);
    if (pack !== null && method === "PUT") {
      const manifest = (body as { manifest: { emoji: Array<{ shortcode: string; file: string }> } }).manifest;
      const added = manifest.emoji[0];
      if (added !== undefined) state.emoji.push({ shortcode: added.shortcode, aliases: [], pack: pack[1] ?? "", file: added.file, shared: false });
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 500 });
  });
  return { state, calls, fetch };
}

const apps: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => {
  for (const app of apps.splice(0)) await unmount(app);
  document.body.replaceChildren();
});

async function render(fake = server()) {
  const target = document.createElement("div");
  document.body.append(target);
  const ondismiss = vi.fn();
  const onappearance = vi.fn();
  apps.push(mount(SettingsDialog, { target, props: { open: true, vault: "my vault", ondismiss, onappearance, fetch: fake.fetch } }));
  await vi.waitFor(() => expect(target.querySelector("#settings-appearance")).not.toBeNull());
  return { target, ondismiss, onappearance, fake };
}

function button(target: HTMLElement, name: string): HTMLButtonElement {
  const found = [...target.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
}

async function submit(form: HTMLFormElement | null | undefined): Promise<void> {
  form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await tick();
}

async function type(input: HTMLInputElement | null, value: string): Promise<void> {
  if (input === null) throw new Error("missing input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

it("lists the vault's emoji with controls and shared emoji without them", async () => {
  const { target } = await render();
  const local = target.querySelector('[aria-label="This vault\'s emoji"]');
  const shared = target.querySelector('[aria-label="Shared emoji"]');
  expect(local?.textContent).toContain(":parrot:");
  expect(local?.textContent).toContain(":bird:");
  expect(shared?.textContent).toContain(":ship:");
  expect(shared?.querySelectorAll("button")).toHaveLength(0);
  expect(local?.querySelector("img")?.getAttribute("src")).toBe("/api/v1/vaults/my%20vault/emoji/emoji-a/parrot.png");
});

it("saves a custom accent and the default theme, then repaints the window", async () => {
  const { target, onappearance, fake } = await render();
  const select = target.querySelector<HTMLSelectElement>("select");
  if (select === null) throw new Error("no theme select");
  select.value = "memberberry-dark";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  const custom = target.querySelectorAll<HTMLInputElement>('input[name="accent-mode"]')[1];
  custom?.click();
  await tick();
  await type(target.querySelector<HTMLInputElement>('input[type="color"]'), "#3366aa");
  await submit(target.querySelector("#settings-appearance")?.parentElement?.querySelector("form"));
  await vi.waitFor(() => expect(onappearance).toHaveBeenCalledWith("memberberry-dark", "#3366aa"));
  expect(fake.calls.find((call) => call.method === "PUT")?.body).toEqual({ theme: "memberberry-dark", accent: "#3366aa" });
  expect(target.querySelector('[role="status"]')?.textContent).toContain("Appearance saved");
});

it("sends no accent when the theme default is chosen", async () => {
  const { target, onappearance, fake } = await render(server({ accent: "#123456" }));
  const themeDefault = target.querySelectorAll<HTMLInputElement>('input[name="accent-mode"]')[0];
  themeDefault?.click();
  await tick();
  await submit(target.querySelector("#settings-appearance")?.parentElement?.querySelector("form"));
  await vi.waitFor(() => expect(onappearance).toHaveBeenCalledWith("system", undefined));
  expect(fake.calls.find((call) => call.method === "PUT")?.body).toEqual({ theme: "system", accent: null });
});

it("refuses a rename onto a name another emoji uses without sending anything", async () => {
  const fake = server({ emoji: [
    { shortcode: "parrot", aliases: [], pack: "emoji-a", file: "parrot.png", shared: false },
    { shortcode: "ship", aliases: [], pack: "server", file: "ship.png", shared: true },
  ] });
  const { target } = await render(fake);
  button(target, "Rename :parrot:").click();
  await tick();
  const form = target.querySelector<HTMLFormElement>(".settings-emoji-row form");
  await type(form?.querySelector("input") ?? null, "ship");
  await submit(form);
  expect(target.querySelector('[role="alert"]')?.textContent).toContain(":ship: is already used");
  expect(fake.calls.some((call) => call.method === "POST")).toBe(false);
});

it("renames an emoji everywhere and shows the old name as an alias", async () => {
  const { target, fake } = await render();
  button(target, "Rename :parrot:").click();
  await tick();
  const form = target.querySelector<HTMLFormElement>(".settings-emoji-row form");
  await type(form?.querySelector("input") ?? null, ":Party Time:");
  await submit(form);
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toContain(":parrot: still works as an alias"));
  expect(fake.calls.find((call) => call.method === "POST")?.body).toEqual({ kind: "emoji", from: "parrot", to: "party-time" });
  expect(target.querySelector('[role="status"]')?.textContent).toContain("in 2 notes you can see");
  expect(target.querySelector('[aria-label="This vault\'s emoji"]')?.textContent).toContain(":party-time:");
  expect(button(target, "Remove alias :parrot:")).toBeDefined();
});

it("deletes only after confirmation, and says notes keep the text", async () => {
  const { target, fake } = await render();
  button(target, "Delete :parrot:").click();
  await tick();
  expect(fake.calls.some((call) => call.method === "DELETE")).toBe(false);
  button(target, "Delete").click();
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toContain("Notes keep the text :parrot:"));
  expect(fake.calls.find((call) => call.method === "DELETE")?.url).toBe("/api/v1/vaults/my%20vault/emoji-entries/parrot");
  expect(target.querySelector('[aria-label="This vault\'s emoji"]')).toBeNull();
});

it("removes one alias", async () => {
  const { target, fake } = await render();
  button(target, "Remove alias :bird:").click();
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toContain("Removed the alias :bird:"));
  expect(fake.calls.find((call) => call.method === "DELETE")?.url).toBe("/api/v1/vaults/my%20vault/emoji-entries/parrot/aliases/bird");
});

it("adds an image under a chosen shortcode", async () => {
  const { target, fake } = await render();
  const input = target.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  const file = new File([new Uint8Array([137, 80, 78, 71])], "Happy Cat.png", { type: "image/png" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(target.querySelector<HTMLInputElement>(".settings-inline input")?.value).toBe("happy-cat"));
  await submit(target.querySelector<HTMLFormElement>(".settings-inline"));
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toContain("Added :happy-cat:"));
  const put = fake.calls.find((call) => call.method === "PUT" && call.url.includes("/emoji/packs/emoji-"));
  expect(put?.body).toMatchObject({ manifest: { emoji: [{ shortcode: "happy-cat", file: "happy-cat.png" }] } });
});

it("explains a refusal without guessing why", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  apps.push(mount(SettingsDialog, { target, props: { open: true, vault: "v", ondismiss: vi.fn(), onappearance: vi.fn(), fetch: server({ status: 404 }).fetch } }));
  await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain("you may not own this vault"));
  expect(target.querySelector("#settings-appearance")).toBeNull();
});

it("aborts its requests when it is destroyed", async () => {
  const fake = server();
  const { fake: used } = await render(fake);
  const signal = used.calls[0]?.signal;
  expect(signal?.aborted).toBe(false);
  for (const app of apps.splice(0)) await unmount(app);
  expect(signal?.aborted).toBe(true);
});
