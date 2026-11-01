/** Editor-local defaults, separate from the workspace command registry (SPEC §8.4). */
import { bindingMatches, type Binding, type Platform } from "../shell/hotkeys.js";
import type { InlineMark } from "./selection-format.js";

/** A formatting action and its discoverable platform-neutral binding. */
export interface FormatShortcut {
  readonly action: InlineMark | "link";
  readonly label: string;
  readonly binding: Binding;
}

/** Defaults use the same names as the selected-text toolbar. */
export const FORMAT_SHORTCUTS: readonly FormatShortcut[] = ([
  { action: "strong", label: "Bold", key: "b", shift: false },
  { action: "em", label: "Italic", key: "i", shift: false },
  { action: "mb_underline", label: "Underline", key: "u", shift: false },
  { action: "code", label: "Inline code", key: "e", shift: false },
  { action: "strikethrough", label: "Strikethrough", key: "x", shift: true },
  { action: "highlight", label: "Highlight", key: "h", shift: true },
  { action: "link", label: "Link", key: "k", shift: false },
] as const).map(({ action, label, key, shift }) => ({
  action, label,
  binding: { key, shift, mod: true, alt: false, secondary: false },
}));

/** Ordinary typing, composition and unrelated modifier chords fall through untouched. */
export function formatShortcut(event: KeyboardEvent, platform: Platform): FormatShortcut | undefined {
  if (event.defaultPrevented || event.isComposing || (!event.metaKey && !event.ctrlKey) || event.altKey) return undefined;
  return FORMAT_SHORTCUTS.find(({ binding }) => bindingMatches(binding, event, platform));
}
