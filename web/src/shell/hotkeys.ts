/**
 * Hotkey bindings (`SPEC.md` §8.4).
 *
 * "Fully remappable hotkeys, defaults matching Obsidian where an equivalent exists." Three
 * things make that work, and each is a reason this is a module rather than a `switch` in a
 * component:
 *
 * - **`Mod` means Cmd on a Mac and Ctrl elsewhere.** Writing `Cmd+K` on Windows or `Ctrl+K`
 *   on a Mac is wrong in a way users notice immediately, so bindings are stored with `Mod`
 *   and resolved per platform at match time.
 * - **A binding is data.** It has to round-trip through a settings file, be displayed in a
 *   palette, and be compared against a `KeyboardEvent` — three jobs one string cannot do
 *   unless parsing and formatting are exact inverses, which is what the property test asserts.
 * - **The editor gets first refusal.** A shortcut that fires while someone is typing in a
 *   note is a bug, not a feature; `Cmd+B` is bold before it is anything else.
 */

/** A parsed binding. Modifiers are normalised, so two spellings compare equal. */
export interface Binding {
  readonly key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  /** The *other* one: Ctrl on macOS, Meta elsewhere. Rare, but expressible. */
  readonly secondary: boolean;
}

export type Platform = "mac" | "other";

/** The signals a platform can be read from, best first. Injectable for tests. */
export interface PlatformSignals {
  /** `navigator.userAgentData.platform` — the standards-track answer, Chromium-only. */
  readonly uaDataPlatform?: string | undefined;
  /** `navigator.platform` — deprecated, universally supported, reports the real host. */
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * Which modifier `Mod` means here.
 *
 * why: three signals in this order, rather than the user-agent string alone. The question
 * being asked is "which physical key is on this keyboard", and a UA string is the least
 * reliable answer to it — it is routinely overridden, and something that does so is not
 * necessarily lying about anything the user can feel. This was not theoretical: Playwright's
 * `Desktop Chrome` descriptor sets a Windows UA, so a suite running on a Mac had the shell
 * expecting Ctrl while the host keyboard sent Cmd, and every shortcut silently did nothing.
 */
export function detectPlatform(signals?: PlatformSignals): Platform {
  const navigatorSignals = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  const resolved: PlatformSignals = signals ?? {
    uaDataPlatform: navigatorSignals?.userAgentData?.platform,
    platform: navigatorSignals?.platform,
    userAgent: navigatorSignals?.userAgent,
  };

  for (const signal of [resolved.uaDataPlatform, resolved.platform, resolved.userAgent]) {
    if (signal === undefined || signal === "") continue;
    return /mac|iphone|ipad|ipod/i.test(signal) ? "mac" : "other";
  }
  return "other";
}

const MODIFIERS = new Map<string, keyof Omit<Binding, "key">>([
  ["mod", "mod"],
  ["cmd", "mod"],
  ["command", "mod"],
  ["ctrl", "mod"],
  ["control", "mod"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["option", "alt"],
  ["opt", "alt"],
  ["meta", "secondary"],
]);

/**
 * Parses `Mod+Shift+P` and friends. `undefined` for anything unusable.
 *
 * Deliberately lenient about what it *accepts* — `cmd`, `command` and `ctrl` all mean `Mod` —
 * and strict about what it produces, so a settings file written by hand still works and two
 * spellings of the same binding collide the way a user would expect them to.
 */
export function parseBinding(text: string): Binding | undefined {
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;

  const key = parts[parts.length - 1];
  if (key === undefined || MODIFIERS.has(key.toLowerCase())) return undefined;
  if (!isUsableKey(key)) return undefined;

  const binding = { key: normaliseKey(key), mod: false, shift: false, alt: false, secondary: false };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS.get(part.toLowerCase());
    if (modifier === undefined) return undefined;
    binding[modifier] = true;
  }
  return binding;
}

/**
 * The named keys a binding may use, as `KeyboardEvent.key` spells them.
 *
 * why: without this, any multi-character word parses as a binding for a key of that name — so
 * a typo in a settings file becomes a shortcut that silently never fires, and nothing can tell
 * the user why. A closed list means an unrecognised name is reported as unbound instead.
 */
const NAMED_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Insert",
  "Home", "End", "PageUp", "PageDown", "Space",
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
]);

/** Whether this is a key a binding may name. */
function isUsableKey(key: string): boolean {
  return key.length === 1 || NAMED_KEYS.has(key);
}

/**
 * A single printable key is lowercased; a named key keeps its `KeyboardEvent.key` spelling.
 *
 * why: `event.key` for a letter is `"p"` or `"P"` depending on Shift, so comparing letters
 * case-sensitively makes `Mod+Shift+P` unmatchable. Named keys like `ArrowLeft` are compared
 * exactly, because their spelling is the whole identity.
 */
function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Formats a binding for display, using the platform's own symbols. */
export function formatBinding(binding: Binding, platform: Platform = detectPlatform()): string {
  const parts: string[] = [];
  if (platform === "mac") {
    if (binding.secondary) parts.push("⌃");
    if (binding.alt) parts.push("⌥");
    if (binding.shift) parts.push("⇧");
    if (binding.mod) parts.push("⌘");
    return `${parts.join("")}${displayKey(binding.key)}`;
  }
  if (binding.mod) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.secondary) parts.push("Meta");
  parts.push(displayKey(binding.key));
  return parts.join("+");
}

function displayKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The canonical text form, which `parseBinding` reads back identically. */
export function serialiseBinding(binding: Binding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push("Mod");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.secondary) parts.push("Meta");
  parts.push(binding.key);
  return parts.join("+");
}

/** Whether a keyboard event is this binding, on this platform. */
export function bindingMatches(
  binding: Binding,
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  platform: Platform = detectPlatform(),
): boolean {
  const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
  const secondary = platform === "mac" ? event.ctrlKey : event.metaKey;
  return (
    normaliseKey(event.key) === binding.key &&
    mod === binding.mod &&
    secondary === binding.secondary &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt
  );
}

/**
 * Whether a keystroke belongs to whatever the user is typing into.
 *
 * why: this is the rule that keeps the shell out of the editor's way. A bare key, or one with
 * only Shift, is text — the shell must never claim it while a text surface has focus, or
 * typing `p` in a note opens the command palette. Bindings *with* `Mod` still reach the shell,
 * because that is where they are useful and the editor's own `Mod` bindings are handled by the
 * editor before this ever sees them.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // why: both signals, not just `isContentEditable`. That property is inherited and is the
  // right answer in a browser, but jsdom does not implement it — and a keydown inside
  // ProseMirror often targets a descendant of the editable element rather than the element
  // itself, which `closest` handles either way.
  if (target.isContentEditable) return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}
