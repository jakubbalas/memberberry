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
  extract as wasmExtract,
  markdownFromUpdate as wasmMarkdownFromUpdate,
  noteTitle as wasmNoteTitle,
  normalize as wasmNormalize,
  schemaJson as wasmSchemaJson,
  toHtml as wasmToHtml,
  updateFromMarkdown as wasmUpdateFromMarkdown,
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
