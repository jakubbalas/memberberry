/** Single-image import encoded for the existing server-owned emoji storage format. */

const IMAGE_EXTENSIONS = new Set(["gif", "jpg", "jpeg", "png", "webp"]);
const SHORTCODE = /^[a-z0-9][a-z0-9_+-]*$/;

/** One image ready to upload under its filename-derived shortcode. */
export interface EmojiImportAsset {
  readonly shortcode: string;
  readonly file: string;
  readonly bytes: Uint8Array;
}

/** Reads one local image without sending anything to the server. */
export async function readEmojiImport(file: File): Promise<EmojiImportAsset | undefined> {
  return planEmojiImport(file.name, new Uint8Array(await file.arrayBuffer()));
}

/** Validates one image filename and derives its shortcode. Empty images are rejected. */
export function planEmojiImport(name: string, bytes: Uint8Array): EmojiImportAsset | undefined {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const stem = name.slice(0, Math.max(0, name.length - extension.length - 1));
  const shortcode = normalizeShortcode(stem);
  if (!IMAGE_EXTENSIONS.has(extension) || shortcode === undefined || bytes.length === 0) return undefined;
  return { shortcode, file: `${shortcode}.${extension}`, bytes };
}

/** Encodes one image using a generated storage identifier, without a user-facing pack name. */
export function emojiUploadBody(storageId: string, asset: EmojiImportAsset): string {
  return JSON.stringify({
    manifest: { name: storageId, version: 1, emoji: [{ shortcode: asset.shortcode, file: asset.file, aliases: [] }] },
    files: [{ name: asset.file, content_base64: bytesToBase64(asset.bytes) }],
  });
}

/** Normalizes a filename stem or replacement into a server-safe shortcode. */
export function normalizeShortcode(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_+-]+/g, "-").replace(/^-+|-+$/g, "");
  return SHORTCODE.test(normalized) ? normalized : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
