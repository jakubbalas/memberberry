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
export interface ReplicatedTask {
  /** Optional source block anchor. */
  readonly blockId: string | null;
  /** Plain task text. */
  readonly text: string;
  /** Optional task dates in `YYYY-MM-DD` form. */
  readonly due: string | null;
  readonly scheduled: string | null;
  readonly start: string | null;
  readonly created: string | null;
  readonly priority: "highest" | "high" | "medium" | "low" | "lowest" | null;
  readonly ordinal: number;
}

export interface ReplicatedNote {
  readonly path: string;
  readonly title: string | null;
  readonly icon?: string | null;
  readonly tasks?: readonly ReplicatedTask[];
  /**
   * Unresolved conflicts in the note, for §3.5's badge in the tree.
   *
   * Replicated with the title rather than fetched per note, for the same reason the title is:
   * the tree shows every readable note at once, and a badge that needed a request each would
   * not be a badge. It is also what makes the badge work offline, which is the state a
   * conflict is most likely to be discovered in.
   *
   * A record written before this field existed reads as `0` — no badge, rather than a wrong
   * one, until the next listing.
   */
  readonly conflicts: number;
}

/** A note whose body this device holds a copy of. */
export interface ResidentBody {
  readonly vault: string;
  readonly note: string;
  /** Epoch milliseconds, for §7.2's resident-body LRU. */
  readonly openedAt: number;
  /**
   * The document's size when it was last measured, in bytes.
   *
   * Approximate on purpose: it is the encoded Y update, measured when a pane closes, and it
   * is what the 50 MB half of §7.2's cap is counted against. A record written before this
   * field existed reads as `0`, which makes that note look free — the note count is the
   * other half of the cap and catches it.
   */
  readonly bytes: number;
  /**
   * Whether this note has changes the server has not seen.
   *
   * §7.2: eviction never touches a note with unsynced changes. Deleting one would delete the
   * only copy of somebody's writing, so this is the flag that has to be right even when
   * everything else about the LRU is approximate.
   */
  readonly dirty: boolean;
  /**
   * The canonical Markdown this note had when this device and the server were last in sync.
   *
   * §3.5's merge base. Two versions of a note cannot say who changed what — a block only one
   * side has is either an addition or a deletion — so detecting a real collision needs the
   * version they last agreed on. Absent for a note this device has never synced, and for one
   * whose record predates the field; `conflict::merge` degrades to a two-way comparison then.
   *
   * It lives on the resident record, beside the body, because that is what makes it follow
   * the body: dropping a note for the cap, a revocation or a rename drops its base with it,
   * and nothing has to remember to. It is a cache of content that is also in the note, so it
   * is nothing C2 has an opinion about and nothing a permission decision rests on.
   */
  readonly base?: string;
}

/** The subset of IndexedDB this module needs, so a test can supply its own. */
export type Factory = Pick<IDBFactory, "open" | "deleteDatabase">;

/** A note the user has asked to keep available offline (§7.2's pinned tier). */
export interface PinnedNote {
  readonly vault: string;
  readonly note: string;
}

/** One ACL zone the server currently permits this browser to hold (E6). */
export interface SearchZone {
  readonly vault: string;
  readonly zoneId: string;
  readonly aclHash: string;
}

/** Validated compact-index bytes for one currently permitted ACL zone. */
export interface SearchSegment extends SearchZone {
  readonly bytes: Uint8Array;
}

export interface OfflineStore {
  /** Every vault with a stored metadata replica. */
  vaults(): Promise<readonly string[]>;
  /** Replaces the metadata replica for one vault. */
  putNotes(vault: string, notes: readonly ReplicatedNote[]): Promise<void>;
  /** The stored metadata, or `undefined` if this device has never held any. */
  getNotes(vault: string): Promise<readonly ReplicatedNote[] | undefined>;
  /** Records that a note's body is resident, and when it was last opened. */
  putResident(body: ResidentBody): Promise<void>;
  /** One note's record, or `undefined` if this device does not hold it. */
  getResident(vault: string, note: string): Promise<ResidentBody | undefined>;
  /** Every resident body for a vault. */
  residents(vault: string): Promise<readonly ResidentBody[]>;
  /** Forgets one body's bookkeeping. Deleting the document itself is `replica.ts`. */
  deleteResident(vault: string, note: string): Promise<void>;
  /** Marks a note as one to keep offline. Idempotent. */
  putPin(pin: PinnedNote): Promise<void>;
  /** Every pinned note in a vault. */
  pins(vault: string): Promise<readonly PinnedNote[]>;
  deletePin(vault: string, note: string): Promise<void>;
  /** Replaces a vault's permitted zone manifest and drops revoked segment bytes first. */
  reconcileSearchZones(vault: string, zones: readonly SearchZone[]): Promise<readonly SearchZone[]>;
  /** Stores bytes only if their zone and epoch are still in the permitted manifest. */
  putSearchSegment(segment: SearchSegment): Promise<boolean>;
  /** The compact segments whose manifest entries still permit them. */
  searchSegments(vault: string): Promise<readonly SearchSegment[]>;
  /** Forgets everything about a vault: metadata, resident records and pins. */
  deleteVault(vault: string): Promise<void>;
  close(): void;
}

const DATABASE = "memberberry:offline";
/**
 * Version 2 adds the pin store (§7.2).
 *
 * The upgrade creates what is missing and touches nothing else, so a device that has been
 * offline since version 1 keeps its metadata and its resident records rather than starting
 * over — the replica is a cache of things the server sent, but re-fetching a 10 000-note
 * index because a store was added is a bad first impression of an upgrade.
 */
const VERSION = 3;
const NOTES = "notes";
const BODIES = "bodies";
const PINS = "pins";
const SEARCH_ZONES = "search-zones";
const SEARCH_SEGMENTS = "search-segments";
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
    if (!database.objectStoreNames.contains(PINS)) {
      const pins = database.createObjectStore(PINS, { keyPath: ["vault", "note"] });
      pins.createIndex(BY_VAULT, "vault", { unique: false });
    }
    if (!database.objectStoreNames.contains(BODIES)) {
      // why: a composite key rather than `"<vault>:<note>"`. A note path may contain any
      // character, including the separator, so a joined key is one filename away from two
      // notes sharing a record.
      const bodies = database.createObjectStore(BODIES, { keyPath: ["vault", "note"] });
      bodies.createIndex(BY_VAULT, "vault", { unique: false });
    }
    if (!database.objectStoreNames.contains(SEARCH_ZONES)) {
      const zones = database.createObjectStore(SEARCH_ZONES, { keyPath: ["vault", "zoneId"] });
      zones.createIndex(BY_VAULT, "vault", { unique: false });
    }
    if (!database.objectStoreNames.contains(SEARCH_SEGMENTS)) {
      const segments = database.createObjectStore(SEARCH_SEGMENTS, { keyPath: ["vault", "zoneId"] });
      segments.createIndex(BY_VAULT, "vault", { unique: false });
    }
  };
  const database = await promised(open);

  const transaction = (store: string, mode: IDBTransactionMode): IDBObjectStore =>
    database.transaction(store, mode).objectStore(store);

  return {
    async vaults(): Promise<readonly string[]> {
      const keys: unknown = await promised(transaction(NOTES, "readonly").getAllKeys());
      return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
    },
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
    async getResident(vault: string, note: string): Promise<ResidentBody | undefined> {
      const record: unknown = await promised(transaction(BODIES, "readonly").get([vault, note]));
      return readResident(record)[0];
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
    async putPin(pin: PinnedNote): Promise<void> {
      await promised(transaction(PINS, "readwrite").put({ ...pin }));
    },
    async pins(vault: string): Promise<readonly PinnedNote[]> {
      const records: unknown = await promised(
        transaction(PINS, "readonly").index(BY_VAULT).getAll(vault),
      );
      return Array.isArray(records) ? records.flatMap(readPin) : [];
    },
    async deletePin(vault: string, note: string): Promise<void> {
      await promised(transaction(PINS, "readwrite").delete([vault, note]));
    },
    async reconcileSearchZones(vault, zones): Promise<readonly SearchZone[]> {
      const permitted = new Map(zones.map((zone) => [zone.zoneId, zone]));
      const whole = database.transaction([SEARCH_ZONES, SEARCH_SEGMENTS], "readwrite");
      const zoneStore = whole.objectStore(SEARCH_ZONES);
      const segmentStore = whole.objectStore(SEARCH_SEGMENTS);
      const existing: unknown = await promised(zoneStore.index(BY_VAULT).getAll(vault));
      const current = Array.isArray(existing) ? existing.flatMap(readSearchZone) : [];
      for (const zone of current) {
        const replacement = permitted.get(zone.zoneId);
        if (replacement?.aclHash === zone.aclHash) continue;
        await promised(zoneStore.delete([vault, zone.zoneId]));
        await promised(segmentStore.delete([vault, zone.zoneId]));
      }
      const needed: SearchZone[] = [];
      for (const zone of zones) {
        await promised(zoneStore.put({ ...zone }));
        const segment = readSearchSegment(await promised(segmentStore.get([vault, zone.zoneId])))[0];
        if (segment?.aclHash !== zone.aclHash) needed.push(zone);
      }
      await completed(whole);
      return needed;
    },
    async putSearchSegment(segment): Promise<boolean> {
      const whole = database.transaction([SEARCH_ZONES, SEARCH_SEGMENTS], "readwrite");
      const zoneStore = whole.objectStore(SEARCH_ZONES);
      const allowed = readSearchZone(
        await promised(zoneStore.get([segment.vault, segment.zoneId])),
      )[0];
      if (allowed?.aclHash !== segment.aclHash) {
        whole.abort();
        return false;
      }
      await promised(whole.objectStore(SEARCH_SEGMENTS).put({ ...segment, bytes: segment.bytes.slice() }));
      await completed(whole);
      return true;
    },
    async searchSegments(vault): Promise<readonly SearchSegment[]> {
      const zones: unknown = await promised(
        transaction(SEARCH_ZONES, "readonly").index(BY_VAULT).getAll(vault),
      );
      const permitted = new Map(
        (Array.isArray(zones) ? zones.flatMap(readSearchZone) : []).map((zone) => [zone.zoneId, zone]),
      );
      const segments: unknown = await promised(
        transaction(SEARCH_SEGMENTS, "readonly").index(BY_VAULT).getAll(vault),
      );
      return (Array.isArray(segments) ? segments.flatMap(readSearchSegment) : []).filter(
        (segment) => permitted.get(segment.zoneId)?.aclHash === segment.aclHash,
      );
    },
    async deleteVault(vault: string): Promise<void> {
      await promised(transaction(NOTES, "readwrite").delete(vault));
      for (const name of [BODIES, PINS, SEARCH_ZONES, SEARCH_SEGMENTS]) {
        const store = database.transaction(name, "readwrite").objectStore(name);
        const keys: unknown = await promised(store.index(BY_VAULT).getAllKeys(vault));
        if (!Array.isArray(keys)) continue;
        await Promise.all(keys.map((key) => promised(store.delete(key as IDBValidKey))));
      }
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

/** Resolves only after an IndexedDB transaction commits. */
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = (): void => resolve();
    transaction.onabort = (): void => reject(transaction.error ?? new Error("the offline store aborted a transaction"));
    transaction.onerror = (): void => reject(transaction.error ?? new Error("the offline store refused a transaction"));
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
    const { path, title, conflicts, tasks } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path === "") return [];
    if (title !== null && typeof title !== "string") return [];
    return [{
      path,
      title,
      ...(Array.isArray(tasks) ? { tasks: readReplicatedTasks(tasks) } : {}),
      conflicts: typeof conflicts === "number" ? conflicts : 0,
    }];
  });
}

/** Validates task metadata received with a permission-filtered note summary. */
export function readReplicatedTasks(value: unknown): readonly ReplicatedTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReplicatedTask[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const blockId = record["block_id"];
    const text = record["text"];
    const ordinal = record["ordinal"];
    if (blockId !== null && typeof blockId !== "string") return [];
    if (typeof text !== "string" || typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0) return [];
    const fields = ["due", "scheduled", "start", "created"] as const;
    const dates = Object.fromEntries(fields.map((field) => [field, record[field] ?? null]));
    if (fields.some((field) => dates[field] !== null && typeof dates[field] !== "string")) return [];
    const priority = record["priority"];
    const priorities = new Set(["highest", "high", "medium", "low", "lowest"]);
    if (priority !== null && priority !== undefined && (typeof priority !== "string" || !priorities.has(priority))) return [];
    return [{
      blockId,
      text,
      due: dates["due"] as string | null,
      scheduled: dates["scheduled"] as string | null,
      start: dates["start"] as string | null,
      created: dates["created"] as string | null,
      priority: typeof priority === "string" ? priority as ReplicatedTask["priority"] : null,
      ordinal,
    }];
  });
}

function readPin(record: unknown): PinnedNote[] {
  if (typeof record !== "object" || record === null) return [];
  const { vault, note } = record as Record<string, unknown>;
  if (typeof vault !== "string" || typeof note !== "string") return [];
  return [{ vault, note }];
}

function readSearchZone(record: unknown): SearchZone[] {
  if (typeof record !== "object" || record === null) return [];
  const { vault, zoneId, aclHash } = record as Record<string, unknown>;
  if (typeof vault !== "string" || typeof zoneId !== "string" || typeof aclHash !== "string") return [];
  if (vault === "" || !/^[a-f0-9]{64}$/.test(zoneId) || !/^[a-f0-9]{64}$/.test(aclHash)) return [];
  return [{ vault, zoneId, aclHash }];
}

function readSearchSegment(record: unknown): SearchSegment[] {
  const [zone] = readSearchZone(record);
  if (zone === undefined || typeof record !== "object" || record === null) return [];
  const bytes = (record as Record<string, unknown>)["bytes"];
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return [];
  return [{ ...zone, bytes: bytes.slice() }];
}

function readResident(record: unknown): ResidentBody[] {
  if (typeof record !== "object" || record === null) return [];
  const { vault, note, openedAt, bytes, dirty, base } = record as Record<string, unknown>;
  if (typeof vault !== "string" || typeof note !== "string") return [];
  return [
    {
      vault,
      note,
      openedAt: typeof openedAt === "number" ? openedAt : 0,
      bytes: typeof bytes === "number" ? bytes : 0,
      // Anything that is not an explicit `false` is treated as dirty. A record from before
      // this field existed might hold unsent changes and nothing here can tell; refusing to
      // evict it costs one note's worth of quota, and evicting it costs somebody's writing.
      dirty: dirty !== false,
      // Dropped rather than coerced when it is not a string: a base that is not the Markdown
      // this note had is worse than none, because `conflict::merge` trusts it. No base
      // degrades to a comparison that keeps content; a wrong one silently takes a side.
      ...(typeof base === "string" ? { base } : {}),
    },
  ];
}
