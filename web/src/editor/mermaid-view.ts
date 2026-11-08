/**
 * Mermaid diagrams in the editor (SPEC §13.2, A38).
 *
 * A diagram is an ordinary ` ```mermaid ` code block. This view adds a rendered preview above
 * the block's own text and hides that text until the caret enters it, so the file and the
 * CRDT see nothing new. Every other code block keeps the schema's own rendering.
 *
 * Which block is "being edited" is a decoration from the selection, not view state, so it
 * needs no bookkeeping across remote edits.
 */

import { Extension } from "@tiptap/core";
import { DOMSerializer, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";

import { sharedMermaidRenderer, type MermaidOutcome, type MermaidRenderer } from "../mermaid/renderer.js";
import { svgElement } from "../mermaid/sanitize.js";
import { mermaidThemeVariables } from "../mermaid/theme.js";
import { THEME_CHANGE_EVENT } from "../shell/theme.js";
import "../mermaid/mermaid.css";

/** How long typing must pause before the preview re-renders. */
export const MERMAID_RENDER_DELAY_MS = 400;

/** True for a code block whose info string names Mermaid. */
export function isMermaidBlock(node: PMNode | null | undefined): node is PMNode {
  if (node?.type.name !== "code_block") return false;
  const lang = node.attrs["lang"];
  return typeof lang === "string" && lang.trim().toLowerCase() === "mermaid";
}

export interface MermaidViewOptions {
  readonly renderer?: MermaidRenderer;
  /** Defaults to the tokens on the document root. */
  readonly theme?: () => Readonly<Record<string, string>>;
  readonly delayMs?: number;
}

const key = new PluginKey("memberberryMermaidView");

interface EditingSpec { readonly mermaidEditing: true }

class MermaidBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly root: HTMLElement;
  private node: PMNode;
  private editing = false;
  private sourceOpen = false;
  private visible = false;
  private destroyed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observer: IntersectionObserver | undefined;
  private readonly onTheme = (): void => { this.renderNow(); };

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    decorations: readonly Decoration[],
    private readonly options: Required<MermaidViewOptions>,
  ) {
    this.node = node;
    const document = view.dom.ownerDocument;
    this.root = document.documentElement;
    this.dom = document.createElement("div");
    this.dom.className = "mb-mermaid";

    const chrome = document.createElement("div");
    chrome.className = "mb-mermaid-chrome";
    chrome.contentEditable = "false";
    this.preview = document.createElement("div");
    this.preview.className = "mb-mermaid-preview";
    this.preview.setAttribute("role", "img");
    this.preview.setAttribute("aria-label", "Mermaid diagram");
    this.preview.addEventListener("mousedown", (event) => {
      if (!this.view.editable) return;
      event.preventDefault();
      this.enterSource();
    });
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "mb-mermaid-toggle";
    this.toggle.addEventListener("mousedown", (event) => { event.preventDefault(); });
    this.toggle.addEventListener("click", (event) => {
      event.preventDefault();
      this.onToggle();
    });
    chrome.append(this.preview, this.toggle);

    const pre = document.createElement("pre");
    pre.className = "mb-mermaid-source";
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(chrome, pre);

    this.setEditing(isEditing(decorations));
    this.root.addEventListener(THEME_CHANGE_EVENT, this.onTheme);
    this.watchVisibility();
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (!isMermaidBlock(node)) return false;
    const changed = node.textContent !== this.node.textContent;
    this.node = node;
    this.setEditing(isEditing(decorations));
    if (changed) this.schedule();
    return true;
  }

  ignoreMutation(mutation: ViewMutationLike): boolean {
    // why: the preview and toggle are ours; only the source text is ProseMirror's.
    return !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.toggle.contains(event.target);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.root.removeEventListener(THEME_CHANGE_EVENT, this.onTheme);
  }

  private watchVisibility(): void {
    const Observer = this.view.dom.ownerDocument.defaultView?.IntersectionObserver;
    if (Observer === undefined) {
      this.visible = true;
      this.renderNow();
      return;
    }
    this.setStatus("Diagram renders when it scrolls into view.");
    this.observer = new Observer((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      this.observer?.disconnect();
      this.observer = undefined;
      this.visible = true;
      this.renderNow();
    }, { rootMargin: "200px" });
    this.observer.observe(this.dom);
  }

  private schedule(): void {
    if (!this.visible) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.renderNow();
    }, this.options.delayMs);
  }

  private renderNow(): void {
    if (this.destroyed || !this.visible) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const source = this.node.textContent;
    const generation = ++this.generation;
    if (source.trim() === "") {
      this.showOutcome({ kind: "error", message: "This diagram is empty." });
      return;
    }
    this.dom.dataset["mermaidState"] = "rendering";
    void this.options.renderer.render(source, this.options.theme(), this.contentWidth()).then((outcome) => {
      if (this.destroyed || generation !== this.generation) return;
      this.showOutcome(outcome);
    });
  }

  /** The preview's width inside its padding, which is what the diagram is laid out into. */
  private contentWidth(): number {
    const style = this.dom.ownerDocument.defaultView?.getComputedStyle(this.preview);
    const padding = (Number.parseFloat(style?.paddingLeft ?? "") || 0) + (Number.parseFloat(style?.paddingRight ?? "") || 0);
    return this.preview.clientWidth - padding;
  }

  private showOutcome(outcome: MermaidOutcome): void {
    if (outcome.kind === "ok") {
      const svg = svgElement(outcome.svg, this.dom.ownerDocument);
      if (svg !== undefined) {
        this.preview.replaceChildren(svg);
        this.dom.dataset["mermaidState"] = "ready";
        return;
      }
      outcome = { kind: "error", message: "The diagram renderer produced no picture." };
    }
    this.setStatus(outcome.message, "mb-mermaid-error");
    this.dom.dataset["mermaidState"] = "error";
  }

  private setStatus(text: string, className = "mb-mermaid-status"): void {
    const message = this.dom.ownerDocument.createElement("p");
    message.className = className;
    message.textContent = text;
    this.preview.replaceChildren(message);
  }

  private setEditing(editing: boolean): void {
    this.editing = editing;
    this.dom.classList.toggle("mb-mermaid-editing", editing);
    this.syncToggle();
  }

  private syncToggle(): void {
    const editable = this.view.editable;
    const open = editable ? this.editing : this.sourceOpen;
    this.dom.classList.toggle("mb-mermaid-source-open", open);
    this.toggle.textContent = editable ? (open ? "Done" : "Edit source") : (open ? "Hide source" : "Show source");
    this.toggle.setAttribute("aria-expanded", String(open));
  }

  private onToggle(): void {
    if (!this.view.editable) {
      this.sourceOpen = !this.sourceOpen;
      this.syncToggle();
      return;
    }
    if (this.editing) leaveSource(this.view, this.getPos());
    else this.enterSource();
  }

  private enterSource(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const end = pos + this.node.nodeSize - 1;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)));
    this.view.focus();
  }
}

/** The subset of `MutationRecord` ProseMirror passes, typed loosely enough for selection records. */
interface ViewMutationLike { readonly target: Node }

function isEditing(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => (decoration.spec as Partial<EditingSpec>).mermaidEditing === true);
}

/** The Mermaid block containing the selection head, as its start position. */
function enclosingMermaid(state: EditorState): number | undefined {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    if (isMermaidBlock($head.node(depth))) return $head.before(depth);
  }
  return undefined;
}

function leaveSource(view: EditorView, pos: number | undefined): boolean {
  if (pos === undefined) return false;
  const node = view.state.doc.nodeAt(pos);
  if (!isMermaidBlock(node)) return false;
  const after = view.state.doc.resolve(Math.min(pos + node.nodeSize, view.state.doc.content.size));
  view.dispatch(view.state.tr.setSelection(TextSelection.near(after, 1)).scrollIntoView());
  view.focus();
  return true;
}

/**
 * Arrow keys into a hidden source. The browser moves a caret past content it cannot see, so
 * an adjacent diagram would be unreachable from the keyboard (SPEC §8.4) without this.
 */
function arrowIntoDiagram(view: EditorView, event: KeyboardEvent): boolean {
  const down = event.key === "ArrowDown";
  if (!down && event.key !== "ArrowUp") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const { selection, doc } = view.state;
  if (!selection.empty || !selection.$head.parent.isTextblock || selection.$head.depth === 0) return false;
  const $head = selection.$head;
  const edge = down ? $head.after() : $head.before();
  const neighbour = down ? doc.resolve(edge).nodeAfter : doc.resolve(edge).nodeBefore;
  // why: the structural check first. endOfTextblock measures layout, so it runs only when a
  // diagram is actually adjacent.
  if (!isMermaidBlock(neighbour) || !view.endOfTextblock(down ? "down" : "up")) return false;
  const target = down ? edge + 1 : edge - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)).scrollIntoView());
  return true;
}

function editingDecorations(state: EditorState): DecorationSet {
  const pos = enclosingMermaid(state);
  if (pos === undefined) return DecorationSet.empty;
  const node = state.doc.nodeAt(pos);
  if (node === null) return DecorationSet.empty;
  const spec: EditingSpec = { mermaidEditing: true };
  return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, {}, spec)]);
}

/** Builds the code-block view for one node: Mermaid blocks get a preview, others do not. */
function codeBlockView(options: Required<MermaidViewOptions>) {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]): NodeView => {
    if (isMermaidBlock(node)) return new MermaidBlockView(node, view, getPos, decorations, options);
    return plainCodeBlock(node, view);
  };
}

/** Exactly the schema's own rendering, recreated whenever the block's attributes change. */
function plainCodeBlock(node: PMNode, view: EditorView): NodeView {
  const toDOM = node.type.spec.toDOM;
  const rendered = toDOM === undefined
    ? { dom: view.dom.ownerDocument.createElement("pre") }
    : DOMSerializer.renderSpec(view.dom.ownerDocument, toDOM(node));
  return {
    dom: rendered.dom,
    ...(rendered.contentDOM === undefined ? {} : { contentDOM: rendered.contentDOM }),
    update: (next) => next.type === node.type && next.sameMarkup(node) && !isMermaidBlock(next),
  };
}

/** Mermaid previews for ` ```mermaid ` code blocks. Install at editor construction. */
export function mermaidViews(options: MermaidViewOptions = {}): Extension {
  const resolved: Required<MermaidViewOptions> = {
    renderer: options.renderer ?? sharedMermaidRenderer(),
    theme: options.theme ?? (() => mermaidThemeVariables(getComputedStyle(document.documentElement))),
    delayMs: options.delayMs ?? MERMAID_RENDER_DELAY_MS,
  };
  return Extension.create({
    name: "memberberryMermaidView",
    // why: last in line, so an open menu (link or emoji suggestions) keeps its arrow keys;
    // this handles them only when nothing else did. Escape is not bound: §8.4 gives it to
    // block selection, and leaving a diagram's source is moving the caret out, or Done.
    priority: 1,
    addProseMirrorPlugins() {
      return [new Plugin({
        key,
        props: {
          decorations: editingDecorations,
          nodeViews: { code_block: codeBlockView(resolved) },
          handleKeyDown: arrowIntoDiagram,
        },
      })];
    },
  });
}
