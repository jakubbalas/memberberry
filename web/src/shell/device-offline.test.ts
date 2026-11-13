import { describe, expect, it } from "vitest";

import { actionFor, covers, notePathFrom, noteCommand, offlineNotice, openable, recoveredAt, recoveredNotice, suggestedName, readOfflineState, vaultAction, type OfflineSnapshot } from "./device-offline.js";

function snapshot(overrides: Partial<OfflineSnapshot> = {}): OfflineSnapshot {
  return {
    online: true,
    pins: { vault: false, folders: [], notes: [] },
    downloaded: [],
    held: [],
    recovered: [],
    ...overrides,
  };
}

describe("reading the offline state", () => {
  it("accepts a server vault's answer", () => {
    const state = readOfflineState({
      server: true,
      online: false,
      pins: { vault: false, folders: ["Projects"], notes: ["A.md"] },
      downloaded: ["A.md"],
      held: [{ path: "B.md", reason: "changed here" }],
    });
    expect(state?.pins.folders).toEqual(["Projects"]);
  });

  it("treats a vault only on this device as having no offline state", () => {
    expect(readOfflineState({ server: false })).toBeUndefined();
  });

  it("rejects a malformed answer rather than guessing", () => {
    expect(readOfflineState({ server: true, online: true, pins: { vault: "yes", folders: [], notes: [] }, downloaded: [], held: [] })).toBeUndefined();
  });
});

describe("offline menu entries", () => {
  it("offers to keep a note offline", () => {
    expect(actionFor(snapshot(), "A.md", "note")?.label).toBe("Make available offline");
  });

  it("offers online only for a note kept offline by itself", () => {
    const state = snapshot({ pins: { vault: false, folders: [], notes: ["A.md"] } });
    expect(actionFor(state, "A.md", "note")).toEqual({ label: "Online only", kind: "note", path: "A.md", offline: false });
  });

  it("offers nothing for a note a folder keeps offline", () => {
    const state = snapshot({ pins: { vault: false, folders: ["Projects"], notes: [] } });
    expect(actionFor(state, "Projects/Plan.md", "note")).toBeUndefined();
  });

  it("offers online only for a folder kept offline", () => {
    const state = snapshot({ pins: { vault: false, folders: ["Projects"], notes: [] } });
    expect(actionFor(state, "Projects", "folder")?.label).toBe("Online only");
  });

  it("offers nothing for a folder inside one kept offline", () => {
    const state = snapshot({ pins: { vault: false, folders: ["Projects"], notes: [] } });
    expect(actionFor(state, "Projects/Deep", "folder")).toBeUndefined();
  });

  it("offers nothing per note while the whole vault is offline", () => {
    const state = snapshot({ pins: { vault: true, folders: [], notes: [] } });
    expect(actionFor(state, "A.md", "note")).toBeUndefined();
  });

  it("words the vault entry by its state", () => {
    expect(vaultAction(snapshot({ pins: { vault: true, folders: [], notes: [] } })).label).toBe("Make the vault online only");
  });
});

describe("what a pin covers", () => {
  it("a folder pin covers what is under it and not a sibling sharing its prefix", () => {
    const pins = { vault: false, folders: ["Projects"], notes: [] };
    expect([covers(pins, "Projects/Plan.md"), covers(pins, "Projects2/Plan.md")]).toEqual([true, false]);
  });
});

describe("opening while offline", () => {
  it("opens only what is on this device", () => {
    const state = snapshot({ online: false, downloaded: ["A.md"] });
    expect([openable(state, "A.md"), openable(state, "B.md")]).toEqual([true, false]);
  });

  it("opens anything while online", () => {
    expect(openable(snapshot(), "B.md")).toBe(true);
  });
});

describe("the palette's offline command", () => {
  it("offers to keep the open note offline", () => {
    expect(noteCommand(snapshot(), "A.md")).toEqual({
      label: "Keep this note available offline",
      kind: "note",
      path: "A.md",
      offline: true,
    });
  });

  it("offers to stop keeping a note kept offline by itself", () => {
    const pinned = snapshot({ pins: { vault: false, folders: [], notes: ["A.md"] } });
    expect(noteCommand(pinned, "A.md")).toMatchObject({ label: "Stop keeping this note offline", offline: false });
  });

  it("offers nothing for a note a folder or the vault keeps offline", () => {
    expect(noteCommand(snapshot({ pins: { vault: false, folders: ["F"], notes: [] } }), "F/A.md")).toBeUndefined();
    expect(noteCommand(snapshot({ pins: { vault: true, folders: [], notes: [] } }), "A.md")).toBeUndefined();
  });
});

describe("the workspace's offline notice", () => {
  it("says nothing while the server can be reached, or outside a server vault", () => {
    expect(offlineNotice(snapshot())).toBeUndefined();
    expect(offlineNotice(undefined)).toBeUndefined();
  });

  it("says what still works while the server cannot be reached", () => {
    expect(offlineNotice(snapshot({ online: false, downloaded: ["A.md"] }))).toMatch(/^Offline\. Notes on this computer still open/);
  });

  it("says plainly when nothing of the vault is on this computer", () => {
    expect(offlineNotice(snapshot({ online: false }))).toMatch(/no notes from this vault are on this computer/);
  });
});

describe("recovered notes (SPEC §7.6.7)", () => {
  const note = { path: "Recovered/Plan (offline edits).md", original: "Projects/Plan.md", createAgainRefused: false };

  it("reads the list, and an older app's answer without one as none", () => {
    const base = { server: true, online: true, pins: { vault: false, folders: [], notes: [] }, downloaded: [], held: [] };
    expect(readOfflineState(base)?.recovered).toEqual([]);
    expect(
      readOfflineState({ ...base, recovered: [{ path: note.path, original: note.original, create_again_refused: true }] })
        ?.recovered,
    ).toEqual([{ ...note, createAgainRefused: true }]);
    expect(readOfflineState({ ...base, recovered: [{ path: 1 }] })).toBeUndefined();
  });

  it("counts them for the workspace, and says nothing when there are none", () => {
    expect(recoveredNotice(snapshot())).toBeUndefined();
    expect(recoveredNotice(snapshot({ recovered: [note] }))).toMatch(/^1 note was kept/);
    expect(recoveredNotice(snapshot({ recovered: [note, { ...note, path: "Recovered/B (offline edits).md" }] }))).toMatch(/^2 notes were kept/);
  });

  it("finds the recovered note open in a pane", () => {
    expect(recoveredAt(snapshot({ recovered: [note] }), note.path)).toEqual(note);
    expect(recoveredAt(snapshot({ recovered: [note] }), "Projects/Plan.md")).toBeUndefined();
  });

  it("starts a new note's name from the original's", () => {
    expect(suggestedName(note)).toBe("Plan");
  });

  it("turns a typed name into a note path", () => {
    expect(notePathFrom(" Ideas/Plan ")).toBe("Ideas/Plan.md");
    expect(notePathFrom("/Plan.md/")).toBe("Plan.md");
    expect(notePathFrom("   ")).toBeUndefined();
  });
});
