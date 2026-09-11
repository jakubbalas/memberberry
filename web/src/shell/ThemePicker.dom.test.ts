// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";

import ThemePicker from "./ThemePicker.svelte";
import type { ThemeStorage } from "./theme.js";

describe("the theme picker", () => {
  it.each([
    ["memberberry-light", "Paper"],
    ["memberberry-dark", "Charcoal"],
    ["memberberry-pastel", "Pastel"],
    ["system", "System"],
  ] as const)("shows and applies the %s vault default", async (theme, label) => {
    const target = document.createElement("div");
    const root = document.createElement("div");
    const app = mount(ThemePicker, {
      target,
      props: {
        vault: "default-preview",
        vaultTheme: theme,
        root,
        storage: { getItem: () => null, setItem: () => undefined },
      },
    });
    await tick();
    expect(target.querySelector("select")?.selectedOptions.item(0)?.textContent)
      .toBe(`Vault default (${label})`);
    expect(root.dataset["theme"]).toBe(theme === "system" ? undefined : theme);
    await unmount(app);
  });

  it("applies a device choice and can return to the vault default", async () => {
    const target = document.createElement("div");
    const root = document.createElement("div");
    const values = new Map<string, string>();
    const storage: ThemeStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    const app = mount(ThemePicker, {
      target,
      props: { vault: "personal", vaultTheme: "memberberry-light", storage, root },
    });
    await tick();
    const select = target.querySelector("select");
    expect(select?.getAttribute("aria-label")).toBeNull();
    expect(select?.closest("label")?.textContent).toContain("Theme");
    expect(root.dataset["theme"]).toBe("memberberry-light");

    if (select === null) throw new Error("theme selector did not render");
    select.value = "memberberry-dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(values.get("memberberry.theme.personal")).toBe("memberberry-dark");
    expect(root.dataset["theme"]).toBe("memberberry-dark");

    select.value = "memberberry-pastel";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(root.dataset["theme"]).toBe("memberberry-pastel");
    expect(values.get("memberberry.theme.personal")).toBe("memberberry-pastel");

    select.value = "vault";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(values.has("memberberry.theme.personal")).toBe(false);
    expect(root.dataset["theme"]).toBe("memberberry-light");
    unmount(app);
  });
});
