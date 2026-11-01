import type { EmojiEntry } from "./notes.js";

const MAX_SUGGESTIONS = 8;

/** Returns the Unicode entries matching an inline colon query, ordered by fuzzy relevance. */
export function emojiSuggestions(catalog: readonly EmojiEntry[], query: string): readonly EmojiEntry[] {
  const normalized = query.toLowerCase();
  return catalog
    .map((entry, index) => ({ entry, index, score: emojiScore(entry, normalized) }))
    .filter(({ score }) => score !== undefined)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.index - right.index)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry);
}

function emojiScore(entry: EmojiEntry, query: string): number | undefined {
  return [entry.shortcode, ...entry.aliases].reduce<number | undefined>((best, name) => {
    const score = subsequenceScore(name, query);
    return score === undefined ? best : best === undefined ? score : Math.max(best, score);
  }, undefined);
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let queryIndex = 0;
  let score = 0;
  let previous = -2;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    score += previous + 1 === index ? 3 : 1;
    previous = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? score : undefined;
}
