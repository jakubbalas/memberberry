/**
 * Which notes of a server vault the desktop app keeps on disk (`SPEC.md` §7.6.10).
 *
 * The embedded server answers `GET /api/v1/vaults/{slug}/offline` for a server vault with its
 * pins, the notes downloaded, whether the server is reachable and any held notes. On a
 * plain server the route does not exist, and in the app a vault only on this device answers
 * `{"server": false}`; either way none of this applies and nothing is offered.
 *
 * Plain functions over a snapshot, so the rules are tested without a component.
 */

/** A pin: one note, a folder and what is under it, or the whole vault. */
export type PinKind = "note" | "folder" | "vault";

export interface OfflinePins {
  readonly vault: boolean;
  readonly folders: readonly string[];
  readonly notes: readonly string[];
}

export interface HeldNote {
  readonly path: string;
  readonly reason: string;
}

/**
 * A note that left the server with edits made on this computer, kept here until the user
 * chooses what becomes of it (`SPEC.md` §7.6.7).
 */
export interface RecoveredNote {
  /** Where it is now: `Recovered/<name> (offline edits).md`. */
  readonly path: string;
  /** The path it had when this computer could last read it. */
  readonly original: string;
  /** "Create the note again" was refused; only "Make a new note" is offered. */
  readonly createAgainRefused: boolean;
}

/** What the embedded server says about one server vault. */
export interface OfflineSnapshot {
  readonly online: boolean;
  readonly pins: OfflinePins;
  readonly downloaded: readonly string[];
  readonly held: readonly HeldNote[];
  readonly recovered: readonly RecoveredNote[];
}

function recoveredNotes(value: unknown): readonly RecoveredNote[] | undefined {
  // An older embedded server sends no list: nothing is recovered.
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const notes: RecoveredNote[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    const path = item["path"];
    const original = item["original"];
    const refused = item["create_again_refused"] ?? false;
    if (typeof path !== "string" || typeof original !== "string" || typeof refused !== "boolean") return undefined;
    notes.push({ path, original, createAgainRefused: refused });
  }
  return notes;
}

/** One context-menu entry. */
export interface OfflineAction {
  readonly label: string;
  readonly kind: PinKind;
  readonly path: string;
  readonly offline: boolean;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/**
 * Validates the endpoint's answer. `undefined` for anything that is not a server vault's
 * state — including a well-formed `{"server": false}` — so a caller has one thing to check.
 */
export function readOfflineState(body: unknown): OfflineSnapshot | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record["server"] !== true || typeof record["online"] !== "boolean") return undefined;
  const pins = record["pins"];
  if (typeof pins !== "object" || pins === null) return undefined;
  const pinRecord = pins as Record<string, unknown>;
  const folders = strings(pinRecord["folders"]);
  const notes = strings(pinRecord["notes"]);
  const downloaded = strings(record["downloaded"]);
  const heldRaw = record["held"];
  if (typeof pinRecord["vault"] !== "boolean" || folders === undefined || notes === undefined) return undefined;
  if (downloaded === undefined || !Array.isArray(heldRaw)) return undefined;
  const held: HeldNote[] = [];
  for (const entry of heldRaw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const item = entry as Record<string, unknown>;
    const path = item["path"];
    const reason = item["reason"];
    if (typeof path !== "string" || typeof reason !== "string") return undefined;
    held.push({ path, reason });
  }
  const recovered = recoveredNotes(record["recovered"]);
  if (recovered === undefined) return undefined;
  return {
    online: record["online"],
    pins: { vault: pinRecord["vault"], folders, notes },
    downloaded,
    held,
    recovered,
  };
}

/** The folder pin that keeps `path` offline, if any. */
function folderHolding(pins: OfflinePins, path: string): string | undefined {
  return pins.folders.find((folder) => path.startsWith(`${folder}/`));
}

/** Whether `path` is kept offline by any pin. */
export function covers(pins: OfflinePins, path: string): boolean {
  return pins.vault || pins.notes.includes(path) || folderHolding(pins, path) !== undefined;
}

/**
 * The one offline entry for a note's or folder's context menu.
 *
 * A note kept offline by a folder or the vault offers no "Online only" of its own: releasing
 * it alone is refused, so the menu says what holds it instead of offering an action that
 * cannot work.
 */
export function actionFor(snapshot: OfflineSnapshot, path: string, kind: "note" | "folder"): OfflineAction | undefined {
  const { pins } = snapshot;
  if (kind === "folder") {
    if (pins.vault) return undefined;
    const exact = pins.folders.includes(path);
    if (!exact && folderHolding(pins, path) !== undefined) return undefined;
    return exact
      ? { label: "Online only", kind: "folder", path, offline: false }
      : { label: "Make available offline", kind: "folder", path, offline: true };
  }
  if (pins.vault || folderHolding(pins, path) !== undefined) return undefined;
  return pins.notes.includes(path)
    ? { label: "Online only", kind: "note", path, offline: false }
    : { label: "Make available offline", kind: "note", path, offline: true };
}

/** The whole-vault entry, for the file settings menu. */
export function vaultAction(snapshot: OfflineSnapshot): OfflineAction {
  return snapshot.pins.vault
    ? { label: "Make the vault online only", kind: "vault", path: "", offline: false }
    : { label: "Make the whole vault available offline", kind: "vault", path: "", offline: true };
}

/**
 * Whether a note can be opened now: always while online, and only if it is on disk while the
 * server cannot be reached.
 */
export function openable(snapshot: OfflineSnapshot, path: string): boolean {
  return snapshot.online || snapshot.downloaded.includes(path);
}

/**
 * The palette's offline command for the open note in a server vault, worded as the palette
 * words it. `undefined` when a folder or the whole vault keeps the note offline: releasing it
 * alone is refused, so there is nothing for the command to do.
 */
export function noteCommand(snapshot: OfflineSnapshot, path: string): OfflineAction | undefined {
  const action = actionFor(snapshot, path, "note");
  if (action === undefined) return undefined;
  return {
    ...action,
    label: action.offline ? "Keep this note available offline" : "Stop keeping this note offline",
  };
}

/**
 * What the workspace says while a server vault's server cannot be reached, or `undefined`
 * while it can.
 *
 * why: the editor's connection line speaks only for the note open in it, and with none open
 * the only sign of a lost server was greyed notes in the tree. This speaks for the vault.
 */
export function offlineNotice(snapshot: OfflineSnapshot | undefined): string | undefined {
  if (snapshot === undefined || snapshot.online) return undefined;
  return snapshot.downloaded.length === 0
    ? "Offline. Your server can't be reached, and no notes from this vault are on this computer."
    : "Offline. Notes on this computer still open and save, and sync when your server is back.";
}

/** The workspace's line about recovered notes, or `undefined` when there are none. */
export function recoveredNotice(snapshot: OfflineSnapshot | undefined): string | undefined {
  const count = snapshot?.recovered.length ?? 0;
  if (count === 0) return undefined;
  return count === 1
    ? "1 note was kept from your offline edits and needs a choice."
    : `${count} notes were kept from your offline edits and need a choice.`;
}

/** The recovered note at `path`, if it is one. */
export function recoveredAt(snapshot: OfflineSnapshot | undefined, path: string): RecoveredNote | undefined {
  return snapshot?.recovered.find((note) => note.path === path);
}

/** The name "Make a new note" starts from: the original note's name. */
export function suggestedName(note: RecoveredNote): string {
  const name = note.original.split("/").pop() ?? note.original;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * The note path a typed name means: `Ideas/Plan` → `Ideas/Plan.md`. `undefined` for an empty
 * name. The server decides whether a note may be made there.
 */
export function notePathFrom(input: string): string | undefined {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return undefined;
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

/** How a note pane reaches the recovered notes of its vault in the desktop app. */
export interface Recovery {
  /** The recovered note at `path`, if it is one. */
  readonly find: (path: string) => RecoveredNote | undefined;
  /** Acts on the user's choice; resolves to a message when it was refused. */
  readonly place: (note: RecoveredNote, to?: string) => Promise<string | undefined>;
}
