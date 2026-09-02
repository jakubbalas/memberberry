// @vitest-environment jsdom

/**
 * What the server tells the client about the page (`SPEC.md` §3.3).
 *
 * Small surface, but every case here is one where guessing would be worse than refusing: a
 * half-filled bootstrap must not become a sync session under an unauthenticated username,
 * and a page served over TLS must not open a cleartext socket.
 */

import { describe, expect, it } from "vitest";

import { readNoteBootstrap, remoteSyncFor } from "./bootstrap.js";

function element(attributes: Readonly<Record<string, string>>): HTMLElement {
  const div = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) div.setAttribute(name, value);
  return div;
}

describe("reading the bootstrap", () => {
  it("returns what the server filled in", () => {
    const target = element({
      "data-vault": "personal",
      "data-note": "Projects/Roadmap.md",
      "data-user": "alice",
    });
    expect(readNoteBootstrap(target)).toEqual({
      vault: "personal",
      note: "Projects/Roadmap.md",
      user: "alice",
    });
  });

  it("is absent when the attributes are still empty, which is the dev-server case", () => {
    // Vite serves `index.html` unmodified, so the marker arrives with empty values. The
    // editor then runs against a purely local replica rather than trying to sync.
    const target = element({ "data-vault": "", "data-note": "", "data-user": "" });
    expect(readNoteBootstrap(target)).toBeUndefined();
  });

  it("is absent when the element carries nothing at all", () => {
    expect(readNoteBootstrap(element({}))).toBeUndefined();
  });

  it.each([
    ["vault", { "data-note": "One.md", "data-user": "alice" }],
    ["note", { "data-vault": "personal", "data-user": "alice" }],
    ["user", { "data-vault": "personal", "data-note": "One.md" }],
  ])("treats a bootstrap missing its %s as absent rather than guessing", (_which, attributes) => {
    // Defaulting a missing `user` would mean syncing under a username nobody authenticated,
    // and defaulting a missing `note` would mean writing edits into the wrong file.
    expect(readNoteBootstrap(element(attributes))).toBeUndefined();
  });

  it("keeps a note name that contains characters an attribute has to escape", () => {
    // The server escapes on the way out; by the time `dataset` reads it, the browser has
    // already unescaped it, and the value must be the original filename byte for byte.
    const note = 'a" autofocus onfocus="alert(1).md';
    const target = element({ "data-vault": "v", "data-note": note, "data-user": "alice" });
    expect(readNoteBootstrap(target)?.note).toBe(note);
  });
});

describe("the sync endpoint", () => {
  const bootstrap = { vault: "personal", note: "One.md", user: "alice" } as const;

  it("is on the origin that served the page", () => {
    const location = { protocol: "http:", host: "notes.example:9010" } as Location;
    expect(remoteSyncFor(bootstrap, location).endpoint).toBe(
      "ws://notes.example:9010/api/v1/sync",
    );
  });

  it("uses wss over https, never a silent downgrade", () => {
    // A page served over TLS opening a cleartext socket is a downgrade the user cannot see,
    // and there is no deployment where it is what they wanted.
    const location = { protocol: "https:", host: "notes.example" } as Location;
    expect(remoteSyncFor(bootstrap, location).endpoint).toBe("wss://notes.example/api/v1/sync");
  });

  it("carries the bootstrap through unchanged", () => {
    const location = { protocol: "http:", host: "localhost:9010" } as Location;
    expect(remoteSyncFor(bootstrap, location)).toMatchObject(bootstrap);
  });
});
