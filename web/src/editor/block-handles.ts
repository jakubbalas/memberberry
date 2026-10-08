/** Editor-local hover/focus controls; portals never enter note content or exports. */
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { BlockMoveOptions, BlockMoveToken } from "./block-move.js";
import { createBlockMover } from "./block-move.js";

/** The host must supply a vault-qualified noteKey and current mode/body readiness. */
export interface BlockHandlesOptions extends BlockMoveOptions { readonly panel: HTMLElement }
/** One controller per editor. Alt-Shift-F10 opens the current complete root's actions. */
export interface BlockHandles { focus(): boolean; refresh(): void; destroy(): void }
interface Boundary { index: number; y: number }
interface Drag {
  token: BlockMoveToken;
  pointer: number;
  x: number;
  y: number;
  originX: number;
  originY: number;
  moved: boolean;
  boundary: number | undefined;
  boundaries: Boundary[] | undefined;
}

/** Mounts a constant-size group/menu and owns every listener, observer and frame. */
export function mountBlockHandles(options: BlockHandlesOptions): BlockHandles {
  const { editor, panel } = options;
  const dom = editor.view.dom;
  const document = dom.ownerDocument;
  const ownerWindow = document.defaultView;
  if (!ownerWindow) throw new Error("block handles require a window");
  const window = ownerWindow;
  let destroyed = false;
  let composing = false;
  let applying = false;
  let handingOff = false;
  let token: BlockMoveToken | undefined;
  let frame: number | undefined;
  let drag: Drag | undefined;
  let suppressClick = false;
  const canInteract = (): boolean => !destroyed && !composing && panel.dataset["body"] !== "waiting" && (options.canInteract?.() ?? true);
  const mover = createBlockMover({ ...options, canInteract });
  const group = document.createElement("div"); group.className = "block-handles"; group.hidden = true;
  group.dataset["editingUi"] = "block-movement";
  group.setAttribute("role", "group"); group.setAttribute("aria-label", "Block movement");
  const menu = document.createElement("div"); menu.className = "block-move-menu"; menu.hidden = true;
  menu.dataset["editingUi"] = "block-movement";
  menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "Move block"); menu.tabIndex = -1;
  const indicator = document.createElement("div"); indicator.className = "block-drop-indicator"; indicator.hidden = true;
  indicator.setAttribute("aria-hidden", "true");
  const button = (label: string, glyph = label): HTMLButtonElement => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = glyph; b.setAttribute("aria-label", label); b.title = label; return b;
  };
  const grip = button("Move block", "⠿"); grip.draggable = false;
  const actions = button("Block actions", "⋯"); actions.setAttribute("aria-haspopup", "menu"); actions.setAttribute("aria-expanded", "false");
  const up = button("Move up"); const down = button("Move down");
  up.setAttribute("role", "menuitem"); down.setAttribute("role", "menuitem");
  const limit = document.createElement("p");
  limit.textContent = "Single-editor rearrangement only. Do not rearrange this note while another browser/device is editing it, including offline.";
  menu.append(up, down, limit); group.append(grip, actions); document.body.append(group, menu, indicator);
  panel.classList.add("block-handles-host");
  const viewport = window.visualViewport;
  const close = (): void => { menu.hidden = true; actions.setAttribute("aria-expanded", "false"); };
  const endDrag = (): void => { drag = undefined; indicator.hidden = true; };
  const hide = (): void => {
    token = undefined; group.hidden = true; close(); endDrag();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const syncControls = (): void => {
    up.disabled = !token || !mover.canDrop(token, token.index - 1);
    down.disabled = !token || !mover.canDrop(token, token.index + 2);
  };
  const paneBounds = () => {
    const bounds = panel.getBoundingClientRect();
    const left = Math.max(bounds.left, viewport?.offsetLeft ?? 0);
    const right = Math.min(bounds.right || window.innerWidth, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth));
    const top = Math.max(bounds.top, viewport?.offsetTop ?? 0);
    const bottom = Math.min(bounds.bottom || window.innerHeight, (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight));
    return { left, right, top, bottom };
  };
  const rootElement = (start: number): HTMLElement | undefined => {
    const node = editor.view.nodeDOM(start);
    return node instanceof window.HTMLElement ? node : undefined;
  };
  const readBoundaries = (): Boundary[] => {
    const boundaries: Boundary[] = [];
    let previousBottom: number | undefined;
    const doc = editor.state.doc;
    const firstBody = doc.firstChild?.type.name === "heading" && doc.firstChild.attrs["level"] === 1 ? 1 : 0;
    // why: scan root geometry only during drag/reflow, never on ordinary keystrokes.
    doc.forEach((node, start, index) => {
      if (index < firstBody) return;
      const rect = rootElement(start)?.getBoundingClientRect();
      if (!rect) return;
      boundaries.push({ index, y: previousBottom === undefined ? rect.top : (previousBottom + rect.top) / 2 });
      previousBottom = rect.bottom;
    });
    if (previousBottom !== undefined) boundaries.push({ index: doc.childCount, y: previousBottom });
    return boundaries;
  };
  const position = (): void => {
    frame = undefined;
    if (!token || !mover.isCurrent(token)) { hide(); return; }
    const rect = rootElement(token.start)?.getBoundingClientRect();
    if (!rect) { hide(); return; }
    const bounds = paneBounds();
    if (rect.bottom < bounds.top || rect.top > bounds.bottom) { group.hidden = true; close(); } else group.hidden = false;
    const groupRect = group.getBoundingClientRect();
    group.style.left = `${Math.max(bounds.left + 4, Math.min(rect.left - groupRect.width - 4, bounds.right - groupRect.width - 4))}px`;
    group.style.top = `${Math.max(bounds.top + 4, Math.min(rect.top, bounds.bottom - groupRect.height - 4))}px`;
    if (!menu.hidden) {
      const menuRect = menu.getBoundingClientRect();
      menu.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - 8)}px`;
      menu.style.maxHeight = `${Math.max(0, bounds.bottom - bounds.top - 8)}px`;
      menu.style.left = `${Math.max(bounds.left + 4, Math.min(rect.left, bounds.right - menuRect.width - 4))}px`;
      menu.style.top = `${Math.max(bounds.top + 4, Math.min(rect.bottom + 4, bounds.bottom - menuRect.height - 4))}px`;
    }
    if (!drag) return;
    drag.boundaries ??= readBoundaries();
    drag.boundary = undefined; indicator.hidden = true;
    if (!drag.moved || drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
    let nearest: Boundary | undefined;
    for (const boundary of drag.boundaries) if (!nearest || Math.abs(boundary.y - drag.y) < Math.abs(nearest.y - drag.y)) nearest = boundary;
    if (!nearest || !mover.canDrop(drag.token, nearest.index)) return;
    drag.boundary = nearest.index; indicator.hidden = false;
    indicator.style.left = `${Math.max(bounds.left, rect.left)}px`;
    indicator.style.width = `${Math.max(0, Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left))}px`;
    indicator.style.top = `${Math.max(bounds.top, Math.min(nearest.y, bounds.bottom))}px`;
  };
  const schedule = (): void => { if (!destroyed && token && frame === undefined) frame = window.requestAnimationFrame(position); };
  const show = (next: BlockMoveToken | undefined): void => {
    if (!next) { hide(); return; }
    token = next; group.hidden = false; grip.setAttribute("aria-label", next.label); grip.title = `${next.label} (drag or open actions)`;
    menu.setAttribute("aria-label", next.label); syncControls(); schedule();
  };
  const refresh = (): void => {
    if (destroyed || applying || handingOff) return;
    if (drag || !menu.hidden) { if (!token || !mover.isCurrent(token)) hide(); return; }
    const selection = editor.state.selection;
    show(mover.capture(selection instanceof NodeSelection ? selection.from : selection.head));
  };
  const nativeHandoff = (): void => {
    const native = document.getSelection();
    if (!native?.anchorNode || !native.focusNode || !dom.contains(native.anchorNode) || !dom.contains(native.focusNode)) return;
    try {
      const selection = TextSelection.create(editor.state.doc, editor.view.posAtDOM(native.anchorNode, native.anchorOffset), editor.view.posAtDOM(native.focusNode, native.focusOffset));
      if (!selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent) return;
      handingOff = true;
      editor.view.dispatch(editor.state.tr.setSelection(selection));
    } catch { hide(); } finally { handingOff = false; }
  };
  const openMenu = (): boolean => {
    if (!token || !mover.isCurrent(token)) { hide(); return false; }
    syncControls(); menu.hidden = false; actions.setAttribute("aria-expanded", "true");
    (up.disabled ? down.disabled ? menu : down : up).focus({ preventScroll: true }); schedule(); return true;
  };
  const focus = (): boolean => { if (!canInteract()) { hide(); return false; } nativeHandoff(); refresh(); return openMenu(); };
  const apply = (direction: "up" | "down"): void => {
    const current = token;
    if (menu.hidden || !current || !mover.isCurrent(current)) { hide(); return; }
    close(); applying = true;
    try { if (mover.move(current, direction)) editor.view.focus(); } finally { applying = false; }
    refresh();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && drag) { event.preventDefault(); endDrag(); return; }
    if (event.key === "F10" && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && focus()) event.preventDefault();
  };
  const menuKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { event.preventDefault(); close(); endDrag(); if (!editor.isDestroyed) editor.view.focus(); refresh(); return; }
    const enabled = [up, down].filter(control => !control.disabled);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
    enabled[next]?.focus({ preventScroll: true });
  };
  const open = (): void => { if (suppressClick) { suppressClick = false; return; } openMenu(); };
  const moveUp = (): void => { apply("up"); }; const moveDown = (): void => { apply("down"); };
  const hover = (event: PointerEvent): void => {
    if (drag || !menu.hidden || event.pointerType === "touch" || !(event.target instanceof window.Node) || !dom.contains(event.target)) return;
    try { show(mover.capture(editor.view.posAtDOM(event.target, 0))); } catch { hide(); }
  };
  const leave = (event: PointerEvent): void => {
    if (drag || !menu.hidden || (event.relatedTarget instanceof window.Node && group.contains(event.relatedTarget))) return;
    if (editor.view.hasFocus()) refresh(); else hide();
  };
  const pointerDown = (event: PointerEvent): void => {
    // why: private pointer drag, not PM/native node dragging or transferable node data.
    event.preventDefault(); event.stopPropagation();
    if (event.button !== 0 || event.pointerType === "touch" || !token || !mover.isCurrent(token)) return;
    close(); suppressClick = false;
    drag = { token, pointer: event.pointerId, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, moved: false, boundary: undefined, boundaries: undefined };
    schedule();
  };
  const pointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY;
    drag.moved ||= Math.hypot(drag.x - drag.originX, drag.y - drag.originY) >= 6;
    schedule();
  };
  const pointerUp = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointer) return;
    event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    position();
    const current = drag; if (!current) return;
    suppressClick = current.moved; endDrag();
    if (!current.moved) { openMenu(); return; }
    applying = true;
    try { if (current.boundary !== undefined && mover.drop(current.token, current.boundary)) editor.view.focus(); } finally { applying = false; }
    refresh();
  };
  const cancel = (): void => { endDrag(); };
  const nativeDrag = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const editorNativeDrag = (event: Event): void => { if (drag) nativeDrag(event); };
  const reflow = (): void => { if (drag) drag.boundaries = undefined; schedule(); };
  const invalidate = (): void => { if (!applying && token && !mover.isCurrent(token)) hide(); };
  const startComposition = (): void => { composing = true; hide(); };
  const endComposition = (): void => { composing = false; };
  const focusChanged = (event: FocusEvent): void => {
    if (event.target instanceof window.Node && !dom.contains(event.target) && !group.contains(event.target) && !menu.contains(event.target)) hide();
  };
  const readinessChanged = (): void => {
    const wasDragging = drag !== undefined;
    invalidate();
    if (!wasDragging && !editor.isDestroyed && editor.view.hasFocus()) refresh();
  };
  const observe = new window.MutationObserver(readinessChanged); observe.observe(panel, { attributes: true, attributeFilter: ["data-body"] });
  const unsubscribe = mover.subscribe(change => { if (change === "document") invalidate(); else readinessChanged(); });
  actions.addEventListener("click", open); grip.addEventListener("click", open);
  up.addEventListener("click", moveUp); down.addEventListener("click", moveDown);
  menu.addEventListener("keydown", menuKey); group.addEventListener("keydown", menuKey);
  group.addEventListener("pointerleave", leave);
  group.addEventListener("dragstart", nativeDrag); group.addEventListener("drop", nativeDrag);
  grip.addEventListener("pointerdown", pointerDown);
  dom.addEventListener("keydown", keydown); dom.addEventListener("pointermove", hover); dom.addEventListener("pointerleave", leave);
  dom.addEventListener("compositionstart", startComposition); dom.addEventListener("compositionend", endComposition);
  dom.addEventListener("dragstart", editorNativeDrag, true); dom.addEventListener("drop", editorNativeDrag, true);
  document.addEventListener("pointermove", pointerMove); document.addEventListener("pointerup", pointerUp); document.addEventListener("pointercancel", cancel);
  document.addEventListener("focusin", focusChanged); document.addEventListener("scroll", reflow, true);
  window.addEventListener("resize", reflow); window.addEventListener("blur", cancel);
  viewport?.addEventListener("resize", reflow); viewport?.addEventListener("scroll", reflow);
  editor.on("selectionUpdate", refresh); editor.on("focus", refresh); editor.on("transaction", invalidate);
  const destroy = (): void => {
    if (destroyed) return; destroyed = true; hide(); unsubscribe(); observe.disconnect();
    actions.removeEventListener("click", open); grip.removeEventListener("click", open);
    up.removeEventListener("click", moveUp); down.removeEventListener("click", moveDown);
    menu.removeEventListener("keydown", menuKey); group.removeEventListener("keydown", menuKey);
    group.removeEventListener("pointerleave", leave);
    group.removeEventListener("dragstart", nativeDrag); group.removeEventListener("drop", nativeDrag); grip.removeEventListener("pointerdown", pointerDown);
    dom.removeEventListener("keydown", keydown); dom.removeEventListener("pointermove", hover); dom.removeEventListener("pointerleave", leave);
    dom.removeEventListener("compositionstart", startComposition); dom.removeEventListener("compositionend", endComposition);
    dom.removeEventListener("dragstart", editorNativeDrag, true); dom.removeEventListener("drop", editorNativeDrag, true);
    document.removeEventListener("pointermove", pointerMove); document.removeEventListener("pointerup", pointerUp); document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("focusin", focusChanged); document.removeEventListener("scroll", reflow, true);
    window.removeEventListener("resize", reflow); window.removeEventListener("blur", cancel);
    viewport?.removeEventListener("resize", reflow); viewport?.removeEventListener("scroll", reflow);
    editor.off("selectionUpdate", refresh); editor.off("focus", refresh); editor.off("transaction", invalidate); editor.off("destroy", destroy);
    options.document.off("destroy", destroy);
    mover.destroy(); group.remove(); menu.remove(); indicator.remove(); panel.classList.remove("block-handles-host");
  };
  editor.on("destroy", destroy);
  options.document.on("destroy", destroy);
  if (editor.view.hasFocus()) refresh();
  return { focus, refresh, destroy };
}
