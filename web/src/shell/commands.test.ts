// @vitest-environment jsdom

/**
 * The command registry (`SPEC.md` §8.4).
 *
 * The behaviours that matter are the ones about *not* firing: not while someone is typing,
 * not for a command that cannot run, and not twice when two commands share a binding.
 */

import { describe, expect, it } from "vitest";

import {
  BINDINGS_KEY,
  type Command,
  CommandRegistry,
  readBindingOverrides,
  writeBindingOverrides,
} from "./commands.js";

function command(overrides: Partial<Command> & Pick<Command, "id">): Command {
  return {
    title: overrides.id,
    group: "Test",
    run: () => undefined,
    ...overrides,
  };
}

function press(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">> = {},
  target: EventTarget | null = null,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, ...modifiers });
  if (target !== null) Object.defineProperty(event, "target", { value: target });
  return event;
}

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(BINDINGS_KEY, initial);
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    get stored(): string | undefined {
      return values.get(BINDINGS_KEY);
    },
  };
}

describe("running a command from its binding", () => {
  it("runs the one that matches and reports that it did", () => {
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [command({ id: "palette", binding: "Mod+Shift+p", run: () => (ran += 1) })],
      platform: "mac",
    });

    expect(registry.handle(press("P", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(ran).toBe(1);
  });

  it("reports that nothing matched, so the caller leaves the browser alone", () => {
    // The return value is what a caller uses to decide whether to `preventDefault`. Claiming
    // an unbound keystroke would break every browser shortcut the shell does not implement.
    const registry = new CommandRegistry({ commands: [command({ id: "a", binding: "Mod+k" })] });
    expect(registry.handle(press("j", { metaKey: true }))).toBe(false);
  });

  it("consumes the keystroke for a disabled command rather than passing it through", () => {
    // Passing it through fires the *browser's* binding instead — for `Mod+W`, that closes
    // the browser tab. Refusing to act and refusing to let go is the correct pair.
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [
        command({ id: "close", binding: "Mod+w", enabled: () => false, run: () => (ran += 1) }),
      ],
      platform: "mac",
    });

    expect(registry.handle(press("w", { metaKey: true }))).toBe(true);
    expect(ran).toBe(0);
  });

  it("re-asks whether a command is enabled on every keystroke", () => {
    // `enabled` is a function because the answer changes — "close tab" depends on whether one
    // is open. Caching it at construction makes the command permanently wrong.
    let open = false;
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [
        command({ id: "close", binding: "Mod+w", enabled: () => open, run: () => (ran += 1) }),
      ],
      platform: "mac",
    });

    registry.handle(press("w", { metaKey: true }));
    expect(ran).toBe(0);

    open = true;
    registry.handle(press("w", { metaKey: true }));
    expect(ran).toBe(1);
  });

  it("runs the first of two commands sharing a binding, and never both", () => {
    const order: string[] = [];
    const registry = new CommandRegistry({
      commands: [
        command({ id: "first", binding: "Mod+k", run: () => order.push("first") }),
        command({ id: "second", binding: "Mod+k", run: () => order.push("second") }),
      ],
      platform: "mac",
    });

    registry.handle(press("k", { metaKey: true }));
    expect(order).toEqual(["first"]);
  });
});

describe("keeping out of the editor's way", () => {
  it("ignores a bare key while a text surface has focus", () => {
    // Otherwise typing `p` in a note opens the command palette.
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [command({ id: "palette", binding: "p", run: () => (ran += 1) })],
    });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");

    expect(registry.handle(press("p", {}, editor))).toBe(false);
    expect(ran).toBe(0);
  });

  it("still fires a Mod chord while the editor has focus", () => {
    // The whole point of a workspace shortcut is that it works from inside the note.
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [command({ id: "switcher", binding: "Mod+k", run: () => (ran += 1) })],
      platform: "mac",
    });
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");

    expect(registry.handle(press("k", { metaKey: true }, editor))).toBe(true);
    expect(ran).toBe(1);
  });

  it("still fires a bare key when focus is not in a text surface", () => {
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [command({ id: "help", binding: "?", run: () => (ran += 1) })],
    });
    expect(registry.handle(press("?", {}, document.createElement("div")))).toBe(true);
    expect(ran).toBe(1);
  });
});

describe("remapping", () => {
  it("replaces a default binding", () => {
    let ran = 0;
    const registry = new CommandRegistry({
      commands: [command({ id: "palette", binding: "Mod+Shift+p", run: () => (ran += 1) })],
      overrides: { palette: "Mod+j" },
      platform: "mac",
    });

    expect(registry.handle(press("P", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(registry.handle(press("j", { metaKey: true }))).toBe(true);
    expect(ran).toBe(1);
  });

  it("unbinds on an empty override rather than falling back to the default", () => {
    // "I want no shortcut for this" is a thing users mean, and it is not the same as "I have
    // not customised this".
    const registry = new CommandRegistry({
      commands: [command({ id: "palette", binding: "Mod+Shift+p" })],
      overrides: { palette: "" },
      platform: "mac",
    });

    expect(registry.find("palette")?.binding).toBeUndefined();
    expect(registry.handle(press("P", { metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves a command unbound when its override is unparseable", () => {
    // Better than silently restoring the default: the user asked for something specific, and
    // quietly doing something else is how a shortcut fires when nobody expects it.
    const registry = new CommandRegistry({
      commands: [command({ id: "palette", binding: "Mod+Shift+p" })],
      overrides: { palette: "Nonsense+++" },
    });
    expect(registry.find("palette")?.binding).toBeUndefined();
  });

  it("reports two commands that share a binding", () => {
    // Not an error — shadowing a default is allowed — but a settings screen has to be able to
    // say so, because silently running the wrong command is the worst resolution.
    const registry = new CommandRegistry({
      commands: [
        command({ id: "first", binding: "Mod+k" }),
        command({ id: "second", binding: "Mod+k" }),
        command({ id: "third", binding: "Mod+j" }),
      ],
    });

    const conflicts = registry.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.map((entry) => entry.command.id)).toEqual(["first", "second"]);
  });

  it("treats two spellings of one binding as the same conflict", () => {
    const registry = new CommandRegistry({
      commands: [
        command({ id: "first", binding: "Mod+Shift+k" }),
        command({ id: "second", binding: "shift+cmd+K" }),
      ],
    });
    expect(registry.conflicts).toHaveLength(1);
  });
});

describe("stored overrides", () => {
  it("round-trip", () => {
    const store = storage();
    writeBindingOverrides(store, { palette: "Mod+j" });
    expect(readBindingOverrides(store)).toEqual({ palette: "Mod+j" });
  });

  it("survive a corrupt file by falling back to the defaults", () => {
    // Costs the user their remapped keys, not their session.
    expect(readBindingOverrides(storage("{ not json"))).toEqual({});
    expect(readBindingOverrides(storage("[]"))).toEqual({});
    expect(readBindingOverrides(storage("null"))).toEqual({});
  });

  it("drop entries that are not strings", () => {
    expect(readBindingOverrides(storage('{"a":"Mod+k","b":42}'))).toEqual({ a: "Mod+k" });
  });

  it("survive storage being unavailable entirely", () => {
    // Private browsing, or a blocked origin. Neither should take the shell down.
    expect(readBindingOverrides(undefined)).toEqual({});
    expect(() => writeBindingOverrides(undefined, { a: "Mod+k" })).not.toThrow();
  });
});
