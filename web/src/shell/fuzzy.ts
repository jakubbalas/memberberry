/**
 * Fuzzy matching for the quick switcher and command palette (`SPEC.md` §8.4).
 *
 * Subsequence matching with a positional score — the shape every editor's "go to file" uses,
 * because it is what people's fingers already expect: type `pr` and `Projects/Roadmap` should
 * beat `Paragraph`.
 *
 * **§21.2 budgets the quick switcher at 80 ms over 10 000 notes on a mid-range phone**, which
 * rules out anything clever. So this allocates nothing per candidate in the common case, bails
 * out of a candidate on the first character it cannot find, and never builds an intermediate
 * array of matches — `rank` keeps a bounded heap of the best `limit` instead of sorting
 * everything. A scorer that is 10× smarter and allocates per candidate would miss the budget
 * on the device the budget is written against.
 */

/** Where a query matched, so the UI can highlight it without matching a second time. */
export interface FuzzyMatch {
  readonly score: number;
  /** Indexes into the candidate, ascending. Empty for an empty query. */
  readonly positions: readonly number[];
}

/** Scoring weights, named rather than scattered as literals. */
const ADJACENT_BONUS = 8;
const WORD_START_BONUS = 10;
const CAMEL_START_BONUS = 6;
const LEADING_PENALTY = 2;
const MAX_LEADING_PENALTY = 12;
const UNMATCHED_PENALTY = 0.5;

/** Whether `character` begins a word — after a separator, or a capital in camelCase. */
function isWordStart(candidate: string, at: number): boolean {
  if (at === 0) return true;
  const previous = candidate[at - 1];
  return previous === "/" || previous === " " || previous === "-" || previous === "_";
}

function isCamelStart(candidate: string, at: number): boolean {
  if (at === 0) return false;
  const previous = candidate[at - 1];
  const current = candidate[at];
  if (previous === undefined || current === undefined) return false;
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

/**
 * Scores `query` against `candidate`, or `undefined` when it does not match at all.
 *
 * Case-insensitive. An empty query matches everything with a score of zero, which is what
 * makes the palette show its full list before anything is typed.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | undefined {
  if (query.length === 0) return { score: 0, positions: [] };
  if (query.length > candidate.length) return undefined;

  const lowerQuery = query.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();

  const positions: number[] = [];
  let at = 0;

  for (let index = 0; index < lowerQuery.length; index += 1) {
    const wanted = lowerQuery[index];
    if (wanted === undefined) return undefined;
    // why: `indexOf` from the last match rather than a nested scan. It is one call into the
    // engine's own string search instead of a character loop in JavaScript, which is most of
    // the difference between hitting the §21.2 budget and missing it.
    const found = lowerCandidate.indexOf(wanted, at);
    if (found === -1) return undefined;
    positions.push(found);
    at = found + 1;
  }

  // The forward pass is greedy, so it takes the *left-most* alignment: typing `road` against
  // "Product roadmap" matches the `ro` of "Product" and then jumps. A backward pass slides
  // each position as far right as it can go, which lands the match on "road" — better
  // highlighting, and a better score, because the run is then adjacent and at a word start.
  let ceiling = candidate.length;
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const wanted = lowerQuery[index];
    if (wanted === undefined) break;
    const found = lowerCandidate.lastIndexOf(wanted, ceiling - 1);
    // Never behind the previous character's position: the match must stay in order.
    const floor = index === 0 ? 0 : (positions[index - 1] ?? 0) + 1;
    positions[index] = found >= floor ? found : (positions[index] ?? 0);
    ceiling = positions[index] ?? 0;
  }

  let score = 0;
  let previousMatch = -1;
  for (const found of positions) {
    if (previousMatch !== -1 && found === previousMatch + 1) score += ADJACENT_BONUS;
    if (isWordStart(candidate, found)) score += WORD_START_BONUS;
    else if (isCamelStart(candidate, found)) score += CAMEL_START_BONUS;
    previousMatch = found;
  }

  // A match that starts late is usually a worse answer than one that starts early, but the
  // penalty is capped: otherwise a deep folder path can never win, however well it matches.
  const firstPosition = positions[0] ?? 0;
  score -= Math.min(firstPosition * LEADING_PENALTY, MAX_LEADING_PENALTY);
  // Prefer the shorter of two candidates that matched equally well.
  score -= (candidate.length - query.length) * UNMATCHED_PENALTY;

  return { score, positions };
}

/** One ranked result. */
export interface Ranked<T> {
  readonly item: T;
  readonly match: FuzzyMatch;
}

export interface RankOptions<T> {
  /** The text to match against. */
  readonly key: (item: T) => string;
  /** How many results to keep. Defaults to 50 — more than any list a person reads. */
  readonly limit?: number;
}

/**
 * The best `limit` matches, best first.
 *
 * Ties break on the candidate's own order, so a caller that pre-sorts by recency gets recent
 * notes first among equals — which is what §8.4's "recent notes" asks for, without this
 * module needing to know what recency is.
 */
export function fuzzyRank<T>(
  query: string,
  items: Iterable<T>,
  options: RankOptions<T>,
): readonly Ranked<T>[] {
  const limit = options.limit ?? 50;
  if (limit <= 0) return [];

  // Insertion into a bounded array rather than sorting everything: at 10 000 candidates a
  // full sort is the most expensive thing in the search, and all but the first page is
  // discarded anyway.
  const best: Ranked<T>[] = [];
  let worst = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const match = fuzzyMatch(query, options.key(item));
    if (match === undefined) continue;
    if (best.length === limit && match.score <= worst) continue;

    let at = best.length;
    while (at > 0 && (best[at - 1]?.match.score ?? 0) < match.score) at -= 1;
    best.splice(at, 0, { item, match });
    if (best.length > limit) best.pop();
    worst = best[best.length - 1]?.match.score ?? Number.NEGATIVE_INFINITY;
  }

  return best;
}

/**
 * Splits `text` into matched and unmatched runs, for highlighting.
 *
 * Returned as runs rather than HTML: a component renders them into elements, so nothing here
 * has to think about escaping note titles that contain markup.
 */
export interface HighlightRun {
  readonly text: string;
  readonly matched: boolean;
}

export function highlight(text: string, positions: readonly number[]): readonly HighlightRun[] {
  if (positions.length === 0) return text.length === 0 ? [] : [{ text, matched: false }];

  const runs: HighlightRun[] = [];
  let at = 0;
  for (let index = 0; index < positions.length; ) {
    const start = positions[index];
    if (start === undefined) break;
    if (start > at) runs.push({ text: text.slice(at, start), matched: false });

    // Consume the whole consecutive run, so `Roadmap` highlights as one span rather than
    // seven — which matters for how it reads, not just how many nodes it costs.
    let end = start;
    while (positions[index] === end) {
      end += 1;
      index += 1;
    }
    runs.push({ text: text.slice(start, end), matched: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), matched: false });
  return runs;
}
