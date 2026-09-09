/** Inline, read-only PDF previews for Markdown media links (§12.4). */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface PdfViewContext {
  readonly vault: string;
}

/** Adds a PDF object after each media PDF link without changing the document model. */
export function pdfViews(context: PdfViewContext): Extension {
  return Extension.create({
    name: "memberberryPdfViews",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey("memberberryPdfViews"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              if (!node.isText) return;
              const link = node.marks.find((mark) => mark.type.name === "link");
              const href = link?.attrs["href"];
              if (typeof href !== "string" || !isMediaPdf(href)) return;
              const end = position + node.nodeSize;
              const next = state.doc.resolve(end).nodeAfter;
              const continues = next?.marks.some((mark) =>
                mark.type.name === "link" && mark.attrs["href"] === href
              ) ?? false;
              if (continues) return;
              decorations.push(Decoration.widget(end, () => pdfObject(context.vault, href), {
                side: 1,
                key: `${position}:${href}`,
              }));
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      })];
    },
  });
}

function pdfObject(vault: string, path: string): HTMLElement {
  const object = document.createElement("object");
  object.className = "media-pdf-viewer";
  object.type = "application/pdf";
  object.data = `/api/v1/vaults/${encodeURIComponent(vault)}/media/${path}`;
  object.setAttribute("aria-label", "PDF preview");
  object.setAttribute("contenteditable", "false");
  const fallback = document.createElement("a");
  fallback.href = object.data;
  fallback.textContent = "Open PDF";
  object.append(fallback);
  return object;
}

function isMediaPdf(path: string): boolean {
  return path.startsWith("media/") && path.toLowerCase().endsWith(".pdf");
}
