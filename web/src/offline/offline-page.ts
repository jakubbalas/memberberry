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
export function offlinePage(): string {
  return OFFLINE_PAGE;
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
    <p>Notes you have opened before are still available. Reopen one from this device, or try
      again once you are back online.</p>
  </body>
</html>
`;
