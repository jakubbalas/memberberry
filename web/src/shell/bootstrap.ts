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

/** A note the server has authorized this user to open. */
export interface NoteBootstrap {
  readonly vault: string;
  readonly note: string;
  readonly user: string;
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
  return { vault, note, user };
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
