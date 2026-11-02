/**
 * The vault settings client (`SPEC.md` §11.2, §20.1).
 *
 * Every call here is owner-only on the server, which answers anybody else with the same 404
 * it gives an unknown vault. The client validates what comes back rather than trusting it
 * (`AGENTS.md` §4.3), and builds image URLs only from validated names.
 */

import { parseAccent } from "./accent.js";
import { shippedTheme, type ShippedTheme } from "./theme.js";
import { emojiUploadBody, normalizeShortcode, type EmojiImportAsset } from "../editor/emoji-import.js";

/** One custom emoji as the settings page lists it. Shared ones are read-only here. */
export interface SettingsEmoji {
  readonly shortcode: string;
  readonly aliases: readonly string[];
  readonly pack: string;
  readonly file: string;
  /** Supplied by the server for every vault (A21); managed by server admins, not owners. */
  readonly shared: boolean;
  readonly imageUrl: string;
}

/** What the owner can change, as the server currently has it. */
export interface VaultSettings {
  readonly theme: ShippedTheme;
  readonly accent: string | undefined;
  readonly emoji: readonly SettingsEmoji[];
}

/** A request that did not succeed, phrased for the person who asked. */
export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

const NAME = /^[a-z0-9_+-]+$/;
const FILE = /^[a-z0-9_+.-]+\.(png|gif|jpe?g|webp)$/i;

function base(vault: string): string {
  return `/api/v1/vaults/${encodeURIComponent(vault)}`;
}

/** Validates the settings payload; `undefined` for anything this version does not understand. */
export function parseSettings(body: unknown, vault: string): VaultSettings | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const theme = shippedTheme(record["theme"]);
  const accent = record["accent"] === null ? undefined : parseAccent(record["accent"]);
  if (theme === undefined || (record["accent"] !== null && accent === undefined) || !Array.isArray(record["emoji"])) {
    return undefined;
  }
  const emoji: SettingsEmoji[] = [];
  for (const value of record["emoji"] as unknown[]) {
    if (typeof value !== "object" || value === null) return undefined;
    const item = value as Record<string, unknown>;
    const { shortcode, pack, file, shared, aliases } = item;
    if (typeof shortcode !== "string" || !NAME.test(shortcode)
      || typeof pack !== "string" || !NAME.test(pack)
      || typeof file !== "string" || !FILE.test(file)
      || typeof shared !== "boolean"
      || !Array.isArray(aliases) || !aliases.every((alias: unknown) => typeof alias === "string" && NAME.test(alias))) {
      return undefined;
    }
    emoji.push({
      shortcode, pack, file, shared, aliases: aliases as string[],
      imageUrl: `${base(vault)}/emoji/${encodeURIComponent(pack)}/${encodeURIComponent(file)}`,
    });
  }
  emoji.sort((left, right) => Number(left.shared) - Number(right.shared) || left.shortcode.localeCompare(right.shortcode));
  return { theme, accent, emoji };
}

async function call(input: string, init: RequestInit, fetcher: typeof fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(input, { credentials: "same-origin", cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new SettingsError("The server could not be reached.");
  }
  if (response.status === 404) {
    throw new SettingsError("Settings are not available — you may not own this vault, or it no longer exists.");
  }
  return response;
}

/** Loads the vault's settings. */
export async function loadSettings(vault: string, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<VaultSettings> {
  const response = await call(`${base(vault)}/settings`, signal === undefined ? {} : { signal }, fetcher);
  if (response.status === 409) throw new SettingsError("This vault's emoji folder holds an invalid pack. Fix or remove it on the server.");
  if (!response.ok) throw new SettingsError("Settings could not be loaded.");
  const parsed = parseSettings(await response.json().catch(() => undefined), vault);
  if (parsed === undefined) throw new SettingsError("The server answered something this version does not understand.");
  return parsed;
}

/** Saves the default theme and accent; `undefined` accent restores each theme's own. */
export async function saveAppearance(
  vault: string,
  theme: ShippedTheme,
  accent: string | undefined,
  signal?: AbortSignal,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<void> {
  const response = await call(`${base(vault)}/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ theme, accent: accent ?? null }),
    ...(signal === undefined ? {} : { signal }),
  }, fetcher);
  if (response.status === 409) throw new SettingsError("The vault's config.toml is not valid TOML. Fix or remove it on the server first.");
  if (!response.ok) throw new SettingsError("Appearance could not be saved.");
}

/** Deletes a vault emoji. Notes keep their `:shortcode:` text. */
export async function deleteEmoji(vault: string, shortcode: string, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const response = await call(`${base(vault)}/emoji-entries/${encodeURIComponent(shortcode)}`, {
    method: "DELETE",
    ...(signal === undefined ? {} : { signal }),
  }, fetcher);
  if (!response.ok) throw new SettingsError(`:${shortcode}: could not be deleted.`);
}

/** Removes one alias of a vault emoji. */
export async function deleteAlias(vault: string, shortcode: string, alias: string, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  const response = await call(`${base(vault)}/emoji-entries/${encodeURIComponent(shortcode)}/aliases/${encodeURIComponent(alias)}`, {
    method: "DELETE",
    ...(signal === undefined ? {} : { signal }),
  }, fetcher);
  if (!response.ok) throw new SettingsError(`:${alias}: could not be removed.`);
}

/** Every name the vault already uses, canonical and alias, for collision checks. */
export function takenNames(emoji: readonly SettingsEmoji[]): ReadonlySet<string> {
  return new Set(emoji.flatMap((entry) => [entry.shortcode, ...entry.aliases]));
}

/**
 * Normalizes what somebody typed into a shortcode, or says why it cannot be one.
 * `own` names the emoji being renamed, whose own aliases are not collisions.
 */
export function checkShortcode(typed: string, taken: ReadonlySet<string>, own?: SettingsEmoji): { readonly shortcode: string } | { readonly error: string } {
  const shortcode = normalizeShortcode(typed.trim().replace(/^:+|:+$/g, ""));
  if (shortcode === undefined) return { error: "Use letters, digits, - + or _." };
  if (own !== undefined && shortcode === own.shortcode) return { error: "That is already its name." };
  if (taken.has(shortcode) && !(own?.aliases.includes(shortcode) ?? false)) {
    return { error: `:${shortcode}: is already used by another emoji.` };
  }
  return { shortcode };
}

/** Uploads one image as a new vault emoji, using a generated storage identifier (§11.2). */
export async function addEmoji(vault: string, asset: EmojiImportAsset, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<SettingsEmoji> {
  const storageId = `emoji-${crypto.randomUUID()}`;
  const response = await call(`${base(vault)}/emoji/packs/${storageId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: emojiUploadBody(storageId, asset),
    ...(signal === undefined ? {} : { signal }),
  }, fetcher);
  if (response.status === 409) throw new SettingsError(`:${asset.shortcode}: is already used by another emoji.`);
  if (!response.ok) throw new SettingsError("The image could not be added. Use one PNG, GIF, JPEG or WebP under 4 MB.");
  return {
    shortcode: asset.shortcode, aliases: [], pack: storageId, file: asset.file, shared: false,
    imageUrl: `${base(vault)}/emoji/${storageId}/${encodeURIComponent(asset.file)}`,
  };
}
