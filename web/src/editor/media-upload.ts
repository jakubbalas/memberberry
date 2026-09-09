/** The server response needed to insert one uploaded media object into Markdown. */
export interface MediaUploadResult {
  readonly path: string;
  /** Resolves an optimistic object URL after its offline upload flushes. */
  readonly pending?: Promise<MediaUploadResult>;
}

/** Small fetch surface so upload behavior can be tested without a network. */
export type MediaFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Uploads media to one authenticated vault. The browser supplies the session cookie. */
export interface MediaUploader {
  upload(file: File): Promise<MediaUploadResult>;
  flush(): Promise<void>;
  onResolved?(listener: (from: string, to: string) => void): () => void;
  destroy(): void;
}

export interface QueuedUpload {
  readonly id: string;
  readonly vault: string;
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
  readonly resolvesEditor: boolean;
  readonly originalId?: string;
  readonly originalPath?: string;
  readonly temporaryPath?: string;
}

export interface UploadQueue {
  put(upload: QueuedUpload): Promise<void>;
  all(vault: string): Promise<readonly QueuedUpload[]>;
  delete(id: string): Promise<void>;
  close(): void;
}

export interface PreparedImage {
  readonly display: File;
  readonly original?: File;
}

export interface MediaUploaderOptions {
  readonly maxDimension?: number;
  readonly prepare?: (file: File, maxDimension: number) => Promise<PreparedImage>;
  readonly queue?: Promise<UploadQueue>;
  readonly online?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly uuid?: () => string;
}

interface PendingUpload {
  readonly resolve: (result: MediaUploadResult) => void;
  readonly reject: (error: Error) => void;
  readonly objectUrl: string;
}

/** Creates an uploader with downscaling, original retention, and an IndexedDB offline queue. */
export function createMediaUploader(
  vault: string,
  fetcher: MediaFetch = globalThis.fetch.bind(globalThis),
  options: MediaUploaderOptions = {},
): MediaUploader {
  const endpoint = "/api/v1/vaults/" + encodeURIComponent(vault) + "/media";
  const queue = options.queue ?? (
    globalThis.indexedDB === undefined
      ? Promise.resolve(unavailableQueue)
      : openUploadQueue(globalThis.indexedDB)
  );
  const prepare = options.prepare ?? downscaleImage;
  const maxDimension = options.maxDimension ?? 2560;
  const createObjectURL = options.createObjectURL ?? ((blob: Blob): string => {
    if (typeof URL.createObjectURL !== "function") throw new Error("object URLs are unavailable");
    return URL.createObjectURL(blob);
  });
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string): void => {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  });
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const online = options.online ?? window;
  const pending = new Map<string, PendingUpload>();
  const resumedUrls = new Map<string, string>();
  const listeners = new Set<(from: string, to: string) => void>();

  const send = async (file: File, originalPath?: string): Promise<MediaUploadResult> => {
    let response: Response;
    try {
      const headers: Record<string, string> = { "X-Memberberry-Filename": file.name };
      if (originalPath !== undefined) headers["X-Memberberry-Original"] = originalPath;
      response = await fetcher(endpoint, {
        method: "POST",
        headers,
        body: file,
      });
    } catch (cause: unknown) {
      throw new OfflineUploadError(cause);
    }
    if (!response.ok) throw new Error("media upload failed (" + response.status + ")");
    const raw: unknown = await response.json();
    if (!isMediaUploadResult(raw)) throw new Error("media upload returned an invalid path");
    return raw;
  };

  const enqueue = async (
    file: File,
    resolvesEditor: boolean,
    originalId?: string,
    temporaryPath?: string,
  ): Promise<QueuedUpload> => {
    const upload = {
      id: uuid(),
      vault,
      name: file.name,
      type: file.type,
      bytes: await file.arrayBuffer(),
      resolvesEditor,
      ...(originalId === undefined ? {} : { originalId }),
      ...(temporaryPath === undefined ? {} : { temporaryPath }),
    };
    await (await queue).put(upload);
    return upload;
  };

  const flush = async (): Promise<void> => {
    const store = await queue;
    const uploads = [...await store.all(vault)].sort((left, right) =>
      Number(left.originalId !== undefined) - Number(right.originalId !== undefined)
    );
    const resolvedOriginals = new Map<string, string>();
    for (const upload of uploads) {
      try {
        let activeUpload = upload;
        if (upload.resolvesEditor && !pending.has(upload.id) && upload.temporaryPath !== undefined) {
          const replacement = createObjectURL(new File([upload.bytes], upload.name, { type: upload.type }));
          resumedUrls.set(upload.id, replacement);
          for (const listener of listeners) listener(upload.temporaryPath, replacement);
          activeUpload = { ...upload, temporaryPath: replacement };
          await store.put(activeUpload);
        }
        const originalPath = upload.originalPath ?? (
          upload.originalId === undefined ? undefined : resolvedOriginals.get(upload.originalId)
        );
        const result = await send(
          new File([upload.bytes], upload.name, { type: upload.type }),
          originalPath,
        );
        if (!upload.resolvesEditor) {
          resolvedOriginals.set(upload.id, result.path);
          for (const dependent of uploads) {
            if (dependent.originalId === upload.id) {
              await store.put({ ...dependent, originalPath: result.path });
            }
          }
        }
        await store.delete(upload.id);
        const waiting = pending.get(upload.id);
        if (waiting !== undefined) {
          pending.delete(upload.id);
          revokeObjectURL(waiting.objectUrl);
          waiting.resolve(result);
        } else if (activeUpload.temporaryPath !== undefined) {
          for (const listener of listeners) listener(activeUpload.temporaryPath, result.path);
          const resumed = resumedUrls.get(upload.id);
          if (resumed !== undefined) revokeObjectURL(resumed);
          resumedUrls.delete(upload.id);
        }
      } catch (error: unknown) {
        if (error instanceof OfflineUploadError) return;
        if (!upload.resolvesEditor) {
          for (const dependent of uploads) {
            if (dependent.originalId !== upload.id) continue;
            const dependentWaiting = pending.get(dependent.id);
            if (dependentWaiting !== undefined) {
              pending.delete(dependent.id);
              revokeObjectURL(dependentWaiting.objectUrl);
              dependentWaiting.reject(asError(error));
            }
            await store.delete(dependent.id);
          }
        }
        const waiting = pending.get(upload.id);
        if (waiting !== undefined) {
          pending.delete(upload.id);
          revokeObjectURL(waiting.objectUrl);
          waiting.reject(asError(error));
        }
        await store.delete(upload.id);
      }
    }
  };
  const onOnline = (): void => { void flush(); };
  online.addEventListener("online", onOnline);
  void flush();

  return {
    upload: async (file): Promise<MediaUploadResult> => {
      const prepared = await prepare(file, maxDimension);
      try {
        const original = prepared.original === undefined ? undefined : await send(prepared.original);
        return await send(prepared.display, original?.path);
      } catch (error: unknown) {
        if (!(error instanceof OfflineUploadError)) throw error;
        const original = prepared.original === undefined
          ? undefined
          : await enqueue(prepared.original, false);
        const objectUrl = createObjectURL(prepared.display);
        const queued = await enqueue(prepared.display, true, original?.id, objectUrl);
        const settled = new Promise<MediaUploadResult>((resolve, reject) => {
          pending.set(queued.id, { resolve, reject, objectUrl });
        });
        return { path: objectUrl, pending: settled };
      }
    },
    flush,
    onResolved: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: (): void => {
      online.removeEventListener("online", onOnline);
      void queue.then((store) => store.close());
      for (const waiting of pending.values()) revokeObjectURL(waiting.objectUrl);
      for (const url of resumedUrls.values()) revokeObjectURL(url);
      pending.clear();
      resumedUrls.clear();
      listeners.clear();
    },
  };
}

class OfflineUploadError extends Error {
  constructor(cause: unknown) {
    super("media upload is offline", { cause });
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("media upload failed");
}

async function downscaleImage(file: File, maxDimension: number): Promise<PreparedImage> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return { display: file };
  const image = await createImageBitmap(file);
  try {
    const largest = Math.max(image.width, image.height);
    if (largest <= maxDimension) return { display: file };
    const scale = maxDimension / largest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) return { display: file };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, file.type, 0.86));
    if (blob === null) return { display: file };
    return { display: new File([blob], file.name, { type: blob.type || file.type }), original: file };
  } finally {
    image.close();
  }
}

function isMediaUploadResult(value: unknown): value is MediaUploadResult {
  if (typeof value !== "object" || value === null || !("path" in value)) return false;
  const path = value.path;
  return typeof path === "string"
    && /^media\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9_-]+$/.test(path)
    && path.slice(6, 8) === path.slice(12, 14)
    && path.slice(9, 11) === path.slice(14, 16);
}

export async function openUploadQueue(factory: IDBFactory): Promise<UploadQueue> {
  const request = factory.open("memberberry:media-uploads", 1);
  request.onupgradeneeded = (): void => {
    const uploads = request.result.createObjectStore("uploads", { keyPath: "id" });
    uploads.createIndex("by-vault", "vault", { unique: false });
  };
  const database = await promised(request);
  const store = (mode: IDBTransactionMode): IDBObjectStore =>
    database.transaction("uploads", mode).objectStore("uploads");
  return {
    put: async (upload) => { await promised(store("readwrite").put(upload)); },
    all: async (wantedVault) => {
      const records: unknown = await promised(store("readonly").index("by-vault").getAll(wantedVault));
      return Array.isArray(records) ? records.flatMap(readQueuedUpload) : [];
    },
    delete: async (id) => { await promised(store("readwrite").delete(id)); },
    close: () => database.close(),
  };
}

function readQueuedUpload(value: unknown): QueuedUpload[] {
  if (typeof value !== "object" || value === null) return [];
  const { id, vault, name, type, bytes, resolvesEditor, originalId, originalPath } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof vault !== "string" || typeof name !== "string") return [];
  if (typeof type !== "string" || !(bytes instanceof ArrayBuffer) || typeof resolvesEditor !== "boolean") return [];
  if (originalId !== undefined && typeof originalId !== "string") return [];
  if (originalPath !== undefined && (typeof originalPath !== "string" || !isMediaUploadResult({ path: originalPath }))) return [];
  const temporaryPath = (value as Record<string, unknown>)["temporaryPath"];
  if (temporaryPath !== undefined && (typeof temporaryPath !== "string" || !temporaryPath.startsWith("blob:"))) return [];
  return [{
    id,
    vault,
    name,
    type,
    bytes: bytes.slice(0),
    resolvesEditor,
    ...(typeof originalId === "string" ? { originalId } : {}),
    ...(typeof originalPath === "string" ? { originalPath } : {}),
    ...(typeof temporaryPath === "string" ? { temporaryPath } : {}),
  }];
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("the media queue refused a request"));
  });
}

const unavailableQueue: UploadQueue = {
  put: async () => { throw new Error("offline media storage is unavailable"); },
  all: async () => [],
  delete: async () => undefined,
  close: () => undefined,
};
