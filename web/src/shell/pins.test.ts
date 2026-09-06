/**
 * The pinned-note list the palette reads (`SPEC.md` §7.2).
 */

import { describe, expect, it, vi } from "vitest";

import { stubReplica } from "../offline/testing.js";
import { PinnedNotes } from "./pins.svelte.js";

/** A replica whose pins live in a set, like the real store. */
function replicaWithPins(...initial: string[]) {
  const pins = new Set(initial);
  return {
    pins,
    handle: async () =>
      stubReplica({
        pinned: async () => [...pins],
        setPinned: async (_vault: string, note: string, pinned: boolean) => {
          if (pinned) pins.add(note);
          else pins.delete(note);
        },
      }),
  };
}

describe("pinned notes", () => {
  it("loads what this device already keeps", async () => {
    const pins = new PinnedNotes({ vault: "personal", replica: replicaWithPins("One.md").handle });
    await pins.refresh();
    expect(pins.notes).toEqual(["One.md"]);
    expect(pins.has("One.md")).toBe(true);
    expect(pins.has("Two.md")).toBe(false);
  });

  it("pins and unpins the same note", async () => {
    const store = replicaWithPins();
    const pins = new PinnedNotes({ vault: "personal", replica: store.handle });

    expect(await pins.toggle("One.md")).toBe(true);
    expect(store.pins.has("One.md")).toBe(true);
    expect(pins.has("One.md")).toBe(true);

    expect(await pins.toggle("One.md")).toBe(false);
    expect(store.pins.has("One.md")).toBe(false);
    expect(pins.has("One.md")).toBe(false);
  });

  it("pins nothing on a device with nowhere to keep a replica", async () => {
    // A UI that claimed otherwise would promise a note offline that will not be there.
    const pins = new PinnedNotes({ vault: "personal", replica: async () => undefined });
    expect(await pins.toggle("One.md")).toBe(false);
    expect(pins.notes).toEqual([]);
  });

  it("loads once however many callers ask", async () => {
    // The palette calls `ensure` every time it opens, and a component may call it from an
    // effect that re-runs.
    let loads = 0;
    const pins = new PinnedNotes({
      vault: "personal",
      replica: async () => {
        loads += 1;
        return stubReplica({ pinned: async () => ["One.md"] });
      },
    });

    pins.ensure();
    pins.ensure();
    await vi.waitFor(() => expect(pins.notes).toEqual(["One.md"]));

    expect(loads).toBe(1);
  });
});
