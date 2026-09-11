/**
 * What the server tells the client about the page it just served.
 *
 * `mb-server` fills these attributes in on the mount element, escaped, before sending
 * `index.html` (`SPEC.md` §3.3). It is deliberately small: **the note's body is not here.**
 * Content reaches the browser over the CRDT and nowhere else, because a second path to the
 * same bytes is a second thing that can disagree about them.
 *
 * Attributes rather than a JSON blob because three strings do not need a schema, and because
 * attribute escaping on the server side is already the tested path. When the bootstrap needs
 * structure — a vault list, a role — this becomes JSON in a `type="application/json"` script
 * and gets validated properly. Not before.
 */

import { shippedTheme, type ShippedTheme } from "./theme.js";

/** A note the server has authorized this user to open. */
export interface NoteBootstrap {
  readonly vault: string;
  readonly note: string;
  readonly user: string;
  readonly mediaMaxDimension?: number;
  readonly theme?: ShippedTheme;
}

/** An authenticated vault home, with no note selected by the route. */
export type HomeBootstrap = Pick<NoteBootstrap, "vault" | "user" | "theme">;

/** Reads only explicitly marked home pages; incomplete bootstraps remain local-only. */
export function readHomeBootstrap(element: HTMLElement): HomeBootstrap | undefined {
  const { vault, user, home } = element.dataset;
  if (home !== "true" || !isFilled(vault) || !isFilled(user)) return undefined;
  const theme = shippedTheme(element.dataset["vaultTheme"]);
  return { vault, user, ...(theme === undefined ? {} : { theme }) };
}

/**
 * Reads the bootstrap off the mount element.
 *
 * `undefined` when any part is missing, which is the local-only case: `npm run dev` serves
 * `index.html` straight from Vite with the attributes still empty, and the editor then runs
 * against a purely local replica. That path has to keep working — it is the inner loop.
 *
 * A partially filled bootstrap is treated as absent rather than guessed at. Defaulting a
 * missing `user` would mean syncing under a username nobody authenticated.
 */
export function readNoteBootstrap(element: HTMLElement): NoteBootstrap | undefined {
  const { vault, note, user } = element.dataset;
  if (!isFilled(vault) || !isFilled(note) || !isFilled(user)) return undefined;
  const parsedMaximum = Number(element.dataset["mediaMaxDimension"]);
  const mediaMaxDimension = Number.isInteger(parsedMaximum) && parsedMaximum >= 256 && parsedMaximum <= 8192
    ? parsedMaximum
    : undefined;
  const theme = shippedTheme(element.dataset["vaultTheme"]);
  return {
    vault,
    note,
    user,
    ...(mediaMaxDimension === undefined ? {} : { mediaMaxDimension }),
    ...(theme === undefined ? {} : { theme }),
  };
}

function isFilled(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Where the sync socket for this page lives. */
export interface RemoteSync extends NoteBootstrap {
  readonly endpoint: string;
}

/**
 * The sync endpoint for a bootstrap, on the origin that served the page.
 *
 * `wss:` follows `https:` rather than being configurable: a page served over TLS opening a
 * cleartext socket is a downgrade the user cannot see, and there is no deployment where it
 * is what they wanted.
 */
export function remoteSyncFor(bootstrap: NoteBootstrap, location: Location): RemoteSync {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return { ...bootstrap, endpoint: `${protocol}//${location.host}/api/v1/sync` };
}

/** Where the last authenticated display name is kept, for an offline start (§7.4). */
export const USER_KEY = "memberberry.user";

/** The `Storage` surface the offline bootstrap needs. Narrow, so a test can supply it. */
export type UserStore = Pick<Storage, "getItem" | "setItem">;

/**
 * The bootstrap for this page, from the server if there is one and from the URL if not.
 *
 * Offline the service worker answers a note URL with the unbootstrapped shell (§7.4), so the
 * three attributes are empty and the page has to work out for itself which note it is. Two
 * of the three are in the URL. The third is the display name, which is remembered here on
 * every successful load.
 *
 * **The remembered name is a label, never an authorization.** It names the caret in the
 * editor and nothing else; every request this page makes is authenticated by the session
 * cookie and filtered by the server (§6.4). A tampered value renames a cursor.
 */
export function resolveNoteBootstrap(
  element: HTMLElement,
  location: Pick<Location, "pathname">,
  storage: UserStore | undefined,
): NoteBootstrap | undefined {
  const served = readNoteBootstrap(element);
  if (served !== undefined) {
    remember(storage, served.user);
    return served;
  }
  const home = readHomeBootstrap(element);
  if (home !== undefined) {
    remember(storage, home.user);
    return undefined;
  }
  const route = parseNoteRoute(location.pathname);
  if (route === undefined) return undefined;
  const user = read(storage);
  // No remembered user means this browser has never completed a load here, so there is no
  // session either. Better an empty local replica than a workspace claiming to be someone.
  if (user === undefined) return undefined;
  return { ...route, user };
}

/**
 * Splits `/v/<vault>/<note>` into its two parts, or `undefined` for any other path.
 *
 * The note is decoded whole rather than segment by segment, which is what the rest of the
 * client does with a note path (`%2F` routes exactly as `/` does) — and a malformed escape
 * is treated as "not a note route" rather than throwing out of the page's first statement.
 */
export function parseNoteRoute(pathname: string): { readonly vault: string; readonly note: string } | undefined {
  const match = /^\/v\/([^/]+)\/(.+)$/.exec(pathname);
  const [, vault, note] = match ?? [];
  if (vault === undefined || note === undefined) return undefined;
  try {
    return { vault: decodeURIComponent(vault), note: decodeURIComponent(note) };
  } catch {
    return undefined;
  }
}

function remember(storage: UserStore | undefined, user: string): void {
  // A storage that refuses to write — Safari's private mode throws rather than returning —
  // costs the offline display name and nothing else, so it is not worth failing a page load.
  try {
    storage?.setItem(USER_KEY, user);
  } catch {
    /* the next load asks the server again */
  }
}

function read(storage: UserStore | undefined): string | undefined {
  try {
    const stored = storage?.getItem(USER_KEY);
    return isFilled(stored ?? undefined) ? stored ?? undefined : undefined;
  } catch {
    return undefined;
  }
}
