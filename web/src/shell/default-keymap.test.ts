import { describe, expect, it } from "vitest";

import { parseBinding, serialiseBinding } from "./hotkeys.js";
import { OBSIDIAN_DEFAULT_BINDINGS, obsidianDefaultBinding } from "./default-keymap.js";

describe("the Obsidian-compatible default keymap", () => {
  it("ships the documented equivalents and no browser-reserved new-note binding", () => {
    expect(OBSIDIAN_DEFAULT_BINDINGS).toEqual({
      "palette.commands": "Mod+p",
      "palette.notes": "Mod+o",
      "workspace.closeTab": "Mod+w",
    });
    expect("note.create" in OBSIDIAN_DEFAULT_BINDINGS).toBe(false);
  });

  it("contains only canonical bindings the hotkey engine can round-trip", () => {
    for (const binding of Object.values(OBSIDIAN_DEFAULT_BINDINGS)) {
      const parsed = parseBinding(binding);
      expect(parsed).toBeDefined();
      if (parsed !== undefined) expect(serialiseBinding(parsed)).toBe(binding);
    }
  });

  it("looks up every audited command by its stable id", () => {
    for (const command of ["palette.commands", "palette.notes", "workspace.closeTab"] as const) {
      expect(obsidianDefaultBinding(command)).toBe(OBSIDIAN_DEFAULT_BINDINGS[command]);
    }
  });
});
