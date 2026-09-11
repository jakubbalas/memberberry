// @vitest-environment jsdom

/**
 * What the server tells the client about the page (`SPEC.md` §3.3).
 *
 * Small surface, but every case here is one where guessing would be worse than refusing: a
 * half-filled bootstrap must not become a sync session under an unauthenticated username,
 * and a page served over TLS must not open a cleartext socket.
 */

import { describe, expect, it } from "vitest";

import {
  USER_KEY,
  parseNoteRoute,
  readNoteBootstrap,
  readHomeBootstrap,
  remoteSyncFor,
  resolveNoteBootstrap,
} from "./bootstrap.js";

function element(attributes: Readonly<Record<string, string>>): HTMLElement {
  const div = document.createElement("div");
  for (const [name, value] of Object.entries(attributes)) div.setAttribute(name, value);
  return div;
}

describe("reading the bootstrap", () => {
  it("remembers the authenticated home user for a subsequent offline note route", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(resolveNoteBootstrap(element({ "data-vault": "personal", "data-user": "alice", "data-home": "true" }), { pathname: "/v/personal" }, storage)).toBeUndefined();
    expect(resolveNoteBootstrap(element({}), { pathname: "/v/personal/One.md" }, storage)).toEqual({ vault: "personal", note: "One.md", user: "alice" });
  });
  it("accepts a home bootstrap only with an explicit home marker and authenticated fields", () => {
    const attributes = { "data-vault": "personal", "data-user": "alice", "data-home": "true" };
    expect(readHomeBootstrap(element(attributes))).toEqual({ vault: "personal", user: "alice" });
    expect(readHomeBootstrap(element({ ...attributes, "data-home": "false" }))).toBeUndefined();
    expect(readHomeBootstrap(element({ ...attributes, "data-user": "" }))).toBeUndefined();
    expect(readHomeBootstrap(element({ ...attributes, "data-vault": "" }))).toBeUndefined();
  });
  it("accepts the bounded media dimension supplied by the vault", () => {
    const target = element({
      "data-vault": "personal",
      "data-note": "One.md",
      "data-user": "alice",
      "data-media-max-dimension": "1440",
    });
    expect(readNoteBootstrap(target)?.mediaMaxDimension).toBe(1440);
  });

  it("accepts only a shipped vault theme", () => {
    const attributes = {
      "data-vault": "personal",
      "data-note": "One.md",
      "data-user": "alice",
    };
    expect(
      readNoteBootstrap(element({ ...attributes, "data-vault-theme": "memberberry-dark" }))
        ?.theme,
    ).toBe("memberberry-dark");
    expect(
      readNoteBootstrap(element({ ...attributes, "data-vault-theme": "invented" }))?.theme,
    ).toBeUndefined();
  });

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

describe("resolving a bootstrap with no server behind it", () => {
  function store(initial?: string): Pick<Storage, "getItem" | "setItem"> {
    const state = new Map<string, string>(initial === undefined ? [] : [[USER_KEY, initial]]);
    return {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => {
        state.set(key, value);
      },
    };
  }

  it("prefers what the server said, and remembers the user for next time", () => {
    const storage = store();
    const target = element({
      "data-vault": "personal",
      "data-note": "Projects/Roadmap.md",
      "data-user": "alice",
    });
    const resolved = resolveNoteBootstrap(target, { pathname: "/v/personal/Projects/Roadmap.md" }, storage);
    expect(resolved).toEqual({ vault: "personal", note: "Projects/Roadmap.md", user: "alice" });
    expect(storage.getItem(USER_KEY)).toBe("alice");
  });

  it("reads the vault and note out of the URL when the shell arrived from the cache", () => {
    // Offline the service worker answers a note URL with the unbootstrapped shell (§7.4), so
    // the attributes are empty and this is the only thing that knows which note it is.
    const target = element({ "data-vault": "", "data-note": "", "data-user": "" });
    expect(resolveNoteBootstrap(target, { pathname: "/v/personal/Projects/Roadmap.md" }, store("alice")))
      .toEqual({ vault: "personal", note: "Projects/Roadmap.md", user: "alice" });
  });

  it("refuses when no user has ever loaded this application here", () => {
    // No remembered name means no completed load, and so no session either. An empty local
    // replica is better than a workspace claiming to be someone.
    const target = element({ "data-vault": "", "data-note": "", "data-user": "" });
    expect(resolveNoteBootstrap(target, { pathname: "/v/personal/Note.md" }, store())).toBeUndefined();
  });

  it("refuses a path that is not a note", () => {
    const target = element({ "data-vault": "", "data-note": "", "data-user": "" });
    for (const pathname of ["/", "/login", "/v/personal", "/v/personal/"]) {
      expect(resolveNoteBootstrap(target, { pathname }, store("alice"))).toBeUndefined();
    }
  });

  it("survives a storage that throws, which is what a private window does", () => {
    const hostile: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("storage is disabled");
      },
      setItem: () => {
        throw new Error("storage is disabled");
      },
    };
    const served = element({
      "data-vault": "personal",
      "data-note": "Note.md",
      "data-user": "alice",
    });
    expect(resolveNoteBootstrap(served, { pathname: "/v/personal/Note.md" }, hostile)).toEqual({
      vault: "personal",
      note: "Note.md",
      user: "alice",
    });
    const shell = element({ "data-vault": "", "data-note": "", "data-user": "" });
    expect(resolveNoteBootstrap(shell, { pathname: "/v/personal/Note.md" }, hostile)).toBeUndefined();
  });

  it("works with no storage at all", () => {
    const target = element({
      "data-vault": "personal",
      "data-note": "Note.md",
      "data-user": "alice",
    });
    expect(resolveNoteBootstrap(target, { pathname: "/v/personal/Note.md" }, undefined)?.user).toBe("alice");
  });
});

describe("parsing a note route", () => {
  it("splits the vault from the note", () => {
    expect(parseNoteRoute("/v/personal/Projects/Roadmap.md")).toEqual({
      vault: "personal",
      note: "Projects/Roadmap.md",
    });
  });

  it("decodes the note whole, the way every other client of a note path does", () => {
    // `%2F` routes exactly as `/` does (§9.1), so a segment-by-segment decode would disagree
    // with the server about which note this is.
    expect(parseNoteRoute("/v/personal/Notes%2FA%20note.md")).toEqual({
      vault: "personal",
      note: "Notes/A note.md",
    });
  });

  it("treats a malformed escape as not a note route", () => {
    expect(parseNoteRoute("/v/personal/%E0%A4%A")).toBeUndefined();
  });

  it("refuses anything that is not a note", () => {
    for (const pathname of ["/", "/login", "/assets/index.js", "/v/", "/v/personal", "/v/personal/"]) {
      expect(parseNoteRoute(pathname)).toBeUndefined();
    }
  });
});
