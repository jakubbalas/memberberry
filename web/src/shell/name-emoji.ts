import type { EmojiEntry } from "../notes.js";

const glyphCache = new WeakMap<readonly EmojiEntry[], ReadonlyMap<string, string>>();

/** Resolves base-pack shortcodes in labels; paths and unrecognized names stay literal. */
export function emojiName(text: string, catalog: readonly EmojiEntry[]): string {
  if (!text.includes(":")) return text;
  let glyphs = glyphCache.get(catalog);
  if (glyphs === undefined) {
    // why: a tree render resolves many folder labels against the same immutable catalog.
    glyphs = new Map(catalog.flatMap(entry => [entry.shortcode, ...entry.aliases].map(name => [name.toLowerCase(), entry.glyph] as const)));
    glyphCache.set(catalog, glyphs);
  }
  const resolved = glyphs;
  return text.replace(/:([a-z0-9_+-]+):/gi, (literal: string, name: string) => resolved.get(name.toLowerCase()) ?? literal);
}

/** Finds a colon query at a collapsed caret, including after a nested-path separator. */
export function nameEmojiQuery(value: string, start: number | null, end: number | null): { from: number; to: number; text: string } | undefined {
  if (start === null || end !== start) return undefined;
  const match = /(?:^|[\s/]):([a-z0-9_+-]*)$/i.exec(value.slice(0, start));
  return match === null ? undefined : { from: start - (match[1]?.length ?? 0) - 1, to: start, text: match[1] ?? "" };
}
