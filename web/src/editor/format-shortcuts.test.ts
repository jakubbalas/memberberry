// @vitest-environment jsdom
import { expect, it } from "vitest";
import { FORMAT_SHORTCUTS, formatShortcut } from "./format-shortcuts.js";

it.each(["mac", "other"] as const)("resolves every formatting shortcut on %s with exactly the advertised modifiers", platform => {
  for (const shortcut of FORMAT_SHORTCUTS) {
    const { binding } = shortcut;
    const options = {
      key: binding.shift ? binding.key.toUpperCase() : binding.key,
      metaKey: platform === "mac", ctrlKey: platform !== "mac", shiftKey: binding.shift,
      cancelable: true,
    };
    expect(formatShortcut(new KeyboardEvent("keydown", options), platform)).toBe(shortcut);
    for (const wrong of [
      { altKey: true }, { metaKey: !options.metaKey, ctrlKey: !options.ctrlKey },
      { shiftKey: !options.shiftKey }, { isComposing: true }, { metaKey: true, ctrlKey: true },
    ]) expect(formatShortcut(new KeyboardEvent("keydown", { ...options, ...wrong }), platform)).toBeUndefined();
    const handled = new KeyboardEvent("keydown", options);
    handled.preventDefault();
    expect(formatShortcut(handled, platform)).toBeUndefined();
  }
});

it("leaves ordinary typing and workspace shortcuts alone", () => {
  for (const key of ["b", "i", "u", "e", "k", "x", "h", "Dead", "Process", "😀"]) {
    expect(formatShortcut(new KeyboardEvent("keydown", { key }), "mac")).toBeUndefined();
  }
  for (const key of ["p", "o", "w", "\\", "z", "y"]) {
    expect(formatShortcut(new KeyboardEvent("keydown", { key, metaKey: true }), "mac")).toBeUndefined();
  }
});
