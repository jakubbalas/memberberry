/** Browser-side folder and ZIP import for the server-owned emoji pack format. */

const IMAGE_EXTENSIONS = new Set(["gif", "jpg", "jpeg", "png", "webp"]);
const SHORTCODE = /^[a-z0-9][a-z0-9_+-]*$/;

export interface EmojiImportSource {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly type?: string;
}

export interface EmojiImportAsset {
  readonly shortcode: string;
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly type: string;
  readonly aliases: readonly string[];
}

export interface EmojiImportPlan {
  readonly assets: readonly EmojiImportAsset[];
  readonly collisions: readonly string[];
  readonly invalid: readonly string[];
}

/** Reads image files and ZIP entries without sending anything to the server. */
export async function readEmojiImport(files: readonly File[]): Promise<readonly EmojiImportSource[]> {
  const sources: EmojiImportSource[] = [];
  for (const file of files) {
    if (isZip(file)) {
      sources.push(...await unzip(file));
    } else {
      sources.push({ name: relativeName(file), bytes: new Uint8Array(await file.arrayBuffer()), type: file.type });
    }
  }
  return sources;
}

/** Converts imported files into a deterministic manifest, reporting collisions before upload. */
export function planEmojiImport(
  sources: readonly EmojiImportSource[],
  existingShortcodes: ReadonlySet<string>,
): EmojiImportPlan {
  const assets: EmojiImportAsset[] = [];
  const collisions = new Set<string>();
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const fileName = basename(source.name);
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
    const stem = fileName.slice(0, Math.max(0, fileName.length - extension.length - 1));
    const shortcode = normalizeShortcode(stem);
    if (!IMAGE_EXTENSIONS.has(extension) || shortcode === undefined || source.bytes.length === 0) {
      invalid.push(source.name);
      continue;
    }
    if (seen.has(shortcode) || existingShortcodes.has(shortcode)) collisions.add(shortcode);
    seen.add(shortcode);
    assets.push({ shortcode, file: `${shortcode}.${extension}`, bytes: source.bytes, type: source.type || mimeType(extension), aliases: [] });
  }
  return { assets, collisions: [...collisions].sort(), invalid };
}

/** Encodes one planned import in the bounded JSON shape accepted by the server. */
export function emojiPackUploadBody(packName: string, plan: EmojiImportPlan): string {
  return JSON.stringify({
    manifest: { name: packName, version: 1, emoji: plan.assets.map(({ shortcode, file, aliases }) => ({ shortcode, file, aliases })) },
    files: plan.assets.map(({ file, bytes }) => ({ name: file, content_base64: bytesToBase64(bytes) })),
  });
}

/** Converts a local Slack export (`emoji.json` plus image files) into the pack format. */
export function planSlackEmojiImport(
  sources: readonly EmojiImportSource[],
  existingShortcodes: ReadonlySet<string>,
): EmojiImportPlan {
  const manifest = sources.find((source) => basename(source.name).toLowerCase() === "emoji.json");
  if (manifest === undefined) return { assets: [], collisions: [], invalid: ["emoji.json"] };
  let values: unknown;
  try {
    values = JSON.parse(new TextDecoder().decode(manifest.bytes)) as unknown;
  } catch {
    return { assets: [], collisions: [], invalid: [manifest.name] };
  }
  if (!isStringMap(values)) return { assets: [], collisions: [], invalid: [manifest.name] };
  const images = new Map<string, EmojiImportSource>();
  for (const source of sources) {
    const extension = basename(source.name).split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTENSIONS.has(extension) && source.bytes.length > 0) images.set(basename(source.name).toLowerCase(), source);
  }
  const aliases = new Map<string, string[]>();
  const entries: Array<readonly [string, { source: EmojiImportSource; extension: string }]> = [];
  const invalid: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const shortcode = normalizeShortcode(name);
    if (shortcode === undefined || value.length === 0) {
      invalid.push(name);
      continue;
    }
    if (value.startsWith("alias:")) {
      const target = normalizeShortcode(value.slice("alias:".length));
      if (target === undefined) invalid.push(name);
      else aliases.set(target, [...(aliases.get(target) ?? []), shortcode]);
      continue;
    }
    const sourceName = basename(decodeUrlFile(value)).toLowerCase();
    const source = images.get(sourceName) ?? [...images.entries()].find(([file]) => normalizeShortcode(file.split(".")[0] ?? "") === shortcode)?.[1];
    if (source === undefined) {
      invalid.push(name);
      continue;
    }
    const extension = basename(source.name).split(".").pop()?.toLowerCase() ?? "png";
    entries.push([shortcode, { source, extension }]);
  }
  const collisions = new Set<string>();
  const seen = new Set<string>();
  const assets = entries.map(([shortcode, entry]) => {
    const entryAliases = aliases.get(shortcode) ?? [];
    for (const name of [shortcode, ...entryAliases]) {
      if (existingShortcodes.has(name) || seen.has(name)) collisions.add(name);
      seen.add(name);
    }
    return {
      shortcode,
      file: `${shortcode}.${entry.extension}`,
      bytes: entry.source.bytes,
      type: entry.source.type || mimeType(entry.extension),
      aliases: entryAliases,
    };
  });
  return { assets, collisions: [...collisions].sort(), invalid };
}

export function normalizeShortcode(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_+-]+/g, "-").replace(/^-+|-+$/g, "");
  return SHORTCODE.test(normalized) ? normalized : undefined;
}

function isZip(file: File): boolean {
  return file.type === "application/zip" || file.name.toLowerCase().endsWith(".zip");
}

function relativeName(file: File): string {
  const candidate: unknown = file;
  if (typeof candidate === "object" && candidate !== null && "webkitRelativePath" in candidate) {
    const path = (candidate as { readonly webkitRelativePath?: unknown }).webkitRelativePath;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return file.name;
}

async function unzip(file: File): Promise<readonly EmojiImportSource[]> {
  const { unzipSync } = await import("fflate");
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  return Object.entries(entries).flatMap(([name, bytes]) => {
    if (name.endsWith("/") || name.startsWith("/") || name.split("/").includes("..")) return [];
    return [{ name, bytes, type: mimeType(name.split(".").pop()?.toLowerCase() ?? "") }];
  });
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null
    && Object.values(value).every((entry) => typeof entry === "string");
}

function decodeUrlFile(value: string): string {
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value;
  }
}

function mimeType(extension: string): string {
  return extension === "gif" ? "image/gif"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "webp" ? "image/webp" : "image/png";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
