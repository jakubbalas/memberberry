import { describe, expect, it } from "vitest";

import config from "../vite.config.js";

// why: on 9011 a path Vite does not proxy falls through to the app shell, which renders the
// scratch note — a server page then "opens" as an unrelated editor with no error anywhere.
// The desktop app's device-approval link (SPEC §6.8.1) shipped that way.
const SERVER_PAGES = ["/devices/authorize", "/login", "/logout", "/setup", "/vaults/new"];

describe("Vite dev server proxy", () => {
  const proxy = config.server?.proxy ?? {};
  const prefixes = Object.keys(proxy);

  it.each(SERVER_PAGES)("forwards the server-rendered page %s to the backend", (page) => {
    expect(prefixes.some((prefix) => page.startsWith(prefix))).toBe(true);
  });

  // why: the server's same-origin check on every form POST compares Origin with Host. Vite's
  // string shorthand sets `changeOrigin: true`, which rewrites Host to 9010 while the browser
  // still sends Origin 9011, so every form on 9011 — device approval, new vault, first-run
  // setup — was refused as cross-origin.
  it.each(prefixes)("keeps the browser's Host header when forwarding %s", (prefix) => {
    const entry = proxy[prefix];
    expect(typeof entry === "object" && entry.changeOrigin === false).toBe(true);
  });
});
