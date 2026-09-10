/** Capture primitives shared by the bookmarklet and browser-extension entry points. */

import { Readability } from "@mozilla/readability";

export type ClipMode = "full" | "selection" | "article";

export interface CapturedClip {
  readonly url: string;
  readonly html: string;
  readonly title?: string;
  readonly author?: string;
}

/** Captures only DOM content, leaving URL fetching and persistence to the server transport. */
export function captureClip(
  mode: ClipMode,
  page: Pick<Document, "URL" | "documentElement" | "querySelector" | "createElement"> = globalThis.document,
  selection: Pick<Selection, "rangeCount" | "getRangeAt"> | null = globalThis.getSelection(),
): CapturedClip {
  if (mode === "selection") {
    const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
    return { url: page.URL, html: range === undefined ? "" : fragmentHtml(range.cloneContents(), page) };
  }
  if (mode === "article") {
    const readable = page instanceof Document ? new Readability(page.cloneNode(true) as Document).parse() : null;
    if (readable?.content !== null && readable?.content !== undefined) {
      return {
        url: page.URL,
        html: readable.content,
        ...(readable.title === null || readable.title === undefined || readable.title === "" ? {} : { title: readable.title }),
        ...(readable.byline === null || readable.byline === undefined || readable.byline === "" ? {} : { author: readable.byline }),
      };
    }
    const article = page.querySelector("article") ?? page.querySelector("main");
    return { url: page.URL, html: article?.outerHTML ?? page.documentElement.outerHTML };
  }
  return { url: page.URL, html: page.documentElement.outerHTML };
}

function fragmentHtml(fragment: DocumentFragment, page: Pick<Document, "createElement">): string {
  const container = page.createElement("div");
  container.append(fragment.cloneNode(true));
  return container.innerHTML;
}
