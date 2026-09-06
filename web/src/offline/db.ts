/**
 * The local replica's storage (`SPEC.md` §7.2, §7.4).
 *
 * IndexedDB, holding two things: the note metadata for each vault, and a record of which
 * note bodies this device has a copy of. The bodies themselves are not here — each is a Y
 * document in its own `y-indexeddb` database (`collaboration.ts`), which is what the editor
 * binds to. This store is the *bookkeeping* beside them: what exists, when it was last
 * opened, and therefore what can be shown offline and what can be dropped.
 *
 * **Nothing here is a permission decision.** Everything stored is something the server
 * already sent this user; reconciling it when the server's answer changes is `replica.ts`.
 *
 * The API is deliberately small and promise-shaped. IndexedDB's event API is the reason
 * this file exists at all — a feature that had to open a transaction inline would be
 * unreadable, and every caller would repeat the same four lines of `onsuccess`.
 */

/** One note's metadata, as `SPEC.md` §7.2's "always replicated" tier. */
export interface ReplicatedNote {
  readonly path: string;
  readonly title: string | null;
}

/** A note whose body this device holds a copy of. */
export interface ResidentBody {
  readonly vault: string;
  readonly note: string;
  /** Epoch milliseconds, for §7.2's resident-body LRU. */
  readonly openedAt: number;
}

/** The subset of IndexedDB this module needs, so a test can supply its own. */
export type Factory = Pick<IDBFactory, "open" | "deleteDatabase">;

export interface OfflineStore {
  /** Replaces the metadata replica for one vault. */
  putNotes(vault: string, notes: readonly ReplicatedNote[]): Promise<void>;
  /** The stored metadata, or `undefined` if this device has never held any. */
  getNotes(vault: string): Promise<readonly ReplicatedNote[] | undefined>;
  /** Records that a note's body is resident, and when it was last opened. */
  putResident(body: ResidentBody): Promise<void>;
  /** Every resident body for a vault. */
  residents(vault: string): Promise<readonly ResidentBody[]>;
  /** Forgets one body's bookkeeping. Deleting the document itself is `replica.ts`. */
  deleteResident(vault: string, note: string): Promise<void>;
  /** Forgets everything about a vault: its metadata and every resident record. */
  deleteVault(vault: string): Promise<void>;
  close(): void;
}

const DATABASE = "memberberry:offline";
const VERSION = 1;
const NOTES = "notes";
const BODIES = "bodies";
const BY_VAULT = "by-vault";

/**
 * Opens the store, creating it if this is the first visit.
 *
 * Rejects rather than degrading. A caller that cannot open the store has no offline replica
 * and must say so — `replica.ts` turns that into "no stored answer", never into a wrong one.
 */
export async function openOfflineStore(factory: Factory): Promise<OfflineStore> {
  const open = factory.open(DATABASE, VERSION);
  open.onupgradeneeded = (): void => {
    const database = open.result;
    if (!database.objectStoreNames.contains(NOTES)) {
      database.createObjectStore(NOTES, { keyPath: "vault" });
    }
    if (!database.objectStoreNames.contains(BODIES)) {
      // why: a composite key rather than `"<vault>:<note>"`. A note path may contain any
      // character, including the separator, so a joined key is one filename away from two
      // notes sharing a record.
      const bodies = database.createObjectStore(BODIES, { keyPath: ["vault", "note"] });
      bodies.createIndex(BY_VAULT, "vault", { unique: false });
    }
  };
  const database = await promised(open);

  const transaction = (store: string, mode: IDBTransactionMode): IDBObjectStore =>
    database.transaction(store, mode).objectStore(store);

  return {
    async putNotes(vault: string, notes: readonly ReplicatedNote[]): Promise<void> {
      await promised(transaction(NOTES, "readwrite").put({ vault, notes: [...notes] }));
    },
    async getNotes(vault: string): Promise<readonly ReplicatedNote[] | undefined> {
      const record: unknown = await promised(transaction(NOTES, "readonly").get(vault));
      return readNotes(record);
    },
    async putResident(body: ResidentBody): Promise<void> {
      await promised(transaction(BODIES, "readwrite").put({ ...body }));
    },
    async residents(vault: string): Promise<readonly ResidentBody[]> {
      const records: unknown = await promised(
        transaction(BODIES, "readonly").index(BY_VAULT).getAll(vault),
      );
      return Array.isArray(records) ? records.flatMap(readResident) : [];
    },
    async deleteResident(vault: string, note: string): Promise<void> {
      await promised(transaction(BODIES, "readwrite").delete([vault, note]));
    },
    async deleteVault(vault: string): Promise<void> {
      await promised(transaction(NOTES, "readwrite").delete(vault));
      const bodies = database.transaction(BODIES, "readwrite").objectStore(BODIES);
      const keys: unknown = await promised(bodies.index(BY_VAULT).getAllKeys(vault));
      if (!Array.isArray(keys)) return;
      await Promise.all(keys.map((key) => promised(bodies.delete(key as IDBValidKey))));
    },
    close(): void {
      database.close();
    },
  };
}

/** One IndexedDB request as a promise. */
function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void =>
      reject(request.error ?? new Error("the offline store refused a request"));
  });
}

/**
 * Reads a stored metadata record back.
 *
 * Validated on the way out, like anything crossing a boundary (`AGENTS.md` §4.3). This is
 * our own data, but it is data from a previous version of this application, written by a
 * previous release and possibly edited by hand in devtools — and a `path` that is not a
 * string reaches a DOM attribute.
 */
function readNotes(record: unknown): readonly ReplicatedNote[] | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const notes = (record as Record<string, unknown>)["notes"];
  if (!Array.isArray(notes)) return undefined;
  return notes.flatMap((entry): ReplicatedNote[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { path, title } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return [];
    if (title !== null && typeof title !== "string") return [];
    return [{ path, title }];
  });
}

function readResident(record: unknown): ResidentBody[] {
  if (typeof record !== "object" || record === null) return [];
  const { vault, note, openedAt } = record as Record<string, unknown>;
  if (typeof vault !== "string" || typeof note !== "string") return [];
  return [{ vault, note, openedAt: typeof openedAt === "number" ? openedAt : 0 }];
}
