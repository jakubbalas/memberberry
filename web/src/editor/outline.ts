/**
 * The outline: a note's headings, live (`SPEC.md` §9.5).
 *
 * §9.5 asks for four things — the headings as a tree, click to scroll, the current section
 * highlighted, and drag to reorder sections, *which moves the underlying blocks*. The last
 * one is why this lives in the editor rather than in the sidebar: reordering sections is a
 * document edit, and the document is a ProseMirror doc backed by a CRDT. Only code holding
 * the editor can make that edit as an edit rather than as a rewrite.
 *
 * **The editor announces; the shell renders.** The outline is published as an
 * {@link OUTLINE_EVENT} on every change, the same shape `links.ts` and `task-view.ts` use —
 * the editor is mounted by `note-surface.ts` with no access to the sidebar, and the sidebar
 * must not have to know what a ProseMirror node is. The two requests that travel back down,
 * {@link OUTLINE_GOTO_EVENT} and {@link OUTLINE_MOVE_EVENT}, are dispatched at the element
 * the announcement came from, so a split with two editors cannot cross its wires.
 *
 * Everything a test can pin without a browser is a pure function here: which headings a
 * document has, which blocks a section covers, and which heading a scroll offset is inside.
 */

import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/** Fired at the editor's DOM whenever the note's headings or the current section change. */
export const OUTLINE_EVENT = "memberberry:outline";

/** Sent back down to scroll the note to a heading (§9.5, "click to scroll"). */
export const OUTLINE_GOTO_EVENT = "memberberry:outline-goto";

/** Sent back down to reorder two sections, which moves the blocks under them. */
export const OUTLINE_MOVE_EVENT = "memberberry:outline-move";

/** One heading of the open note. */
export interface OutlineHeading {
  /** Position among the headings, which is what the pane and both requests index by. */
  readonly index: number;
  /** Position among the document's top-level blocks — the section's first block. */
  readonly block: number;
  /** 1–6, as `mb-core`'s schema constrains it. */
  readonly level: number;
  /** The heading's visible text, empty for a heading nobody has typed into yet. */
  readonly text: string;
}

/** What an {@link OUTLINE_EVENT} carries. */
export interface OutlineDetail {
  readonly headings: readonly OutlineHeading[];
  /** The heading the reader is inside, or `-1` above the first one. */
  readonly active: number;
}

/** What an {@link OUTLINE_GOTO_EVENT} carries. */
export interface OutlineGotoDetail {
  readonly index: number;
}

/** What an {@link OUTLINE_MOVE_EVENT} carries: move section `from` to where `to` sits. */
export interface OutlineMoveDetail {
  readonly from: number;
  readonly to: number;
}

/** The headings of `doc`, in document order. */
export function outlineOf(doc: ProseMirrorNode): readonly OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  doc.forEach((node, _offset, block) => {
    if (node.type.name !== "heading") return;
    headings.push({
      index: headings.length,
      block,
      level: levelOf(node),
      text: node.textContent.trim(),
    });
  });
  return headings;
}

/**
 * The top-level blocks one heading owns, as a half-open range of child indices.
 *
 * A section runs to the next heading of equal or higher level, which is the same rule
 * `mb_core::transclude::slice` uses for `![[Note#Heading]]` — one definition of "this
 * section", so what an outline row moves is what a transclusion of it would show.
 * `undefined` for an index that is not a heading.
 */
export function sectionSpan(
  doc: ProseMirrorNode,
  index: number,
): { readonly start: number; readonly end: number } | undefined {
  const headings = outlineOf(doc);
  const heading = headings[index];
  if (heading === undefined) return undefined;
  const next = headings
    .slice(index + 1)
    .find((candidate) => candidate.level <= heading.level);
  return { start: heading.block, end: next?.block ?? doc.childCount };
}

/**
 * Moves the section at `from` to where the section at `to` currently sits.
 *
 * Two precise steps — one insert and one delete — rather than replacing the document with a
 * reordered copy. The doc is a CRDT (§5.6): a whole-document replace would reach the other
 * replicas as "everything was deleted and rewritten", which loses every concurrent edit's
 * intent and inflates the update log for a change that moved three blocks.
 *
 * Levels are left alone. Dragging an `##` above an `#` does not promote it — the heading
 * text is the user's, and silently rewriting it is a bigger claim than "move these blocks".
 *
 * Returns `false` and changes nothing for an index that is not a heading, for a move onto
 * itself, or for a move *into* the section being moved, which has no meaning.
 */
export function moveSection(editor: Editor, from: number, to: number): boolean {
  if (from === to) return false;
  const { doc } = editor.state;
  const source = sectionSpan(doc, from);
  const target = sectionSpan(doc, to);
  if (source === undefined || target === undefined) return false;
  // Dropping a section inside itself: the target heading is one of the blocks being moved.
  if (target.start >= source.start && target.start < source.end) return false;

  const offsets = blockOffsets(doc);
  const at = (block: number): number => offsets[block] ?? doc.content.size;
  const blocks: ProseMirrorNode[] = [];
  for (let block = source.start; block < source.end; block += 1) {
    const node = doc.maybeChild(block);
    if (node !== null && node !== undefined) blocks.push(node);
  }
  if (blocks.length === 0) return false;

  const start = at(source.start);
  const end = at(source.end);
  const landing = at(target.start > source.start ? target.end : target.start);
  const transaction = editor.state.tr;
  if (landing > start) {
    // Insert first: the landing position sits after the source, so deleting the source
    // afterwards leaves the inserted copy where it was put. The other order would move it.
    transaction.insert(landing, Fragment.fromArray(blocks));
    transaction.delete(start, end);
  } else {
    transaction.delete(start, end);
    transaction.insert(landing, Fragment.fromArray(blocks));
  }
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/**
 * Which heading a scroll offset is inside.
 *
 * Pure, and separate from the measuring, because this is the rule and the measuring is the
 * browser's business: the current section is the last heading at or above the top of the
 * viewport, allowing a few pixels so a heading scrolled *to* counts as reached. `-1` when
 * the reader is above the first heading, which is a real state — a note usually opens with
 * a paragraph of front matter above its first `##`.
 */
export function activeHeadingIndex(
  offsets: readonly number[],
  scrollTop: number,
  slack = 4,
): number {
  let active = -1;
  offsets.forEach((offset, index) => {
    if (offset <= scrollTop + slack) active = index;
  });
  return active;
}

export interface OutlineBridge {
  /** Recomputes and re-announces. Called on every document and selection change. */
  refresh(): void;
  destroy(): void;
}

/**
 * Publishes the outline of `editor` and answers the two requests that come back.
 *
 * The scroll container is the editor's own scrolling ancestor, which is what `NotePane`
 * scrolls and what the offsets below are measured against.
 */
export function mountOutline(editor: Editor): OutlineBridge {
  const dom = editor.view.dom;

  /**
   * The scrolling ancestor, resolved lazily and remembered only once it is real.
   *
   * why: not resolved once at mount. The stylesheet is a separate request from the bundle, so
   * under load the editor can mount before `.note-pane`'s `overflow: auto` exists — and a
   * scroller resolved in that moment is the editor's own element, which never scrolls. The
   * outline then scrolled nowhere and highlighted nothing, in a way that passed alone and
   * failed in a full parallel run.
   */
  let found: HTMLElement | undefined;
  const scrollerOf = (): HTMLElement => {
    if (found?.isConnected === true) return found;
    found = scrollParent(dom);
    return found ?? dom;
  };

  let headings: readonly OutlineHeading[] = [];
  let active = -1;

  /**
   * Where each heading sits inside the scrolled content.
   *
   * why: measured rather than remembered. The first version cached this until the document
   * changed, which is wrong for every reason a page reflows without the document changing —
   * a pane resized, a split dragged, a font arriving late — and the symptom is an outline
   * that scrolls to the wrong place and highlights the wrong row. It is one
   * `getBoundingClientRect` per heading, done at most once per animation frame and only
   * while the reader is scrolling, and it interleaves no writes, so it is a read of a layout
   * the browser has already computed rather than a thrash of it (§4.5).
   */
  const measure = (): readonly number[] => {
    const scroller = scrollerOf();
    const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const positions = blockOffsets(editor.state.doc);
    return headings.map((heading) => {
      const node = editor.view.nodeDOM(positions[heading.block] ?? 0);
      return node instanceof HTMLElement ? node.getBoundingClientRect().top - top : 0;
    });
  };

  /**
   * Scrolls a heading to the top of the note.
   *
   * Twice, because scrolling can change what the first measurement said: the browser clamps
   * at the end of the document, and the editor's own controls sit inside the scrolled box.
   * The second pass is against the layout that actually resulted, and it settles because the
   * first pass has already done nearly all of the distance.
   */
  const scrollTo = (index: number): void => {
    for (let pass = 0; pass < 2; pass += 1) {
      const offset = measure()[index];
      if (offset === undefined) return;
      scrollerOf().scrollTop = offset;
    }
  };

  const announce = (): void => {
    dom.dispatchEvent(
      new CustomEvent<OutlineDetail>(OUTLINE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { headings, active },
      }),
    );
  };

  const refresh = (): void => {
    headings = outlineOf(editor.state.doc);
    active =
      headings.length === 0 ? -1 : activeHeadingIndex(measure(), scrollerOf().scrollTop);
    announce();
  };

  // why: rAF rather than a listener that measures on every event. A scroll fires many times
  // per frame; this measures once per frame and announces only when the answer changed.
  let scheduled = 0;
  const onScroll = (event: Event): void => {
    // why: one capturing listener on the document rather than one on the scroller. A scroll
    // event does not bubble, but it does propagate down the capture path — so this hears the
    // pane scroll without having to have identified the pane before the stylesheet arrived,
    // and it costs one comparison for every scroll on the page.
    if (event.target !== scrollerOf()) return;
    if (scheduled !== 0) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      const next = activeHeadingIndex(measure(), scrollerOf().scrollTop);
      if (next === active) return;
      active = next;
      announce();
    });
  };

  const onGoto = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const { index } = event.detail as OutlineGotoDetail;
    const heading = headings[index];
    if (heading === undefined) return;
    // The caret follows, so the next keystroke lands in the section the reader just asked to
    // see rather than wherever it was left.
    //
    // why: the selection is set directly instead of through `editor.commands.focus`. That
    // command's transaction carries ProseMirror's own `scrollIntoView`, which then competes
    // with the scroll below and wins — on a phone it landed the heading 800px down the
    // viewport, because "make the caret visible" and "put this heading at the top" are
    // different requests and only one of them is what a click on an outline row means.
    const position = blockOffsets(editor.state.doc)[heading.block] ?? 0;
    const at = editor.state.doc.resolve(Math.min(position + 1, editor.state.doc.content.size));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(at)));
    scrollTo(index);
  };

  const onMove = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const { from, to } = event.detail as OutlineMoveDetail;
    if (moveSection(editor, from, to)) refresh();
  };

  editor.on("update", refresh);
  document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  dom.addEventListener(OUTLINE_GOTO_EVENT, onGoto);
  dom.addEventListener(OUTLINE_MOVE_EVENT, onMove);
  refresh();

  return {
    refresh,
    destroy: (): void => {
      editor.off("update", refresh);
      document.removeEventListener("scroll", onScroll, { capture: true });
      dom.removeEventListener(OUTLINE_GOTO_EVENT, onGoto);
      dom.removeEventListener(OUTLINE_MOVE_EVENT, onMove);
      if (scheduled !== 0) cancelAnimationFrame(scheduled);
    },
  };
}

/**
 * The element that actually scrolls the note, found rather than named.
 *
 * why: found. The first version asked for `.editor-surface`, which is where Tiptap mounts and
 * is *not* the scroller — `.note-pane` is (`app.css`) — so setting its `scrollTop` was a
 * silent no-op and clicking an outline row did nothing at all. A class name in the editor
 * naming a box owned by the shell's stylesheet is a guess; asking the computed style is not.
 */
function scrollParent(from: HTMLElement): HTMLElement | undefined {
  let element: HTMLElement | null = from.parentElement;
  while (element !== null) {
    const overflow = getComputedStyle(element).overflowY;
    if (overflow === "auto" || overflow === "scroll") return element;
    element = element.parentElement;
  }
  return undefined;
}

/** The start position of every top-level block, plus the end of the document. */
function blockOffsets(doc: ProseMirrorNode): readonly number[] {
  const offsets: number[] = [];
  let position = 0;
  doc.forEach((node) => {
    offsets.push(position);
    position += node.nodeSize;
  });
  offsets.push(position);
  return offsets;
}

function levelOf(node: ProseMirrorNode): number {
  const level: unknown = node.attrs["level"];
  return typeof level === "number" && level >= 1 && level <= 6 ? level : 1;
}
