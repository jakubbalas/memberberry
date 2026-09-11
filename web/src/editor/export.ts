/** Browser-side single-note exports (`SPEC.md` §19.2). */

export type ExportFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HtmlExportOptions {
  readonly root: HTMLElement;
  readonly title: string;
  readonly document?: Document;
  readonly fetch?: ExportFetch;
}

/** Builds one standalone HTML document from the rendered note DOM. */
export async function standaloneHtml(options: HtmlExportOptions): Promise<string> {
  const document = options.document ?? window.document;
  const fetch = options.fetch ?? window.fetch.bind(window);
  const content = options.root.cloneNode(true);
  if (!(content instanceof HTMLElement)) throw new Error("the rendered note could not be cloned");
  content.removeAttribute("contenteditable");
  for (const editable of content.querySelectorAll("[contenteditable]")) editable.removeAttribute("contenteditable");
  await inlineMedia(content, fetch);
  const title = escapeHtml(options.title);
  const css = stylesheetText(document).replaceAll("</style", "<\\/style");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body><main class="standalone-note">${content.outerHTML}</main></body></html>\n`;
}

/** Downloads a standalone HTML string without retaining its object URL. */
export function downloadHtml(
  html: string,
  title: string,
  document: Document = window.document,
  url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): void {
  const href = url.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${safeFilename(title)}.html`;
  anchor.click();
  url.revokeObjectURL(href);
}

/** Prints exactly one editor panel; the browser's print destination supplies PDF. */
export function printPanel(panel: HTMLElement, target: Window = window): () => void {
  const body = panel.ownerDocument.body;
  const cleanup = (): void => {
    delete panel.dataset["printing"];
    body.classList.remove("memberberry-printing");
    target.removeEventListener("afterprint", cleanup);
  };
  body.classList.add("memberberry-printing");
  panel.dataset["printing"] = "true";
  target.addEventListener("afterprint", cleanup);
  try {
    target.print();
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
  return cleanup;
}

async function inlineMedia(root: HTMLElement, fetch: ExportFetch): Promise<void> {
  const resources = [
    ...[...root.querySelectorAll<HTMLImageElement>("img[src]")].map((element) => ({ element, attribute: "src" })),
    ...[...root.querySelectorAll<HTMLObjectElement>("object[data]")].map((element) => ({ element, attribute: "data" })),
  ];
  for (const resource of resources) {
    const source = resource.element.getAttribute(resource.attribute);
    if (source === null || source.startsWith("data:")) continue;
    const response = await fetch(source, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`media export failed with HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
    resource.element.setAttribute(resource.attribute, `data:${type};base64,${base64(bytes)}`);
  }
}

function stylesheetText(document: Document): string {
  const css: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      css.push([...sheet.cssRules].map((rule) => rule.cssText).join("\n"));
    } catch {
      throw new Error("a stylesheet could not be embedded in the HTML export");
    }
  }
  return css.join("\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeFilename(title: string): string {
  const safe = title.trim().replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replaceAll(/\s+/g, " ");
  return safe.length === 0 ? "note" : safe.slice(0, 120);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
