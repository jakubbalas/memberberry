import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { customEmojiEntries, customEmojiLookup, observeCustomEmoji, publishCustomEmoji, reloadCustomEmoji } from "./custom-emoji.js";

const entry = { shortcode: "3d-printer", pack: "printing", file: "printer.png", aliases: ["3dp"] };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.unstubAllGlobals(); });

it("keeps valid catalog URLs inside the selected vault and preserves alias resolution", () => {
  const name = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_+-"), { minLength: 1, maxLength: 24 }).map((letters) => letters.join(""));
  fc.assert(fc.property(name, name, name, name, fc.string(), (shortcode, alias, pack, file, vault) => {
    const entries = customEmojiEntries([{ shortcode, aliases: [alias], pack, file: `${file}.png` }], vault);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.imageUrl).toBe(`/api/v1/vaults/${encodeURIComponent(vault)}/emoji/${encodeURIComponent(pack)}/${encodeURIComponent(file)}.png`);
    expect(customEmojiLookup(entries).get(alias.toLowerCase())).toBe(entries[0]);
  }), { seed: 20261102, numRuns: 100 });
});

it("constructs authorized URLs and resolves aliases without accepting external image sources", () => {
  const entries = customEmojiEntries([entry, { ...entry, file: "https://evil.test/a.png" }, { ...entry, pack: "../secret" }, { ...entry, aliases: [7] }], "my vault");
  expect(entries).toHaveLength(1);
  expect(customEmojiLookup(entries).get("3dp")?.imageUrl).toBe("/api/v1/vaults/my%20vault/emoji/printing/printer.png");
});

it.each([null, {}, "html", [null], [{ shortcode: "name" }]])("rejects malformed catalogs %j", (value) => {
  expect(customEmojiEntries(value, "v")).toEqual([]);
});

it("shares an authorized request between views and aborts/forgets it after the last teardown", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([entry])));
  vi.stubGlobal("fetch", fetchMock);
  const first = vi.fn(); const second = vi.fn();
  const stopFirst = observeCustomEmoji("shared", first); cleanups.push(stopFirst);
  const stopSecond = observeCustomEmoji("shared", second); cleanups.push(stopSecond);
  await vi.waitFor(() => expect(second.mock.lastCall?.[0]).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("same-origin");
  const signal = fetchMock.mock.calls[0]?.[1]?.signal;
  stopFirst(); expect(signal?.aborted).toBe(false);
  stopSecond(); expect(signal?.aborted).toBe(true);
  fetchMock.mockResolvedValueOnce(new Response("[]"));
  cleanups.push(observeCustomEmoji("shared", vi.fn()));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([403, 404, 500])("returns no artwork when the vault catalog denies or fails with %s", async (status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([entry]), { status })));
  const changed = vi.fn(); cleanups.push(observeCustomEmoji(`denied-${status}`, changed));
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(changed.mock.calls.every(([entries]) => Array.isArray(entries) && entries.length === 0)).toBe(true);
});

it("keeps a newly imported image when an older catalog request finishes later", async () => {
  let finish: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const changed = vi.fn(); cleanups.push(observeCustomEmoji("race", changed));
  const imported = customEmojiEntries([entry], "race")[0];
  if (imported === undefined) throw new Error("fixture invalid");
  publishCustomEmoji("race", imported);
  finish(new Response(JSON.stringify([{ ...entry, shortcode: "older", aliases: [] }])));
  await vi.waitFor(() => expect(changed.mock.lastCall?.[0].some((value: { shortcode: string }) => value.shortcode === "older")).toBe(true));
  expect(changed.mock.lastCall?.[0]).toContainEqual(imported);
});

it("does not deliver a late response or an upload to another vault", async () => {
  let finish: (response: Response) => void = () => undefined;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const changed = vi.fn(); const stop = observeCustomEmoji("stopped", changed); cleanups.push(stop);
  stop(); finish(new Response(JSON.stringify([entry])));
  const imported = customEmojiEntries([entry], "other")[0];
  if (imported === undefined) throw new Error("fixture invalid");
  publishCustomEmoji("other", imported);
  await Promise.resolve(); await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
});

it("reloads mounted views after settings change the catalog, and an older response cannot win", async () => {
  let resolveFirst: ((response: Response) => void) | undefined;
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(new Response(JSON.stringify([{ ...entry, shortcode: "renamed", aliases: ["3d-printer"] }])));
  vi.stubGlobal("fetch", fetchMock);
  const changed = vi.fn();
  cleanups.push(observeCustomEmoji("reload", changed));
  reloadCustomEmoji("reload");
  await vi.waitFor(() => expect(changed.mock.lastCall?.[0]?.[0]?.shortcode).toBe("renamed"));
  resolveFirst?.(new Response(JSON.stringify([entry])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(changed.mock.lastCall?.[0]?.[0]?.shortcode).toBe("renamed");
});

it("does nothing when no view in that vault is mounted", () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  reloadCustomEmoji("nobody-watching");
  expect(fetchMock).not.toHaveBeenCalled();
});
