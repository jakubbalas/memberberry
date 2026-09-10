/** Authenticated clip transport and durable offline queue for M15. */

import type { CapturedClip } from "./capture.js";

export interface ClipPayload extends CapturedClip {
  readonly path?: string;
  readonly folder?: string;
  readonly tags?: readonly string[];
  readonly template?: string;
}

export interface ClipSuccess {
  readonly path: string;
  readonly source: string;
}

export type ClipResult =
  | { readonly state: "sent"; readonly clip: ClipSuccess }
  | { readonly state: "queued"; readonly id: string };

export interface ClipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ClipTransportOptions {
  readonly vault: string;
  readonly baseUrl?: string;
  readonly token?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: ClipStorage;
  readonly queueKey?: string;
  readonly id?: () => string;
  readonly online?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
}

interface QueuedClip {
  readonly id: string;
  readonly payload: ClipPayload;
}

/** Sends clips and queues only network failures, preserving server refusals for the caller. */
export function createClipTransport(options: ClipTransportOptions) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = options.storage ?? globalThis.localStorage;
  const queueKey = options.queueKey ?? `memberberry.clip.queue:${options.baseUrl ?? "same-origin"}:${options.vault}`;
  const makeId = options.id ?? (() => crypto.randomUUID());

  const load = (): QueuedClip[] => {
    const raw = storage.getItem(queueKey);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isQueuedClip);
    } catch {
      return [];
    }
  };
  const save = (items: readonly QueuedClip[]): void => storage.setItem(queueKey, JSON.stringify(items));
  const endpoint = `${options.baseUrl ?? ""}/api/v1/vaults/${encodeURIComponent(options.vault)}/clip`;

  const send = async (payload: ClipPayload): Promise<ClipSuccess> => {
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
    let response: Response;
    try {
      response = await request(endpoint, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (cause: unknown) {
      throw new OfflineClipError(cause);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new ClipRejectedError(response.status);
    if (!isClipSuccess(body)) throw new ClipRejectedError(response.status);
    return body;
  };

  const flush = async (): Promise<void> => {
    const pending = load();
    for (const item of pending) {
      try {
        await send(item.payload);
        save(load().filter((queued) => queued.id !== item.id));
      } catch (error: unknown) {
        if (error instanceof OfflineClipError) return;
        save(load().filter((queued) => queued.id !== item.id));
      }
    }
  };

  const online = options.online ?? (typeof window === "undefined" ? undefined : window);
  const reconnect = (): void => { void flush(); };
  online?.addEventListener("online", reconnect);
  void flush();

  return {
    clip: async (payload: ClipPayload): Promise<ClipResult> => {
      try {
        return { state: "sent", clip: await send(payload) };
      } catch (error: unknown) {
        if (!(error instanceof OfflineClipError)) throw error;
        const item = { id: makeId(), payload };
        save([...load(), item]);
        return { state: "queued", id: item.id };
      }
    },
    flush,
    pending: (): readonly QueuedClip[] => load(),
    destroy: (): void => online?.removeEventListener("online", reconnect),
  };
}

export class OfflineClipError extends Error {
  public constructor(cause: unknown) {
    super("clip server is unreachable");
    this.cause = cause;
  }

  override readonly cause: unknown;
}

export class ClipRejectedError extends Error {
  public constructor(readonly status: number) {
    super(`clip rejected (${status})`);
  }
}

function isQueuedClip(value: unknown): value is QueuedClip {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["id"] === "string" && isClipPayload(record["payload"]);
}

function isClipPayload(value: unknown): value is ClipPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["url"] === "string" && typeof record["html"] === "string"
    && (record["path"] === undefined || typeof record["path"] === "string")
    && (record["folder"] === undefined || typeof record["folder"] === "string")
    && (record["template"] === undefined || typeof record["template"] === "string")
    && (record["title"] === undefined || typeof record["title"] === "string")
    && (record["author"] === undefined || typeof record["author"] === "string")
    && (record["tags"] === undefined || (Array.isArray(record["tags"])
      && record["tags"].every((tag): tag is string => typeof tag === "string")));
}

function isClipSuccess(value: unknown): value is ClipSuccess {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["path"] === "string" && typeof record["source"] === "string";
}
