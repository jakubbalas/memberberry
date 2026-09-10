/** Normalizes the browser PWA share-target query into a clip draft. */

import { readPendingShare, type ShareFactory, type SharedFile } from "./share-inbox.js";

export interface SharedClipDraft {
  readonly url?: string;
  readonly title?: string;
  readonly text?: string;
  readonly files?: readonly SharedFile[];
  readonly pendingId?: string;
}

export interface ShareSubmitOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly vault: string;
  readonly folder?: string;
}

export interface SharedClipResult {
  readonly path: string;
  readonly source: string;
}

export function parseShareTarget(search: string): SharedClipDraft | null {
  const params = new URLSearchParams(search);
  const sharedText = params.get("text")?.trim() ?? "";
  const url = params.get("url")?.trim() || firstUrl(sharedText);
  const title = params.get("title")?.trim() ?? "";
  if (url === "" && title === "" && sharedText === "") return null;
  return {
    ...(url === "" ? {} : { url }),
    ...(title === "" ? {} : { title }),
    ...(sharedText === "" ? {} : { text: sharedText }),
  };
}

/** Loads either a GET share or a multipart share staged by the service worker. */
export async function loadShareTarget(
  search: string,
  factory: ShareFactory | undefined = globalThis.indexedDB,
): Promise<SharedClipDraft | null> {
  const params = new URLSearchParams(search);
  const pendingId = params.get("share")?.trim() ?? "";
  if (pendingId === "" || factory === undefined) return parseShareTarget(search);
  const pending = await readPendingShare(pendingId, factory);
  if (pending === undefined) return null;
  return {
    ...(pending.url === undefined ? {} : { url: pending.url }),
    ...(pending.title === undefined ? {} : { title: pending.title }),
    ...(pending.text === undefined ? {} : { text: pending.text }),
    files: pending.files,
    pendingId,
  };
}

export async function submitSharedClip(
  draft: SharedClipDraft,
  options: ShareSubmitOptions,
): Promise<SharedClipResult> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const media = [];
  for (const file of draft.files ?? []) {
    const response = await request(`/api/v1/vaults/${encodeURIComponent(options.vault)}/media`, {
      method: "POST",
      headers: { "X-Memberberry-Filename": file.name },
      body: new Blob([file.bytes], { type: file.type }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isMediaUploadResult(body)) throw new Error("shared image was refused");
    media.push({ path: body.path, alt: file.name });
  }
  const response = await request(`/api/v1/vaults/${encodeURIComponent(options.vault)}/clip`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      ...(draft.url === undefined ? {} : { url: draft.url }),
      ...(draft.title === undefined ? {} : { title: draft.title }),
      ...(draft.text === undefined ? {} : { text: draft.text }),
      ...(options.folder === undefined || options.folder === "" ? {} : { folder: options.folder }),
      ...(media.length === 0 ? {} : { media }),
    }),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isSharedClipResult(body)) throw new Error("shared clip was refused");
  return body;
}

function isMediaUploadResult(value: unknown): value is { readonly path: string } {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["path"] === "string";
}

function firstUrl(text: string): string {
  return text.match(/https?:\/\/[^\s]+/i)?.[0] ?? "";
}

function isSharedClipResult(value: unknown): value is SharedClipResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["path"] === "string" && typeof record["source"] === "string";
}
