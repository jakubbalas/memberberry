/**
 * A second, independent pass over Mermaid's SVG before it enters the page (SPEC §13.2).
 *
 * Mermaid's `strict` security level already runs DOMPurify. This pass exists because diagram
 * source is written by other vault members and a renderer bug is one dependency update away:
 * it removes anything executable and anything that would fetch from a URL (C1), and keeps
 * only same-document references such as `url(#arrowhead)`.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Elements that can execute, embed another document, or load a resource. */
const FORBIDDEN_ELEMENTS = new Set([
  "script", "iframe", "object", "embed", "link", "meta", "base", "audio", "video", "img", "image", "animate",
  "set", "animatemotion", "animatetransform", "form", "input", "button", "textarea", "select",
]);

/** Attributes whose value is a URL. Only same-document fragments survive. */
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "action", "formaction"]);

/**
 * Parses Mermaid's markup and returns a sanitized SVG string, or `undefined` when the
 * markup is not an SVG document at all.
 */
export function sanitizeSvg(markup: string): string | undefined {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") return undefined;
  clean(root);
  return new XMLSerializer().serializeToString(root);
}

/** Parses already-sanitized markup into an element owned by `document`. */
export function svgElement(markup: string, document: Document): Element | undefined {
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") return undefined;
  return document.importNode(root, true);
}

function clean(element: Element): void {
  for (const child of Array.from(element.children)) {
    if (FORBIDDEN_ELEMENTS.has(child.localName.toLowerCase())) {
      child.remove();
      continue;
    }
    if (child.localName.toLowerCase() === "style" && !safeStyle(child.textContent ?? "")) {
      child.remove();
      continue;
    }
    clean(child);
  }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) element.removeAttribute(attribute.name);
    else if (URL_ATTRIBUTES.has(name) && !attribute.value.trim().startsWith("#")) element.removeAttribute(attribute.name);
    else if (name === "style" && !safeStyle(attribute.value)) element.removeAttribute(attribute.name);
  }
}

/** CSS may reference same-document fragments, never an import or an external resource. */
export function safeStyle(css: string): boolean {
  if (/@import/i.test(css)) return false;
  if (/expression\s*\(/i.test(css)) return false;
  // why: CSS escapes spell `url(` without the letters (`\75 rl(`); Mermaid emits none.
  if (css.includes("\\")) return false;
  const urls = css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi);
  for (const match of urls) {
    if (!(match[2] ?? "").trim().startsWith("#")) return false;
  }
  return true;
}
