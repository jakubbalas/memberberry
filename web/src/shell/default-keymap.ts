/**
 * Obsidian-compatible defaults for commands with a direct Memberberry equivalent.
 *
 * Keep this list narrow: an invented similarity is more disruptive than leaving a command
 * unbound. Memberberry-only commands keep their own defaults at the registration site.
 */
export const OBSIDIAN_DEFAULT_BINDINGS = {
  "palette.commands": "Mod+p",
  "palette.notes": "Mod+o",
  "workspace.closeTab": "Mod+w",
} as const;

export type ObsidianCompatibleCommand = keyof typeof OBSIDIAN_DEFAULT_BINDINGS;

/** Returns the shipped Obsidian-compatible binding for a command. */
export function obsidianDefaultBinding(command: ObsidianCompatibleCommand): string {
  return OBSIDIAN_DEFAULT_BINDINGS[command];
}
