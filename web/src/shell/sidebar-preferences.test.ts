import { describe, expect, it } from "vitest";
import { clampSidebarWidths, readSidebarPreferences, sidebarMaximum, writeSidebarPreferences, type SidebarPreferenceScope } from "./sidebar-preferences.js";

function memory(): Pick<Storage, "getItem" | "setItem"> {
  const entries = new Map<string, string>();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } };
}
const initial = { showFilenames: false, left: 248, right: 248 };

describe("device-local sidebar preferences", () => {
  it("defaults to headings and normal widths", () => {
    expect(readSidebarPreferences({ user: "alice", vault: "personal", storage: memory() })).toEqual(initial);
  });
  it("isolates accounts and vaults and preserves punctuation in keys", () => {
    const storage = memory();
    const scope = { user: "a:b", vault: "c", storage };
    const saved = { showFilenames: true, left: 360, right: 420 };
    writeSidebarPreferences(scope, saved);
    expect(readSidebarPreferences(scope)).toEqual(saved);
    expect(readSidebarPreferences({ ...scope, user: "a", vault: "b:c" })).toEqual(initial);
    expect(readSidebarPreferences({ ...scope, vault: "other" })).toEqual(initial);
  });
  it.each(["{", "null", "[]", '"true"', '{"showFilenames":"true","left":-20,"right":"400"}', '{"left":1e99,"right":1}'])("handles invalid preference %s", (raw) => {
    expect(readSidebarPreferences({ user: "alice", vault: "personal", storage: { getItem: () => raw, setItem: () => undefined } })).toEqual(initial);
  });
  it("survives unavailable storage", () => {
    const scope: SidebarPreferenceScope = { user: "alice", vault: "personal", storage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } } };
    expect(readSidebarPreferences(scope)).toEqual(initial);
    expect(() => writeSidebarPreferences(scope, initial)).not.toThrow();
  });
});

describe("panel bounds", () => {
  it("preserves a main area when both large panels are restored", () => {
    const widths = clampSidebarWidths({ left: 560, right: 560 }, 1024, { left: false, right: false });
    expect(widths.left).toBeGreaterThanOrEqual(248);
    expect(widths.right).toBeGreaterThanOrEqual(248);
    expect(widths.left + widths.right).toBeLessThanOrEqual(1024 - 320);
  });
  it("does not consume space for collapsed panels", () => {
    expect(clampSidebarWidths({ left: 560, right: 560 }, 1024, { left: false, right: true })).toEqual({ left: 560, right: 560 });
    expect(sidebarMaximum(1024, 0)).toBe(560);
    expect(sidebarMaximum(1024, 400)).toBe(304);
  });
  it("clamps invalid and huge requested widths", () => {
    expect(clampSidebarWidths({ left: NaN, right: Infinity }, 1280, { left: false, right: false })).toEqual({ left: 248, right: 248 });
    expect(clampSidebarWidths({ left: -5, right: 10000 }, 1280, { left: false, right: false })).toEqual({ left: 248, right: 560 });
  });
});
