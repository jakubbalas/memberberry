import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import "./document-link-autocomplete.css";

/** The existing permission-filtered /notes catalog, never an unfiltered discovery source. */
export interface DocumentLinkNote {
  readonly path: string;
  readonly title: string | null;
}

/** Loads only metadata the server already authorized for the current reader. */
export type DocumentLinkLoader = () => Promise<readonly DocumentLinkNote[]>;

const MAX_SUGGESTIONS = 8;
const QUERY_WINDOW = 256;
let nextPopupId = 0;
const fold = (value: string): string => value.normalize("NFC").toLowerCase();

/** Prepares metadata once per catalog response, not once per keystroke. */
export function createDocumentLinkIndex(notes: readonly DocumentLinkNote[]): (query: string) => readonly DocumentLinkNote[] {
  const entries = notes.map((note) => ({
    note, title: fold(note.title ?? note.path.replace(/\.md$/, "")),
    path: fold(note.path), basename: fold(note.path.split("/").pop()?.replace(/\.md$/, "") ?? note.path),
  })).sort((a, b) => a.note.path < b.note.path ? -1 : a.note.path > b.note.path ? 1 : 0);
  return (query) => {
    const search = fold(query.trim());
    const indices: number[] = [];
    const scores: number[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === undefined) continue;
      const score = entry.title === search ? 0 : entry.basename === search ? 1
        : entry.title.startsWith(search) ? 2 : entry.basename.startsWith(search) ? 3
        : entry.title.includes(search) ? 4 : entry.path.includes(search) ? 5 : -1;
      if (score < 0) continue;
      let at = 0;
      while (at < scores.length && (scores[at] ?? Infinity) <= score) at += 1;
      if (at >= MAX_SUGGESTIONS) continue;
      scores.splice(at, 0, score);
      indices.splice(at, 0, index);
      if (indices.length > MAX_SUGGESTIONS) { indices.pop(); scores.pop(); }
    }
    return indices.flatMap((index) => {
      const note = entries[index]?.note;
      return note === undefined ? [] : [note];
    });
  };
}

interface LinkQuery {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly alias: string | null;
  readonly anchor_kind: "none" | "heading" | "block";
  readonly anchor_text: string | null;
}

/** Finds an unfinished editor input trigger; existing Markdown is still parsed only by WASM. */
function activeQuery(view: EditorView): LinkQuery | undefined {
  const { $from, empty } = view.state.selection;
  if (!empty || !view.editable || !$from.parent.isTextblock || $from.parent.type.spec.code
    || $from.marks().some((mark) => mark.type.spec.code)) return undefined;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - QUERY_WINDOW), $from.parentOffset, "\n", "\ufffc");
  const start = before.lastIndexOf("[[");
  if (start < 0 || before[start - 1] === "\\" || before[start - 1] === "!") return undefined;
  const left = before.slice(start + 2);
  if (/[\[\]\n\ufffc]/u.test(left)) return undefined;
  const after = $from.parent.textBetween($from.parentOffset, Math.min($from.parent.content.size, $from.parentOffset + QUERY_WINDOW), "\n", "\ufffc");
  const end = after.indexOf("]]");
  const right = end < 0 ? "" : after.slice(0, end);
  if (/[\[\]\n\ufffc]/u.test(right)) return undefined;
  const value = left + right;
  const pipe = value.indexOf("|");
  const reference = pipe < 0 ? value : value.slice(0, pipe);
  const hash = reference.indexOf("#");
  const anchor = hash < 0 ? "" : reference.slice(hash + 1);
  return {
    from: $from.pos - left.length - 2, to: $from.pos + (end < 0 ? 0 : end + 2),
    text: hash < 0 ? reference : reference.slice(0, hash),
    alias: pipe < 0 ? null : value.slice(pipe + 1),
    anchor_kind: hash < 0 ? "none" : anchor.startsWith("^") ? "block" : "heading",
    anchor_text: hash < 0 ? null : anchor.startsWith("^") ? anchor.slice(1) : anchor,
  };
}

/** A lazy, keyboard and touch operable [[note chooser built from the authorized catalog. */
export function documentLinkAutocomplete(load: DocumentLinkLoader): Extension {
  return Extension.create({
    name: "memberberryDocumentLinkAutocomplete",
    addProseMirrorPlugins() {
      let menu: LinkMenu | undefined;
      return [new Plugin({
        props: {
          handleKeyDown: (_view, event) => menu?.key(event) ?? false,
          handleDOMEvents: {
            blur: (_view, event) => {
              if (event.relatedTarget instanceof Node && menu?.contains(event.relatedTarget)) return false;
              menu?.close();
              return false;
            },
          },
        },
        view: (view) => {
          menu = new LinkMenu(view, load);
          return {
            update: (_view, previous) => {
              if (!previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection)) menu?.refresh();
            },
            destroy: () => { menu?.close(); menu = undefined; },
          };
        },
      })];
    },
  });
}

class LinkMenu {
  private readonly id = `document-suggestions-${++nextPopupId}`;
  private popup: HTMLDivElement | undefined;
  private query: LinkQuery | undefined;
  private items: readonly DocumentLinkNote[] = [];
  private rank: ReturnType<typeof createDocumentLinkIndex> | undefined;
  private selected = 0;
  private generation = 0;
  private dismissed: number | undefined;
  private unwatchViewport: (() => void) | undefined;
  private readonly viewportChanged = (event: Event): void => {
    // why: scrolling the options themselves must remain possible on touch screens.
    if (event.target instanceof Node && this.popup?.contains(event.target)) return;
    this.dismissed = this.query?.from;
    this.close();
  };

  constructor(private readonly view: EditorView, private readonly load: DocumentLinkLoader) {}

  contains(node: Node): boolean { return this.popup?.contains(node) ?? false; }

  refresh(): void {
    const query = activeQuery(this.view);
    if (query === undefined) { this.close(); this.dismissed = undefined; return; }
    if (query.from === this.dismissed) return;
    const opening = this.query?.from !== query.from;
    if (opening) { this.close(); this.dismissed = undefined; }
    this.query = query;
    this.selected = 0;
    if (opening) {
      const generation = ++this.generation;
      this.render("Loading documents…");
      void this.load().then((notes) => {
        if (generation !== this.generation) return;
        this.rank = createDocumentLinkIndex(notes);
        this.updateItems();
      }).catch(() => {
        if (generation === this.generation) this.render("Documents unavailable.");
      });
    } else this.updateItems();
  }

  key(event: KeyboardEvent): boolean {
    if (this.query === undefined || event.isComposing) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.dismissed = this.query.from;
      this.close();
      return true;
    }
    if (this.items.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
      this.render();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this.choose(this.selected);
      return true;
    }
    return false;
  }

  close(): void {
    this.unwatchViewport?.();
    this.unwatchViewport = undefined;
    this.generation += 1;
    this.popup?.remove();
    this.popup = undefined;
    this.query = undefined;
    this.rank = undefined;
    this.items = [];
    this.view.dom.removeAttribute("aria-controls");
    this.view.dom.removeAttribute("aria-activedescendant");
  }

  private updateItems(): void {
    if (this.query === undefined || this.rank === undefined) return;
    this.items = this.rank(this.query.text);
    this.render(this.items.length === 0 ? "No matching documents." : undefined);
  }

  private choose(index: number): void {
    const note = this.items[index];
    const query = this.query;
    const type = this.view.state.schema.nodes["wikilink"];
    if (note === undefined || query === undefined || type === undefined) return;
    const node = type.create({ target: note.path.replace(/\.md$/, ""), embed: false,
      alias: query.alias, anchor_kind: query.anchor_kind, anchor_text: query.anchor_text });
    const transaction = this.view.state.tr.replaceWith(query.from, query.to, node);
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(query.from + node.nodeSize)));
    this.close();
    this.view.dispatch(transaction);
    this.view.focus();
  }

  private render(message?: string): void {
    const document = this.view.dom.ownerDocument;
    if (this.popup === undefined) {
      this.popup = document.createElement("div");
      const window = document.defaultView;
      const viewport = window?.visualViewport;
      // why: the popup is fixed to a caret measured once. Close instead of leaving stale
      // coordinates when a pane scrolls, the keyboard opens, or the viewport is resized.
      window?.addEventListener("scroll", this.viewportChanged, true);
      window?.addEventListener("resize", this.viewportChanged, false);
      viewport?.addEventListener("scroll", this.viewportChanged, false);
      viewport?.addEventListener("resize", this.viewportChanged, false);
      this.unwatchViewport = () => {
        window?.removeEventListener("scroll", this.viewportChanged, true);
        window?.removeEventListener("resize", this.viewportChanged, false);
        viewport?.removeEventListener("scroll", this.viewportChanged, false);
        viewport?.removeEventListener("resize", this.viewportChanged, false);
      };
    }
    const popup = this.popup;
    popup.id = this.id;
    popup.className = "document-link-autocomplete";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", "Document suggestions");
    popup.replaceChildren();
    this.view.dom.setAttribute("aria-controls", this.id);
    this.view.dom.removeAttribute("aria-activedescendant");
    if (message !== undefined) {
      const status = document.createElement("div");
      status.setAttribute("role", "status");
      status.textContent = message;
      popup.append(status);
    } else this.items.forEach((note, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.tabIndex = -1;
      option.id = `${this.id}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === this.selected));
      const title = document.createElement("span");
      title.textContent = note.title ?? note.path.replace(/\.md$/, "");
      const path = document.createElement("small");
      path.textContent = note.path;
      option.append(title, path);
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.choose(index));
      popup.append(option);
      if (index === this.selected) this.view.dom.setAttribute("aria-activedescendant", option.id);
    });
    if (!popup.isConnected) document.body.append(popup);
    const window = document.defaultView;
    const viewport = window?.visualViewport;
    const width = viewport?.width ?? window?.innerWidth ?? 320;
    const height = viewport?.height ?? window?.innerHeight ?? 600;
    const offsetLeft = viewport?.offsetLeft ?? 0;
    const offsetTop = viewport?.offsetTop ?? 0;
    try {
      const caret = this.view.coordsAtPos(this.view.state.selection.from);
      popup.style.left = `${Math.max(offsetLeft + 8, Math.min(caret.left, offsetLeft + width - popup.offsetWidth - 8))}px`;
      if (offsetTop + height - caret.bottom < 200) {
        popup.style.top = "auto";
        popup.style.bottom = `${(window?.innerHeight ?? height) - caret.top + 4}px`;
        popup.style.maxHeight = `${Math.max(44, caret.top - offsetTop - 8)}px`;
      } else {
        popup.style.bottom = "auto";
        popup.style.top = `${caret.bottom + 4}px`;
        popup.style.maxHeight = `${Math.min(320, offsetTop + height - caret.bottom - 12)}px`;
      }
    } catch {
      // jsdom has no layout; the real-browser spec verifies viewport positioning.
      popup.style.left = "0px";
      popup.style.top = "0px";
    }
  }
}
