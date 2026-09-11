// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  applyTheme,
  readThemeChoice,
  resolveTheme,
  themeKey,
  writeThemeChoice,
  type ThemeStorage,
} from "./theme.js";

function memory(): ThemeStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("theme preferences", () => {
  it("keeps device overrides separate for each vault", () => {
    const storage = memory();
    writeThemeChoice(storage, "work", "memberberry-dark");
    writeThemeChoice(storage, "home", "memberberry-light");
    expect(readThemeChoice(storage, "work")).toBe("memberberry-dark");
    expect(readThemeChoice(storage, "home")).toBe("memberberry-light");
  });

  it("removes an override when the vault default is selected", () => {
    const storage = memory();
    writeThemeChoice(storage, "work", "system");
    writeThemeChoice(storage, "work", "vault");
    expect(storage.values.has(themeKey("work"))).toBe(false);
    expect(readThemeChoice(storage, "work")).toBe("vault");
  });

  it("fails back to the vault without breaking on unavailable storage", () => {
    const blocked: ThemeStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readThemeChoice(blocked, "work")).toBe("vault");
    expect(() => writeThemeChoice(blocked, "work", "memberberry-dark")).not.toThrow();
  });

  it("resolves and applies explicit palettes while system removes the override", () => {
    const root = document.createElement("div");
    let changes = 0;
    root.addEventListener("memberberry-theme-change", () => { changes += 1; });
    expect(resolveTheme("vault", "memberberry-dark")).toBe("memberberry-dark");
    applyTheme(root, "memberberry-dark");
    expect(root.dataset["theme"]).toBe("memberberry-dark");
    applyTheme(root, "system");
    expect(root.dataset["theme"]).toBeUndefined();
    expect(changes).toBe(2);
  });
});
