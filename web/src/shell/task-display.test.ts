import { describe, expect, it } from "vitest";
import { readTaskDisplay, writeTaskDisplay } from "./task-display.js";

const memory = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};

describe("device-local task display", () => {
  it("defaults to headings without a path", () => {
    expect(readTaskDisplay({ user: "alice", vault: "personal", storage: memory() })).toEqual({ showFilenames: false, showPaths: false });
  });
  it("remembers both settings independently and isolates user and vault", () => {
    const storage = memory();
    const scope = { user: "alice", vault: "personal", storage };
    writeTaskDisplay(scope, { showFilenames: true, showPaths: false });
    expect(readTaskDisplay(scope)).toEqual({ showFilenames: true, showPaths: false });
    writeTaskDisplay(scope, { showFilenames: false, showPaths: true });
    expect(readTaskDisplay(scope)).toEqual({ showFilenames: false, showPaths: true });
    expect(readTaskDisplay({ ...scope, user: "bob" })).toEqual({ showFilenames: false, showPaths: false });
    expect(readTaskDisplay({ ...scope, vault: "work" })).toEqual({ showFilenames: false, showPaths: false });
  });
  it.each(["bad json", "[]", "null", '{"showFilenames":"true","showPaths":1}'])("rejects malformed settings: %s", (raw) => {
    expect(readTaskDisplay({ user: "alice", vault: "personal", storage: { getItem: () => raw } })).toEqual({ showFilenames: false, showPaths: false });
  });
  it("keeps storage failures non-fatal", () => {
    const scope = { user: "alice", vault: "personal", storage: {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("full"); },
    } };
    expect(readTaskDisplay(scope)).toEqual({ showFilenames: false, showPaths: false });
    expect(() => writeTaskDisplay(scope, { showFilenames: true, showPaths: true })).not.toThrow();
  });
});
