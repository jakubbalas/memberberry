/**
 * Wiring for the M0 page.
 *
 * Separated from `main.ts` so it can be tested without a DOM-driven entry point: the
 * dependencies come in as arguments, which is also what lets the tests run the real logic
 * against fakes instead of a browser (AGENTS §4.4 — logic in plain modules).
 */

import type { Facts, Urls } from "../notes.js";

export interface PreviewDeps {
  readonly source: HTMLTextAreaElement;
  readonly rendered: HTMLElement;
  readonly canonical: HTMLElement;
  readonly facts: HTMLElement;
  readonly normalize: (markdown: string) => Promise<string>;
  readonly toHtml: (markdown: string, urls: Urls) => Promise<string>;
  readonly extract: (markdown: string) => Promise<Facts>;
}

/** Links stay within the page: there is no vault to route to yet. */
const URLS: Urls = { note: "#", media: "" };

/**
 * Renders once, then on every edit. Returns a teardown that removes the listener.
 */
export function mount(deps: PreviewDeps): () => void {
  const refresh = (): void => {
    void render(deps);
  };
  deps.source.addEventListener("input", refresh);
  refresh();
  return () => deps.source.removeEventListener("input", refresh);
}

/** One pass: render, canonicalise and extract the current source. */
export async function render(deps: PreviewDeps): Promise<void> {
  const markdown = deps.source.value;
  const [html, canonical, facts] = await Promise.all([
    deps.toHtml(markdown, URLS),
    deps.normalize(markdown),
    deps.extract(markdown),
  ]);
  // why: `innerHTML` is safe here and only here, because the string came from
  // `mb_core::html`, which escapes every text node and attribute and refuses executable URL
  // schemes. Nothing else in this codebase may assign `innerHTML` from note content.
  deps.rendered.innerHTML = html;
  deps.canonical.textContent = canonical;
  deps.facts.textContent = summarise(facts);
}

/** A short, stable rendering of the extracted facts. */
export function summarise(facts: Facts): string {
  const lines = [
    `title:    ${facts.title ?? "—"}`,
    `words:    ${facts.wordCount}`,
    `links:    ${facts.links.map((l) => l.target).join(", ") || "—"}`,
    `tags:     ${facts.tags.join(", ") || "—"}`,
    `emoji:    ${facts.emoji.join(", ") || "—"}`,
    `anchors:  ${facts.anchors.join(", ") || "—"}`,
    `media:    ${facts.media.join(", ") || "—"}`,
    `headings: ${facts.headings.map((h) => `h${h.level} ${h.text}`).join(", ") || "—"}`,
    `tasks:    ${facts.tasks.length}`,
  ];
  for (const task of facts.tasks) {
    lines.push(`  [${task.status}] ${task.text}${task.due === null ? "" : ` (due ${task.due})`}`);
  }
  return lines.join("\n");
}
