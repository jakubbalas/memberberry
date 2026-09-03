/**
 * The command registry (`SPEC.md` §8.4).
 *
 * "Command palette over every registered command" and "fully remappable hotkeys" are the same
 * feature seen from two sides, so there is one list. A command that exists only as a keyboard
 * handler cannot appear in the palette, and one that exists only in the palette cannot be
 * bound — both are how an application ends up with actions nobody can find.
 *
 * Note the deliberate absence: **no command reaches into the editor's own keymap.** Bold,
 * italic and the rest belong to Tiptap, and a shell binding that shadowed one would break
 * typing (see `Cmd+B` in §8.2). This registry owns the *workspace*.
 */

import {
  type Binding,
  type Platform,
  bindingMatches,
  detectPlatform,
  isTypingTarget,
  parseBinding,
  serialiseBinding,
} from "./hotkeys.js";

export interface Command {
  /** Stable across renames, because it is what a user's binding is stored against. */
  readonly id: string;
  /** What the palette shows. */
  readonly title: string;
  /** Groups related commands in the palette, e.g. "Workspace", "Navigation". */
  readonly group: string;
  /** The default binding, as text. Absent for commands reachable only from the palette. */
  readonly binding?: string;
  /** Whether the command can run right now. Absent means always. */
  readonly enabled?: () => boolean;
  run(): void;
}

/** A command with its current binding resolved. */
export interface ResolvedCommand {
  readonly command: Command;
  readonly binding: Binding | undefined;
  readonly enabled: boolean;
}

export interface CommandRegistryOptions {
  readonly commands: readonly Command[];
  /** User overrides by command id, as text. An empty string unbinds. */
  readonly overrides?: Readonly<Record<string, string>>;
  readonly platform?: Platform;
}

/**
 * A resolved, queryable set of commands.
 *
 * Built rather than mutated: the command list for a session is known when the shell mounts,
 * and a registry that can change under a palette is a registry whose list can go stale while
 * someone is reading it.
 */
export class CommandRegistry {
  readonly #commands: readonly ResolvedCommand[];
  readonly #platform: Platform;

  constructor(options: CommandRegistryOptions) {
    this.#platform = options.platform ?? detectPlatform();
    const overrides = options.overrides ?? {};
    this.#commands = options.commands.map((command) => {
      const override = overrides[command.id];
      // An override of `""` unbinds deliberately, and must not fall back to the default —
      // "I want no shortcut for this" is a thing users mean.
      const text = override === undefined ? command.binding : override;
      return {
        command,
        binding: text === undefined || text === "" ? undefined : parseBinding(text),
        get enabled(): boolean {
          return command.enabled?.() ?? true;
        },
      };
    });
  }

  /** Every command, in registration order. */
  get all(): readonly ResolvedCommand[] {
    return this.#commands;
  }

  /** The command with this id, or `undefined`. */
  find(id: string): ResolvedCommand | undefined {
    return this.#commands.find((entry) => entry.command.id === id);
  }

  /**
   * Bindings that two commands share.
   *
   * A conflict is not an error — a user is allowed to shadow a default, and the first match
   * wins — but a settings screen has to be able to say so, and silently running the wrong
   * command is the worst possible resolution.
   */
  get conflicts(): readonly (readonly ResolvedCommand[])[] {
    const bySignature = new Map<string, ResolvedCommand[]>();
    for (const entry of this.#commands) {
      if (entry.binding === undefined) continue;
      const signature = serialiseBinding(entry.binding);
      const existing = bySignature.get(signature) ?? [];
      existing.push(entry);
      bySignature.set(signature, existing);
    }
    return [...bySignature.values()].filter((group) => group.length > 1);
  }

  /**
   * Runs whichever command this keystroke is bound to.
   *
   * Returns whether one ran, so a caller knows whether to `preventDefault`. **A disabled
   * command still consumes its keystroke**: passing it through would fire the browser's own
   * binding instead, which for `Mod+W` closes the tab.
   */
  handle(event: KeyboardEvent): boolean {
    // The editor gets first refusal on anything that is not a Mod chord: a bare key belongs
    // to whatever the user is typing into.
    if (!event.metaKey && !event.ctrlKey && isTypingTarget(event.target)) return false;

    for (const entry of this.#commands) {
      if (entry.binding === undefined) continue;
      if (!bindingMatches(entry.binding, event, this.#platform)) continue;
      if (entry.enabled) entry.command.run();
      return true;
    }
    return false;
  }
}

/** Where a user's remapped bindings live. Per device, like every other UI preference. */
export const BINDINGS_KEY = "memberberry.hotkeys";

/** Reads the stored overrides, tolerating anything that is not what was written. */
export function readBindingOverrides(
  store: Pick<Storage, "getItem"> | undefined,
): Readonly<Record<string, string>> {
  try {
    const raw = store?.getItem(BINDINGS_KEY);
    if (raw === null || raw === undefined) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const overrides: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "string") overrides[id] = value;
    }
    return overrides;
  } catch {
    // A corrupt file costs the user their remapped keys, not their session. Defaults apply.
    return {};
  }
}

export function writeBindingOverrides(
  store: Pick<Storage, "setItem"> | undefined,
  overrides: Readonly<Record<string, string>>,
): void {
  try {
    store?.setItem(BINDINGS_KEY, JSON.stringify(overrides));
  } catch {
    // A full or blocked storage must not stop the shortcut from working this session.
  }
}
