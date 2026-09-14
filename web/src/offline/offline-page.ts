/**
 * The page a navigation gets when it needs a server and there is none (`SPEC.md` §7.4).
 *
 * Served for `/` and `/login` offline — routes that are server-rendered and have no offline
 * form. A note URL gets the application shell instead; see `routing.ts`.
 *
 * It carries no styling beyond layout. Every colour in this project is a design token
 * (`AGENTS.md` §4.4) and the token stylesheet is a hashed asset whose name this module
 * cannot know, so the honest choice is to declare no colours at all and let the browser's
 * own scheme decide. An offline page is the wrong place to be the one file with a hex code
 * in it.
 */

/** The offline page's document, as HTML. */
export interface OfflineNoteLink {
  /** Vault containing the resident note. */
  readonly vault: string;
  /** Vault-relative path of the resident note. */
  readonly note: string;
  /** Stored title, or `null` when only the path is available. */
  readonly title: string | null;
}

/**
 * Builds the offline page, optionally with links to resident note bodies.
 *
 * The links are rendered into static HTML rather than by a script: the fallback deliberately
 * has no executable content, and the service worker already has the local replica available.
 */
export function offlinePage(notes: readonly OfflineNoteLink[] = []): string {
  const links = notes.length === 0
    ? '<p>No opened notes are available on this device yet.</p>'
    : `<h2>Notes available on this device</h2>\n    <ul>${notes.map(noteLink).join("\n")}</ul>`;
  return OFFLINE_PAGE.replace("    <!-- available-notes -->", `    ${links}`);
}

/**
 * The headers it is served with.
 *
 * A policy of its own because this response never touches the server, so it inherits none
 * of the server's. `default-src 'none'` with an inline style allowance is exactly what this
 * document needs: no script, no image, no font, nothing to fetch.
 */
export function offlinePageHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
  };
}

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Offline — Memberberry</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        font-family: system-ui, sans-serif;
        line-height: 1.5;
        margin: 0 auto;
        max-width: 34rem;
        padding: 3rem 1.5rem;
      }
      h1 { font-size: 1.25rem; }
    </style>
  </head>
  <body>
    <h1>You are offline</h1>
    <p>This page is built by the server, so it needs a connection.</p>
    <p>Notes you have opened before are still available. Choose one below, or try again once
      you are back online.</p>
    <!-- available-notes -->
  </body>
</html>
`;

function noteLink(note: OfflineNoteLink): string {
  const label = note.title === null || note.title === "" ? note.note : note.title;
  const href = `/v/${encodeURIComponent(note.vault)}/${encodeURIComponent(note.note)}`;
  return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
