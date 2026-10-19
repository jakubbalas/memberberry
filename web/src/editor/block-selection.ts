/** Editor-local block selection. Its overlays never enter the ProseMirror document. */
import type { Editor } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import type { BlockMover, BlockMoveTarget, BlockMoveToken } from "./block-move.js";

interface Rect { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }
interface Options {
  readonly editor: Editor;
  readonly panel: HTMLElement;
  readonly mover: BlockMover;
  readonly rect: (unit: BlockMoveTarget) => Rect | undefined;
  readonly changed: (token: BlockMoveToken | undefined) => void;
  readonly dragging: () => boolean;
}
/** A contiguous selection shares exactly the same units and safety checks as movement. */
export interface BlockSelection {
  current(): BlockMoveToken | undefined;
  selecting(): boolean;
  select(token: BlockMoveToken): void;
  extend(direction: -1 | 1): void;
  clear(): void;
  render(): void;
  refresh(): void;
  moved(token: BlockMoveToken): void;
  destroy(): void;
}
interface Marquee {
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  readonly units: readonly BlockMoveTarget[];
  readonly token: BlockMoveToken;
  endX: number;
  endY: number;
  active: boolean;
}
/** Mounts blank-space drag, Shift-click and keyboard selection with clipped purple overlays. */
export function mountBlockSelection(options: Options): BlockSelection {
  const { editor, panel, mover } = options;
  const dom = editor.view.dom; const document = dom.ownerDocument;
  const window = document.defaultView;
  if (!window) throw new Error("block selection requires a window");
  const layer = document.createElement("div"); layer.className = "block-selection-layer";
  layer.dataset["editingUi"] = "block-selection"; layer.setAttribute("aria-hidden", "true");
  const status = document.createElement("div"); status.className = "block-selection-status";
  status.dataset["editingUi"] = "block-selection"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  document.body.append(layer, status);
  let selected: BlockMoveToken | undefined;
  let ownPending = false;
  let anchor: number | undefined; let head: number | undefined;
  let marquee: Marquee | undefined;
  let frame: number | undefined;
  let destroyed = false;
  const current = (): BlockMoveToken | undefined => selected && mover.isCurrent(selected) ? selected : undefined;
  const render = (): void => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined; layer.replaceChildren();
    if (destroyed) return;
    const token = current();
    if (!token && !marquee?.active) return;
    const panelRect = panel.getBoundingClientRect();
    const pane = panel.closest(".note-pane")?.getBoundingClientRect() ?? panelRect;
    const controls = panel.querySelector(".editor-controls")?.getBoundingClientRect();
    const viewport = window.visualViewport;
    // why: desktop sticks its toolbar above the document; mobile pins it at the bottom.
    const controlsAtBottom = controls && controls.top > (pane.top + Math.min(pane.bottom, window.innerHeight)) / 2;
    const bounds = {
      left: Math.max(panelRect.left, pane.left, viewport?.offsetLeft ?? 0),
      right: Math.min(panelRect.right, pane.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth)),
      top: Math.max(panelRect.top, pane.top, controlsAtBottom ? 0 : controls?.bottom ?? 0, viewport?.offsetTop ?? 0),
      bottom: Math.min(panelRect.bottom, pane.bottom, controlsAtBottom ? controls.top : Infinity, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)),
    };
    layer.style.left = `${bounds.left}px`; layer.style.top = `${bounds.top}px`;
    layer.style.width = `${Math.max(0, bounds.right - bounds.left)}px`; layer.style.height = `${Math.max(0, bounds.bottom - bounds.top)}px`;
    const add = (rect: Rect, className: string): void => {
      const box = document.createElement("div"); box.className = className;
      box.style.left = `${rect.left - bounds.left}px`; box.style.top = `${rect.top - bounds.top}px`;
      box.style.width = `${Math.max(1, rect.right - rect.left)}px`; box.style.height = `${Math.max(1, rect.bottom - rect.top)}px`;
      layer.append(box);
    };
    if (token) for (const unit of mover.targets(token).slice(token.index, token.index + token.count)) {
      const rect = options.rect(unit);
      if (rect && rect.bottom >= bounds.top && rect.top <= bounds.bottom) add(rect, "block-selection-highlight");
    }
    if (marquee?.active) add({ left: Math.min(marquee.x, marquee.endX), right: Math.max(marquee.x, marquee.endX), top: Math.min(marquee.y, marquee.endY), bottom: Math.max(marquee.y, marquee.endY) }, "block-selection-marquee");
  };
  const schedule = (): void => {
    if (!destroyed && frame === undefined && (selected || marquee)) frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (marquee?.active) updateMarquee(); else render();
    });
  };
  const set = (token: BlockMoveToken | undefined): void => {
    selected = token;
    const message = token ? `${token.count} ${token.count === 1 ? "block" : "blocks"} selected. Delete removes; Tab/Shift+Tab changes supported list nesting. Shift+↑/↓ extends; Escape clears.` : "";
    if (status.textContent !== message) status.textContent = message;
    dom.classList.toggle("has-block-selection", token !== undefined);
    render(); options.changed(token);
  };
  const cancelMarquee = (): void => {
    const wasSelecting = marquee !== undefined;
    marquee = undefined; dom.classList.remove("is-selecting-blocks");
    if (wasSelecting) options.changed(current());
  };
  const clear = (): void => {
    cancelMarquee(); anchor = undefined; head = undefined; ownPending = false;
    if (selected) set(undefined); else render();
  };
  const select = (token: BlockMoveToken): void => {
    if (!mover.isCurrent(token)) { clear(); return; }
    anchor = token.start;
    const end = mover.targets(token)[token.index + token.count - 1]; head = end?.start ?? token.start;
    // why: force one expanded movement scope so ordinary paragraphs and list items can
    // participate in the same range without changing normal single-block drag targeting.
    set(mover.captureRange(anchor, head));
    editor.view.dispatch(editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(token.start))));
    editor.view.focus();
  };
  const extendTo = (pos: number): void => {
    if (anchor === undefined) return;
    const next = mover.captureRange(anchor, pos);
    if (next) { head = pos; set(next); }
  };
  const extend = (direction: -1 | 1): void => {
    const token = current(); if (!token || head === undefined) return;
    const units = mover.targets(token);
    const at = units.findIndex(unit => unit.start === head);
    const next = units[at + direction];
    if (next) extendTo(next.start);
  };
  const point = (event: PointerEvent): number | undefined => {
    try { return editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos; }
    catch { return undefined; }
  };
  const hitsContent = (event: PointerEvent, pos: number, fallback: Rect | undefined): boolean => {
    const resolved = editor.state.doc.resolve(pos);
    if (!resolved.parent.inlineContent) return true;
    // why: block boxes span the pane, including blank space after text. Only the glyphs
    // beside the nearest caret (including wrapped/marked text and inline atoms) own text drags.
    const from = editor.view.domAtPos(Math.max(resolved.start(), pos - 1));
    const to = editor.view.domAtPos(Math.min(resolved.end(), pos + 1));
    const range = document.createRange();
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset);
    // why: non-layout DOM hosts have no Range geometry; retain their native-text fallback.
    if (typeof range.getClientRects !== "function") return !fallback || fallback.right <= fallback.left
      || (event.clientX >= fallback.left && event.clientX <= fallback.right && event.clientY >= fallback.top && event.clientY <= fallback.bottom);
    return Array.from(range.getClientRects()).some(rect => rect.right > rect.left
      && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
  };
  const down = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof window.Node)) return;
    if (target instanceof window.Element && (target.closest("[data-editing-ui]") || (panel.contains(target) && target.closest(".editor-more, .editor-controls")))) return;
    if (!dom.contains(target) && !panel.contains(target)) { clear(); return; }
    if (event.button !== 0 || event.pointerType === "touch") { clear(); return; }
    if (target instanceof window.Element && target.closest("button, input, a, [contenteditable=false]")) { clear(); return; }
    const pos = point(event);
    const token = pos === undefined ? undefined : mover.capture(pos);
    if (event.shiftKey && current() && token) {
      event.preventDefault(); extendTo(token.start); editor.view.focus(); return;
    }
    // why: blank space belongs to row selection across the entire pane; a drag beginning
    // on rendered content still belongs to native text selection.
    const rect = token && options.rect(token);
    const margin = rect && (event.clientX < rect.left || event.clientX > rect.right);
    const blankRoot = target === dom || target === panel || target instanceof window.Element && target.classList.contains("editor-surface");
    if (!margin && !blankRoot && pos !== undefined && hitsContent(event, pos, rect)) { clear(); return; }
    if (pos === undefined && !blankRoot) { clear(); return; }
    clear();
    const title = editor.state.doc.firstChild;
    const seed = token ?? mover.capture(editor.state.selection.head)
      ?? mover.capture(title?.type.name === "heading" && title.attrs["level"] === 1 ? title.nodeSize : 0);
    if (!seed) return;
    const scope = mover.captureRange(seed.start, seed.start); if (!scope) return;
    event.preventDefault();
    // why: a plain click in blank space must still place the caret at the clicked row.
    editor.view.dispatch(editor.state.tr.setSelection(Selection.near(editor.state.doc.resolve(pos ?? scope.start))));
    editor.view.focus();
    marquee = { pointer: event.pointerId, x: event.clientX, y: event.clientY, endX: event.clientX, endY: event.clientY, units: mover.targets(scope), token: scope, active: false };
    options.changed(undefined);
  };
  const updateMarquee = (): void => {
    if (!marquee || !mover.isCurrent(marquee.token)) { clear(); return; }
    const top = Math.min(marquee.y, marquee.endY); const bottom = Math.max(marquee.y, marquee.endY);
    const hits = marquee.units.filter(unit => {
      if (unit.start === 0 && editor.state.doc.firstChild?.type.name === "heading" && editor.state.doc.firstChild.attrs["level"] === 1) return false;
      const rect = options.rect(unit);
      // why: these are complete rows; a vertical drag in either blank margin need not
      // cross back over the text to select the rows it passes.
      return rect && rect.bottom > top && rect.top < bottom;
    });
    const first = hits[0]; const last = hits.at(-1);
    if (first && last) {
      const next = mover.captureRange(first.start, last.start);
      anchor = first.start; head = last.start; set(next);
    } else set(undefined);
  };
  const move = (event: PointerEvent): void => {
    if (!marquee || event.pointerId !== marquee.pointer) return;
    marquee.endX = event.clientX; marquee.endY = event.clientY;
    if (!marquee.active && Math.hypot(marquee.endX - marquee.x, marquee.endY - marquee.y) < 4) return;
    event.preventDefault(); marquee.active = true; dom.classList.add("is-selecting-blocks");
    schedule();
  };
  const up = (event: PointerEvent): void => {
    if (!marquee || event.pointerId !== marquee.pointer) return;
    if (marquee.active) { event.preventDefault(); marquee.endX = event.clientX; marquee.endY = event.clientY; updateMarquee(); }
    cancelMarquee(); render();
  };
  const cancel = (): void => { if (marquee) clear(); };
  const keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || options.dragging() || event.isComposing || editor.view.composing) return;
    if (event.ctrlKey || event.metaKey) { if (!["Control", "Meta"].includes(event.key)) clear(); return; }
    if (event.altKey) return;
    if (event.key === "Escape" && !selected && panel.querySelector(".block-catalog:not([hidden])")) return;
    if (event.key === "Escape") {
      if (selected || marquee) { event.preventDefault(); clear(); }
      else if (editor.state.selection.empty) {
        const token = mover.capture(editor.state.selection.head);
        if (token) { event.preventDefault(); select(token); }
      }
    } else if (selected && ["Delete", "Backspace", "Tab"].includes(event.key)) {
      event.preventDefault();
      const token = current();
      if (!token) clear();
      else {
        const action = event.key === "Tab" ? event.shiftKey ? "outdent" : "indent" : "delete";
        if (mover.edit(token, action)) {
          if (action === "delete") clear(); else moved(token);
          editor.view.focus();
        }
      }
    } else if (current() && event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); extend(event.key === "ArrowUp" ? -1 : 1);
    } else if (selected && !["Shift", "Control", "Meta", "Alt", "F10", "Tab"].includes(event.key)) clear();
    if (event.defaultPrevented) event.stopImmediatePropagation();
  };
  const refresh = (): void => {
    if (!selected) return;
    if (ownPending && mover.isPending(selected)) return;
    if (!mover.isCurrent(selected)) { clear(); return; }
    if (ownPending) {
      ownPending = false; head = mover.targets(selected)[selected.index + selected.count - 1]?.start ?? selected.start;
      render(); options.changed(selected);
    }
  };
  const moved = (token: BlockMoveToken): void => {
    const next = mover.moved(token);
    if (!next) { clear(); return; }
    ownPending = mover.isPending(next); anchor = next.start;
    // The original range end is a boundary; resolving just inside it retains the last unit.
    head = next.end > next.start ? next.end - 1 : next.start;
    if (!ownPending) head = mover.targets(next)[next.index + next.count - 1]?.start ?? next.start;
    set(next);
  };
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
  // why: PM's Escape selects a parent and Shift-arrows extend native text before bubble
  // listeners run. Block-selection keys must be owned before those default handlers.
  dom.addEventListener("keydown", keydown, true); dom.addEventListener("compositionstart", clear);
  document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
  const destroy = (): void => {
    if (destroyed) return; destroyed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel);
    dom.removeEventListener("keydown", keydown, true); dom.removeEventListener("compositionstart", clear);
    document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
    dom.classList.remove("has-block-selection", "is-selecting-blocks"); layer.remove(); status.remove();
  };
  return { current, selecting: () => marquee !== undefined, select, extend, clear, render, refresh, moved, destroy };
}
