/**
 * The browser's view of a note.
 *
 * Every function here delegates to `mb-wasm`. That is deliberate and load-bearing: SPEC §5.2
 * argues that one Rust crate compiled both natively and to `wasm32` is what guarantees the
 * client and the server can never disagree about what a note means. A "quick" Markdown
 * helper written in TypeScript would be the divergence this design exists to prevent, so
 * there are none — this module is a boundary, not a library.
 */

import init, {
  conflictCount as wasmConflictCount,
  dailyPath as wasmDailyPath,
  periodicPath as wasmPeriodicPath,
  extract as wasmExtract,
  expandTemplate as wasmExpandTemplate,
  mergeWithConflicts as wasmMergeWithConflicts,
  markdownFromUpdate as wasmMarkdownFromUpdate,
  mergeSearchSegments as wasmMergeSearchSegments,
  noteTitle as wasmNoteTitle,
  querySearchSegments as wasmQuerySearchSegments,
  normalize as wasmNormalize,
  resolveConflict as wasmResolveConflict,
  schemaJson as wasmSchemaJson,
  toHtml as wasmToHtml,
  updateFromMarkdown as wasmUpdateFromMarkdown,
  validateSearchSegment as wasmValidateSearchSegment,
} from "./wasm/mb.js";

/** Where links point. Mirrors `mb_core::html::Urls`. */
export interface Urls {
  /** Prefix for a wikilink target, e.g. `/v/personal/`. */
  readonly note: string;
  /** Prefix for a relative media destination. */
  readonly media: string;
}

export interface LinkRef {
  readonly target: string;
  readonly anchor: string | null;
  readonly alias: string | null;
  readonly embed: boolean;
}

export type TaskStatus = "todo" | "done" | "cancelled";

export interface TaskRef {
  readonly status: TaskStatus;
  readonly text: string;
  readonly due: string | null;
  readonly anchor: string | null;
}

export interface HeadingRef {
  readonly level: number;
  readonly text: string;
}

/** What the index is built from (SPEC §9.1). Mirrors `mb_wasm::Facts`. */
export interface Facts {
  readonly title: string | null;
  readonly links: readonly LinkRef[];
  readonly tags: readonly string[];
  readonly emoji: readonly string[];
  readonly anchors: readonly string[];
  readonly media: readonly string[];
  readonly tasks: readonly TaskRef[];
  readonly headings: readonly HeadingRef[];
  readonly wordCount: number;
}

export interface ExpandedTemplate {
  readonly text: string;
  readonly cursor: number | null;
}

/** Formats a daily-note path through the shared Rust contract. */
export async function dailyPath(folder: string, format: string, date: string): Promise<string> {
  await load();
  return wasmDailyPath(folder, format, date);
}

export type CalendarPeriod = "daily" | "weekly" | "monthly";

/** Formats a daily, weekly, or monthly note path through the shared Rust contract. */
export async function periodicPath(
  period: CalendarPeriod,
  folder: string,
  format: string,
  date: string,
): Promise<string> {
  await load();
  return wasmPeriodicPath(period, folder, format, date);
}

/** A compact-index search result, safe to render as text. */
export interface CompactSearchHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly tags: readonly string[];
  readonly icon: string | null;
}

/** Results from the offline compact index (§14.2). */
export interface CompactSearchResults {
  readonly hits: readonly CompactSearchHit[];
  readonly phraseDegraded: boolean;
}

let ready: Promise<void> | undefined;

/**
 * Loads the WebAssembly module, once.
 *
 * Every entry point below awaits this, so callers never have to remember to. The promise is
 * cached rather than a boolean: two callers racing on first use must await the same load,
 * not start two.
 *
 * `source` is for hosts that already hold the bytes and cannot fetch — a Node test, a
 * worker, a browser extension. Left out, the module fetches itself as usual.
 */
export async function load(source?: BufferSource | WebAssembly.Module): Promise<void> {
  ready ??= (source === undefined ? init() : init({ module_or_path: source })).then(
    () => undefined,
  );
  return ready;
}

/** Rewrites Markdown into its canonical form (SPEC §4.5). */
export async function normalize(markdown: string): Promise<string> {
  await load();
  return wasmNormalize(markdown);
}

/** Renders Markdown to an HTML fragment, escaped by `mb_core::html`. */
export async function toHtml(markdown: string, urls: Urls): Promise<string> {
  await load();
  return wasmToHtml(markdown, urls.note, urls.media);
}

/** The note's title, or `null` when it has nothing titleable. */
export async function title(markdown: string): Promise<string | null> {
  await load();
  return wasmNoteTitle(markdown) ?? null;
}

/** Links, tags, tasks, anchors, media and headings. */
export async function extract(markdown: string): Promise<Facts> {
  await load();
  // The shape comes from `mb_wasm::Facts` via `serde`, so it is ours on both sides and does
  // not need validating the way a network payload would (AGENTS §4.3).
  return wasmExtract(markdown) as Facts;
}

/** Expands a template through the shared Rust engine. */
export async function expandTemplate(
  template: string,
  context: { readonly date: string; readonly time: string; readonly title: string; readonly selection: string; readonly uuid: string; readonly user: string },
): Promise<ExpandedTemplate> {
  await load();
  return wasmExpandTemplate(template, context.date, context.time, context.title, context.selection, context.uuid, context.user) as ExpandedTemplate;
}

/** The ProseMirror schema contract (SPEC §5.6), as parsed JSON. */
export async function schema(): Promise<unknown> {
  await load();
  return JSON.parse(wasmSchemaJson()) as unknown;
}

/** Materializes a CRDT update as canonical Markdown for source view and clipboard export. */
export async function markdownFromUpdate(update: Uint8Array): Promise<string> {
  await load();
  return wasmMarkdownFromUpdate(update);
}

/** Parses Markdown into the shared CRDT update format used to apply source-view changes. */
export async function updateFromMarkdown(markdown: string): Promise<Uint8Array> {
  await load();
  return wasmUpdateFromMarkdown(markdown);
}

/** Validates compact client-search bytes before IndexedDB may retain them (§14.2, E6). */
export async function validateSearchSegment(bytes: Uint8Array): Promise<void> {
  await load();
  wasmValidateSearchSegment(bytes);
}

/** Merges an older compact segment with a newer same-epoch delta (§14.2). */
export async function mergeSearchSegments(
  base: Uint8Array,
  delta: Uint8Array,
): Promise<Uint8Array> {
  await load();
  return wasmMergeSearchSegments(base, delta);
}

/** Queries the union of permission-filtered compact segments (§14.2). */
export async function querySearchSegments(
  query: string,
  segments: readonly Uint8Array[],
): Promise<CompactSearchResults> {
  await load();
  return wasmQuerySearchSegments(query, segments) as CompactSearchResults;
}

/** Which side of a conflict a reader chose (`SPEC.md` §3.5). */
export type ConflictSide = "mine" | "theirs" | "both";

/**
 * The WASM entry points §3.5 needs, callable without an `await`.
 *
 * Every other function in this module awaits the module load, so a caller never has to think
 * about it. Reconciling a divergence is the one place that cannot afford to: it runs when the
 * server's state lands on top of local changes, and between reading the document and writing
 * the merged version back there must be no gap a keystroke can fall into. An `await` there is
 * exactly that gap — the merge would be computed from a document that has since moved on, and
 * writing it back would delete whatever was typed in the meantime.
 *
 * So the load is awaited once, up front, and what comes back is this: the same functions,
 * synchronous, for the one caller that has to be atomic.
 */
export interface NoteBridge {
  /** Materializes a CRDT update as canonical Markdown. */
  markdownFromUpdate(update: Uint8Array): string;
  /** Parses Markdown into the shared CRDT update format. */
  updateFromMarkdown(markdown: string): Uint8Array;
  /**
   * Merges an external version of a note into the local one, marking divergences (§3.5).
   *
   * `base` is the Markdown this note had when the two sides were last in sync, and is what
   * tells a collision from an ordinary remote edit. `undefined` degrades to a two-way
   * comparison that keeps content, and so can resurrect a deletion made elsewhere.
   */
  merge(base: string | undefined, mine: string, theirs: string, stamp: string): string;
  /** How many unresolved conflict callouts a note carries, at any depth. */
  count(markdown: string): number;
  /**
   * Resolves the `ordinal`-th unresolved conflict, counting from the top of the note.
   *
   * An ordinal rather than a block index: the editor's document can hold blocks the canonical
   * Markdown does not, so an index taken from what is on screen can address a different
   * block. Returns the note unchanged when there is no such conflict, which is what makes a
   * click on a note that has moved on inert rather than destructive.
   */
  resolve(markdown: string, ordinal: number, keep: ConflictSide): string;
}

/** Loads the module if it is not loaded, and hands back its synchronous entry points. */
export async function noteBridge(): Promise<NoteBridge> {
  await load();
  return {
    markdownFromUpdate: wasmMarkdownFromUpdate,
    updateFromMarkdown: wasmUpdateFromMarkdown,
    merge: (base, mine, theirs, stamp) => wasmMergeWithConflicts(base, mine, theirs, stamp),
    count: wasmConflictCount,
    resolve: (markdown, ordinal, keep) => wasmResolveConflict(markdown, ordinal, keep),
  };
}
