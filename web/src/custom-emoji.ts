/** Ephemeral, vault-scoped custom artwork obtained through E22's authorized catalog. */
import type { EmojiEntry } from "./notes.js";

/** One validated custom emoji and its authorized image URL. */
export interface CustomEmoji extends EmojiEntry {
  readonly custom: true;
  readonly imageUrl: string;
}

/** Workspace context used by presentational emoji labels. */
export const EMOJI_VAULT_CONTEXT = Symbol("memberberry.emojiVault");
/** The active authenticated vault; absent for serverless previews. */
export interface EmojiVaultContext { readonly vault: string | undefined }

interface Catalog {
  entries: readonly CustomEmoji[];
  published: CustomEmoji[];
  /** Bumped per request, so only the newest response may replace the entries. */
  generation: number;
  readonly listeners: Set<(entries: readonly CustomEmoji[]) => void>;
  readonly controller: AbortController;
}
const catalogs = new Map<string, Catalog>();
const NAME = /^[a-z0-9_+-]+$/i;

/** Validates wire data and constructs only same-origin, vault-scoped image URLs. */
export function customEmojiEntries(body: unknown, vault: string): readonly CustomEmoji[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((value: unknown): CustomEmoji[] => {
    if (typeof value !== "object" || value === null || !("shortcode" in value) || !("pack" in value) || !("file" in value) || !("aliases" in value)
      || typeof value.shortcode !== "string" || !NAME.test(value.shortcode)
      || typeof value.pack !== "string" || !NAME.test(value.pack)
      || typeof value.file !== "string" || !/^[a-z0-9_+.-]+\.(png|gif|jpe?g|webp)$/i.test(value.file)
      || !Array.isArray(value.aliases) || !value.aliases.every((alias: unknown) => typeof alias === "string" && NAME.test(alias))) return [];
    return [{
      shortcode: value.shortcode, glyph: "", category: value.pack, aliases: value.aliases,
      supportsSkinTone: false, custom: true,
      imageUrl: `/api/v1/vaults/${encodeURIComponent(vault)}/emoji/${encodeURIComponent(value.pack)}/${encodeURIComponent(value.file)}`,
    }];
  });
}

/** Shares one nonblocking request while views exist; the last teardown aborts and forgets it. */
export function observeCustomEmoji(vault: string, changed: (entries: readonly CustomEmoji[]) => void): () => void {
  let catalog = catalogs.get(vault);
  if (catalog === undefined) {
    catalog = { entries: [], published: [], generation: 0, listeners: new Set(), controller: new AbortController() };
    catalogs.set(vault, catalog);
    void load(vault, catalog);
  }
  const current = catalog;
  const listener = (entries: readonly CustomEmoji[]): void => changed(entries);
  current.listeners.add(listener);
  // why: ProseMirror/Svelte must finish mounting before a catalog callback updates its view.
  queueMicrotask(() => { if (current.listeners.has(listener)) listener(current.entries); });
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size === 0 && catalogs.get(vault) === current) {
      current.controller.abort();
      catalogs.delete(vault);
    }
  };
}

/** Publishes a successfully authorized upload to already mounted views in this vault. */
export function publishCustomEmoji(vault: string, entry: CustomEmoji): void {
  const catalog = catalogs.get(vault);
  if (catalog === undefined) return;
  catalog.published = [entry, ...catalog.published.filter((value) => value.shortcode !== entry.shortcode)];
  catalog.entries = merge(catalog.entries, catalog.published);
  notify(catalog);
}

/**
 * Re-reads the catalog for views already mounted in this vault, after Settings deleted or
 * renamed an emoji. Locally published imports are dropped: the server's answer includes them.
 */
export function reloadCustomEmoji(vault: string): void {
  const catalog = catalogs.get(vault);
  if (catalog === undefined) return;
  catalog.published = [];
  void load(vault, catalog);
}

async function load(vault: string, catalog: Catalog): Promise<void> {
  catalog.generation += 1;
  const generation = catalog.generation;
  let entries: readonly CustomEmoji[] = [];
  try {
    const response = await fetch(`/api/v1/vaults/${encodeURIComponent(vault)}/emoji`, {
      credentials: "same-origin", cache: "no-store", signal: catalog.controller.signal,
    });
    if (response.ok) entries = customEmojiEntries(await response.json() as unknown, vault);
  } catch {
    // why: unavailable artwork degrades to the stored shortcode, never blocks note editing.
  }
  if (catalogs.get(vault) !== catalog || catalog.controller.signal.aborted || catalog.generation !== generation) return;
  catalog.entries = merge(entries, catalog.published);
  notify(catalog);
}

function merge(entries: readonly CustomEmoji[], published: readonly CustomEmoji[]): readonly CustomEmoji[] {
  const names = new Set(published.map((entry) => entry.shortcode));
  return [...published, ...entries.filter((entry) => !names.has(entry.shortcode))];
}
function notify(catalog: Catalog): void {
  for (const listener of catalog.listeners) listener(catalog.entries);
}

const lookups = new WeakMap<readonly CustomEmoji[], ReadonlyMap<string, CustomEmoji>>();
/** Resolves canonical names and aliases case-insensitively, reusing immutable catalog maps. */
export function customEmojiLookup(entries: readonly CustomEmoji[]): ReadonlyMap<string, CustomEmoji> {
  let lookup = lookups.get(entries);
  if (lookup === undefined) {
    lookup = new Map(entries.flatMap((entry) => [entry.shortcode, ...entry.aliases].map((name) => [name.toLowerCase(), entry] as const)));
    lookups.set(entries, lookup);
  }
  return lookup;
}

/** Hydrates Rust-rendered emoji spans in authenticated transclusions without parsing Markdown. */
export function hydrateCustomEmoji(root: HTMLElement, vault: string): () => void {
  const placeholders = [...root.querySelectorAll<HTMLElement>(".mb-emoji[data-shortcode]")];
  if (placeholders.length === 0) return () => undefined;
  let cleanup: Array<() => void> = [];
  const stop = observeCustomEmoji(vault, (entries) => {
    for (const close of cleanup) close();
    cleanup = [];
    const lookup = customEmojiLookup(entries);
    for (const placeholder of placeholders) {
      const shortcode = placeholder.dataset["shortcode"] ?? "";
      const literal = `:${shortcode}:`;
      const entry = lookup.get(shortcode.toLowerCase());
      if (entry === undefined) { placeholder.textContent = literal; continue; }
      const image = root.ownerDocument.createElement("img");
      image.className = "custom-emoji-image"; image.alt = literal; image.src = entry.imageUrl; image.draggable = false;
      const error = (): void => { placeholder.textContent = literal; };
      image.addEventListener("error", error);
      cleanup.push(() => image.removeEventListener("error", error));
      placeholder.replaceChildren(image);
    }
  });
  return () => { stop(); for (const close of cleanup) close(); cleanup = []; };
}
