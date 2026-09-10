/** Durable handoff between the PWA share-target POST and the authenticated share screen. */

export interface SharedFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

export interface PendingShare {
  readonly id: string;
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  readonly files: readonly SharedFile[];
}

export type ShareFactory = Pick<IDBFactory, "open">;

const DATABASE = "memberberry:share-target";
const VERSION = 1;
const STORE = "shares";
const MAX_FILES = 8;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Parses and bounds one browser-delivered multipart share. */
export async function pendingShareFrom(form: FormData, id: string): Promise<PendingShare | undefined> {
  const title = field(form, "title");
  const text = field(form, "text");
  const url = field(form, "url");
  const candidates = form.getAll("files").filter((value): value is File => typeof value !== "string");
  if (candidates.length > MAX_FILES) return undefined;
  let total = 0;
  const files: SharedFile[] = [];
  for (const file of candidates) {
    if (!file.type.startsWith("image/") || file.size === 0 || file.size > MAX_FILE_BYTES) return undefined;
    total += file.size;
    if (total > MAX_TOTAL_BYTES) return undefined;
    files.push({ name: file.name, type: file.type, bytes: await file.arrayBuffer() });
  }
  if (title === undefined && text === undefined && url === undefined && files.length === 0) return undefined;
  return {
    id,
    ...(title === undefined ? {} : { title }),
    ...(text === undefined ? {} : { text }),
    ...(url === undefined ? {} : { url }),
    files,
  };
}

/** Stores one pending share until the user chooses its vault and folder. */
export async function storePendingShare(share: PendingShare, factory: ShareFactory): Promise<void> {
  const database = await open(factory);
  await request(database.transaction(STORE, "readwrite").objectStore(STORE).put(share));
  database.close();
}

/** Reads one pending share without deleting it, so a refused submission can be retried. */
export async function readPendingShare(id: string, factory: ShareFactory): Promise<PendingShare | undefined> {
  const database = await open(factory);
  const stored: unknown = await request(database.transaction(STORE, "readonly").objectStore(STORE).get(id));
  database.close();
  return isPendingShare(stored) ? stored : undefined;
}

/** Deletes a share after its note was created successfully. */
export async function deletePendingShare(id: string, factory: ShareFactory): Promise<void> {
  const database = await open(factory);
  await request(database.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  database.close();
}

/** Handles the installed PWA's multipart share-target request inside the service worker. */
export async function receiveShareTarget(
  incoming: Request,
  factory: ShareFactory,
  id: () => string = () => crypto.randomUUID(),
): Promise<Response> {
  const share = await pendingShareFrom(await incoming.formData(), id());
  if (share === undefined) return new Response("Unsupported share", { status: 400 });
  await storePendingShare(share, factory);
  return Response.redirect(new URL(`/share?share=${encodeURIComponent(share.id)}`, incoming.url), 303);
}

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function open(factory: ShareFactory): Promise<IDBDatabase> {
  const opening = factory.open(DATABASE, VERSION);
  opening.onupgradeneeded = (): void => {
    if (!opening.result.objectStoreNames.contains(STORE)) {
      opening.result.createObjectStore(STORE, { keyPath: "id" });
    }
  };
  return request(opening);
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    value.onsuccess = (): void => resolve(value.result);
    value.onerror = (): void => reject(value.error ?? new Error("share storage failed"));
  });
}

function isPendingShare(value: unknown): value is PendingShare {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["id"] === "string"
    && (record["title"] === undefined || typeof record["title"] === "string")
    && (record["text"] === undefined || typeof record["text"] === "string")
    && (record["url"] === undefined || typeof record["url"] === "string")
    && Array.isArray(record["files"])
    && record["files"].every(isSharedFile);
}

function isSharedFile(value: unknown): value is SharedFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["name"] === "string"
    && typeof record["type"] === "string"
    && record["bytes"] instanceof ArrayBuffer;
}
