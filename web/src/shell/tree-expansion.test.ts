import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readTreeExpansion, writeTreeExpansion } from "./tree-expansion.js";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => { values.set(key, value); },
  };
}

describe("tree expansion persistence", () => {
  it("round-trips expansion sets including Unicode and empty sets", () => {
    fc.assert(fc.property(fc.array(fc.string()), (paths) => {
      const scope = { vault: "personal", user: "alice", storage: storage() };
      writeTreeExpansion(scope, new Set(paths));
      expect(readTreeExpansion(scope)).toEqual(new Set(paths));
    }), { seed: 220926 });
  });

  it("isolates accounts and vaults", () => {
    const scope = { vault: "personal", user: "alice", storage: storage() };
    writeTreeExpansion(scope, new Set(["Projects"]));
    expect(readTreeExpansion({ ...scope, user: "bob" })).toEqual(new Set());
    expect(readTreeExpansion({ ...scope, vault: "shared" })).toEqual(new Set());
  });

  it.each(["broken json", "null", "{}", '["Projects", 7]'])("ignores malformed preferences: %s", (value) => {
    expect(readTreeExpansion({ vault: "personal", user: "alice", storage: {
      getItem: () => value, setItem: () => undefined,
    } })).toEqual(new Set());
  });

  it("keeps navigation available when storage is blocked or full", () => {
    const scope = { vault: "personal", user: "alice", storage: {
      getItem: (): never => { throw new Error("blocked"); },
      setItem: (): never => { throw new Error("full"); },
    } };
    expect(readTreeExpansion(scope)).toEqual(new Set());
    expect(() => writeTreeExpansion(scope, new Set(["Projects"]))).not.toThrow();
  });

  it("does not require persistence for standalone trees", () => {
    expect(readTreeExpansion(undefined)).toEqual(new Set());
    expect(() => writeTreeExpansion(undefined, new Set())).not.toThrow();
  });
});
