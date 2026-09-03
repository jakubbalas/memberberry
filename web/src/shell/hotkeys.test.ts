// @vitest-environment jsdom

/**
 * Hotkey bindings (`SPEC.md` §8.4).
 *
 * The two properties everything else rests on: a binding survives a round trip through text
 * (it has to live in a settings file), and `Mod` resolves to the right modifier on each
 * platform (writing `Ctrl+K` on a Mac is wrong in a way users notice immediately).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type Binding,
  bindingMatches,
  detectPlatform,
  formatBinding,
  isTypingTarget,
  parseBinding,
  serialiseBinding,
} from "./hotkeys.js";

function binding(text: string): Binding {
  const parsed = parseBinding(text);
  if (parsed === undefined) throw new Error(`\`${text}\` should parse`);
  return parsed;
}

function press(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {},
) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  };
}

describe("parsing", () => {
  it("reads a plain key", () => {
    expect(binding("k")).toEqual({ key: "k", mod: false, shift: false, alt: false, secondary: false });
  });

  it("reads modifiers in any order and any spelling", () => {
    // A settings file may be hand-edited, so `cmd`, `command` and `ctrl` all mean `Mod`.
    // Being lenient about input and strict about output is what makes two spellings of one
    // binding collide the way a user expects.
    const canonical = binding("Mod+Shift+p");
    for (const spelling of ["Shift+Mod+P", "cmd+shift+p", "Ctrl+Shift+P", " command + shift + p "]) {
      expect(binding(spelling)).toEqual(canonical);
    }
  });

  it("keeps a named key's exact spelling", () => {
    // `ArrowLeft` compared case-insensitively would collide with nothing useful and break
    // the moment two named keys differ only in case.
    expect(binding("Mod+ArrowLeft").key).toBe("ArrowLeft");
  });

  it("lowercases a single letter, because Shift changes what the browser reports", () => {
    // `event.key` for a letter is `"p"` or `"P"` depending on Shift, so a case-sensitive
    // comparison makes `Mod+Shift+P` unmatchable.
    expect(binding("Mod+Shift+P").key).toBe("p");
  });

  it.each([
    ["", "empty"],
    ["Mod+", "a trailing plus"],
    ["Mod", "modifiers only"],
    ["Nope+k", "an unknown modifier"],
    ["Nonsense", "a word that is not a key name"],
    ["Mod+Nonsense", "a typo where a key should be"],
    ["Mod+arrowleft", "a named key in the wrong case"],
  ])("refuses %s (%s)", (text) => {
    // The typo cases matter most: without a closed list of key names, any word parses as a
    // binding for a key of that name, and the user gets a shortcut that silently never fires
    // with nothing able to tell them why.
    expect(parseBinding(text)).toBeUndefined();
  });

  it("accepts the named keys a binding actually needs", () => {
    for (const key of ["ArrowLeft", "Enter", "Escape", "Tab", "Home", "PageDown", "F12", "Space"]) {
      expect(parseBinding(`Mod+${key}`)?.key, key).toBe(key);
    }
  });

  it("round-trips through text", () => {
    // The binding lives in a settings file, so parse and serialise must be exact inverses or
    // a saved hotkey is a hotkey that stops working after a restart.
    fc.assert(
      fc.property(
        fc.record({
          key: fc.constantFrom("k", "p", "v", "ArrowLeft", "Enter", "F2", "\\"),
          mod: fc.boolean(),
          shift: fc.boolean(),
          alt: fc.boolean(),
          secondary: fc.boolean(),
        }),
        (original: Binding) => {
          expect(parseBinding(serialiseBinding(original))).toEqual(original);
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("matching a keystroke", () => {
  it("maps Mod to Cmd on a Mac and Ctrl elsewhere", () => {
    const shortcut = binding("Mod+k");
    expect(bindingMatches(shortcut, press("k", { metaKey: true }), "mac")).toBe(true);
    expect(bindingMatches(shortcut, press("k", { ctrlKey: true }), "mac")).toBe(false);

    expect(bindingMatches(shortcut, press("k", { ctrlKey: true }), "other")).toBe(true);
    expect(bindingMatches(shortcut, press("k", { metaKey: true }), "other")).toBe(false);
  });

  it("requires every modifier to agree, not merely the ones the binding names", () => {
    // Otherwise `Mod+K` also fires for `Mod+Shift+K`, stealing a binding someone else has.
    const shortcut = binding("Mod+k");
    expect(bindingMatches(shortcut, press("k", { metaKey: true, shiftKey: true }), "mac")).toBe(false);
    expect(bindingMatches(shortcut, press("k", { metaKey: true, altKey: true }), "mac")).toBe(false);
  });

  it("matches a shifted letter, whichever case the browser reports", () => {
    const shortcut = binding("Mod+Shift+p");
    expect(bindingMatches(shortcut, press("P", { metaKey: true, shiftKey: true }), "mac")).toBe(true);
  });

  it("expresses the platform's other modifier when a binding really wants it", () => {
    const shortcut = binding("Meta+k");
    expect(bindingMatches(shortcut, press("k", { ctrlKey: true }), "mac")).toBe(true);
    expect(bindingMatches(shortcut, press("k", { metaKey: true }), "other")).toBe(true);
  });
});

describe("formatting", () => {
  it("uses the platform's symbols", () => {
    expect(formatBinding(binding("Mod+Shift+p"), "mac")).toBe("⇧⌘P");
    expect(formatBinding(binding("Mod+Shift+p"), "other")).toBe("Ctrl+Shift+P");
  });

  it("keeps a named key readable", () => {
    expect(formatBinding(binding("Mod+ArrowLeft"), "mac")).toBe("⌘ArrowLeft");
  });
});

describe("detecting the platform", () => {
  it.each([
    ["macOS", "mac"],
    ["Windows", "other"],
    ["Linux", "other"],
  ])("prefers userAgentData, reading %s as %s", (uaDataPlatform, expected) => {
    expect(detectPlatform({ uaDataPlatform, platform: "Win32", userAgent: "" })).toBe(expected);
  });

  it("falls back to navigator.platform where userAgentData is absent", () => {
    // Safari and Firefox have no `userAgentData`, and `navigator.platform` is what they have.
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32" })).toBe("other");
  });

  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "mac"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "mac"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "other"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "other"],
  ])("falls back to the user agent, reading %s as %s", (userAgent, expected) => {
    expect(detectPlatform({ userAgent })).toBe(expected);
  });

  it("assumes not-a-Mac when it knows nothing", () => {
    // Ctrl is the more common modifier, and a wrong guess is recoverable: §8.4 makes every
    // binding remappable.
    expect(detectPlatform({})).toBe("other");
    expect(detectPlatform({ uaDataPlatform: "", platform: "", userAgent: "" })).toBe("other");
  });

  it("ignores a user-agent string when a better signal disagrees", () => {
    // The case that broke the E2E suite: Playwright's `Desktop Chrome` descriptor sets a
    // Windows UA, so a Mac host had the shell expecting Ctrl while the keyboard sent Cmd.
    expect(
      detectPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Windows NT 10.0)" }),
    ).toBe("mac");
  });
});

describe("keeping out of the editor's way", () => {
  it("recognises the surfaces a person types into", () => {
    // The rule that stops a shortcut firing mid-sentence. A shell that claims bare keys while
    // a note has focus is a shell that broke typing.
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(isTypingTarget(editable)).toBe(true);
    // A keydown inside ProseMirror often targets a descendant rather than the editable
    // element itself, so the check has to look upward.
    const inside = document.createElement("span");
    editable.append(inside);
    expect(isTypingTarget(inside)).toBe(true);
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("select"))).toBe(true);
  });

  it("does not claim ordinary elements", () => {
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
