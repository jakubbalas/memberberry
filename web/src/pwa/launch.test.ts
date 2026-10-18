import { describe, expect, it } from "vitest";
import { launchDestination, rememberLaunch } from "./launch.js";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("installed launch", () => {
  it("resumes the last local workspace route", () => {
    const store = storage();
    rememberLaunch("/v/personal/Projects/Roadmap.md", store);
    expect(launchDestination(store)).toBe("/v/personal/Projects/Roadmap.md");
  });
  it("starts at the vault list before any workspace has been opened", () => {
    expect(launchDestination(storage())).toBe("/");
  });
  it.each(["https://other.example/v/a/b", "//other.example/v/a/b", "/login", "/v/a/../../login", "/v/a/b?redirect=x", "/v/a/%5c%5cother.example"])("refuses an unsafe remembered route: %s", (path) => {
    const store = storage();
    rememberLaunch(path, store);
    expect(launchDestination(store)).toBe("/");
  });
  it("survives storage being unavailable", () => {
    const store = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(() => rememberLaunch("/v/personal/Note.md", store)).not.toThrow();
    expect(launchDestination(store)).toBe("/");
  });
});
