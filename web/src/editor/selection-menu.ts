/** Editor-local, selection-only formatting. The popup never enters editable content. */
import type { Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import {
  applyInlineFormat, canApplyInlineFormat, captureFormatSelection, inlineFormatState,
  resolveFormatSelection, type FormatSelection, type InlineFormat, type InlineMark,
} from "./selection-format.js";

/** Mode/body readiness is rechecked both for presentation and mutation. */
export interface SelectionMenuOptions {
  readonly editor: Editor;
  readonly panel: HTMLElement;
  readonly canInteract?: () => boolean;
}
/** An editor-lifetime controller with idempotent teardown. Alt-F10 is the keyboard entry. */
export interface SelectionMenu {
  refresh(): void;
  focus(): boolean;
  /** Explicit API selection intent; ordinary PM selectionSet does not renew invalidation. */
  select(range: { readonly from: number; readonly to: number }): boolean;
  destroy(): void;
}

/** Mounts a contextual popup and owns every listener and scheduled geometry read. */
export function mountSelectionMenu(options: SelectionMenuOptions): SelectionMenu {
  const { editor, panel } = options;
  const dom = editor.view.dom;
  const document = dom.ownerDocument;
  const ownerWindow = document.defaultView;
  if (!ownerWindow) throw new Error("selection menu requires a window");
  const window = ownerWindow;
  let destroyed = false;
  let composing = false;
  let restoring = false;
  let applying = false;
  // why: the same doc-changing transaction can subsequently emit selectionUpdate.
  // Mapping a range is not a new selection intent, nor is refresh/focus/readiness.
  let invalidated = false;
  let selectionIntent: { readonly doc: typeof editor.state.doc; readonly selection: TextSelection } | undefined;
  let frame: number | undefined;
  let token: FormatSelection | undefined;
  const canInteract = (): boolean => !destroyed && !composing && panel.dataset["body"] !== "waiting" && (options.canInteract?.() ?? true);
  const popup = document.createElement("div");
  popup.className = "selection-menu";
  popup.dataset["editingUi"] = "selection-format";
  popup.setAttribute("role", "toolbar");
  popup.setAttribute("aria-label", "Selected text formatting");
  popup.hidden = true;
  function button(label: string, glyph = label): HTMLButtonElement {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = glyph;
    control.setAttribute("aria-label", label);
    control.title = label;
    return control;
  }
  const actions = new Map<HTMLButtonElement, InlineMark | "clear">();
  for (const [label, glyph, action] of [
    ["Bold", "B", "strong"], ["Italic", "I", "em"], ["Strikethrough", "S̶", "strikethrough"],
    ["Highlight", "H", "highlight"], ["Inline code", "</>", "code"],
  ] as const) actions.set(button(label, glyph), action);
  const link = button("Link", "↗");
  link.setAttribute("aria-haspopup", "dialog");
  link.setAttribute("aria-expanded", "false");
  const clear = button("Clear formatting", "T×");
  actions.set(clear, "clear");
  const controls = [...actions.keys()];
  controls.splice(controls.length - 1, 0, link);
  popup.append(...controls);
  const form = document.createElement("form");
  form.className = "selection-link-editor";
  form.setAttribute("role", "dialog");
  form.setAttribute("aria-label", "Edit selected text link");
  form.hidden = true;
  const destination = document.createElement("input");
  destination.type = "text";
  destination.setAttribute("aria-label", "Link destination");
  destination.placeholder = "URL or note reference";
  destination.autocomplete = "off";
  const applyLink = button("Apply link");
  applyLink.type = "submit";
  const removeLink = button("Remove link");
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  form.append(destination, applyLink, removeLink, message);
  popup.append(form);
  document.body.append(popup);
  const viewport = window.visualViewport;

  const closeLink = (): void => {
    form.hidden = true;
    link.setAttribute("aria-expanded", "false");
    message.textContent = "";
    destination.value = "";
  };
  const hide = (): void => {
    token = undefined;
    popup.hidden = true;
    closeLink();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const position = (): void => {
    frame = undefined;
    const selection = token && resolveFormatSelection(editor, token, canInteract);
    if (!selection) { hide(); return; }
    const pane = panel.closest<HTMLElement>(".note-pane") ?? panel;
    const bounds = pane.getBoundingClientRect();
    const left = Math.max(viewport?.offsetLeft ?? 0, bounds.left);
    const right = Math.min((viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth), bounds.right || window.innerWidth);
    const top = Math.max(viewport?.offsetTop ?? 0, bounds.top);
    let bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight), bounds.bottom || window.innerHeight);
    const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    if (touch) {
      const utilities = panel.querySelector<HTMLElement>(".editor-controls")?.getBoundingClientRect();
      if (utilities && utilities.top > top && utilities.top < bottom) bottom = utilities.top;
    }
    const rect = popup.getBoundingClientRect();
    const start = editor.view.coordsAtPos(selection.from);
    const end = editor.view.coordsAtPos(selection.to);
    let y = touch ? bottom - rect.height - 8 : Math.min(start.top, end.top) - rect.height - 8;
    if (y < top + 8) y = Math.max(start.bottom, end.bottom) + 8;
    const x = touch ? (left + right - rect.width) / 2 : (start.left + end.right - rect.width) / 2;
    popup.style.left = `${Math.max(left + 8, Math.min(x, right - rect.width - 8))}px`;
    popup.style.top = `${Math.max(top + 8, Math.min(y, bottom - rect.height - 8))}px`;
    popup.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
  };
  const schedule = (): void => {
    if (!popup.hidden && frame === undefined) frame = window.requestAnimationFrame(position);
  };
  const syncControls = (): void => {
    if (!token) return;
    for (const [control, action] of actions) {
      control.disabled = !canApplyInlineFormat(editor, token, action, canInteract);
      if (action !== "clear") control.setAttribute("aria-pressed", inlineFormatState(editor, token, action));
    }
    link.disabled = !canApplyInlineFormat(editor, token, { link: "https://example.invalid" }, canInteract);
    link.setAttribute("aria-pressed", inlineFormatState(editor, token, "link"));
    const first = controls.find((control) => !control.disabled);
    for (const control of controls) control.tabIndex = control === first ? 0 : -1;
  };
  const nativeSelection = (): TextSelection | undefined => {
    const native = document.getSelection();
    if (!native?.anchorNode || !native.focusNode || !dom.contains(native.anchorNode) || !dom.contains(native.focusNode)) return undefined;
    try {
      return TextSelection.create(editor.state.doc,
        editor.view.posAtDOM(native.anchorNode, native.anchorOffset),
        editor.view.posAtDOM(native.focusNode, native.focusOffset));
    } catch {
      // why: detached/replaced node-view DOM is not an address for an editing action.
      return undefined;
    }
  };
  const acceptNativeIntent = (): TextSelection | undefined => {
    if (!invalidated || !selectionIntent || selectionIntent.doc !== editor.state.doc || !canInteract()) return undefined;
    const selection = nativeSelection();
    if (!selection || selection.eq(selectionIntent.selection)) return undefined;
    invalidated = false;
    selectionIntent = undefined;
    return selection;
  };
  const refresh = (): void => {
    if (destroyed || restoring || applying) return;
    const intended = acceptNativeIntent();
    if (invalidated) { hide(); return; }
    if (popup.contains(document.activeElement) && token) {
      if (!resolveFormatSelection(editor, token, canInteract)) hide();
      else schedule();
      return;
    }
    token = captureFormatSelection(editor, canInteract, intended ?? editor.state.selection);
    if (!token) { hide(); return; }
    popup.hidden = false;
    syncControls();
    schedule();
  };
  // why: native selectionchange can lag focus handoff; never trust the previous PM offsets.
  const handoff = (): void => {
    acceptNativeIntent();
    if (invalidated) { hide(); return; }
    if (token && !resolveFormatSelection(editor, token, canInteract)) { hide(); return; }
    const native = document.getSelection();
    if (native?.anchorNode && native.focusNode && dom.contains(native.anchorNode) && dom.contains(native.focusNode)) {
      try {
        const anchor = editor.view.posAtDOM(native.anchorNode, native.anchorOffset);
        const head = editor.view.posAtDOM(native.focusNode, native.focusOffset);
        token = captureFormatSelection(editor, canInteract, TextSelection.create(editor.state.doc, anchor, head));
      } catch {
        // why: detached/replaced node-view DOM is not an address for an editing action.
        hide();
        return;
      }
    } else token ??= captureFormatSelection(editor, canInteract);
    if (!token) hide();
    else syncControls();
  };
  const focus = (): boolean => {
    handoff();
    if (!token) return false;
    popup.hidden = false;
    controls.find((control) => !control.disabled)?.focus({ preventScroll: true });
    schedule();
    return true;
  };
  const select = (range: { readonly from: number; readonly to: number }): boolean => {
    if (editor.isDestroyed || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to < 0 || range.from > editor.state.doc.content.size || range.to > editor.state.doc.content.size) return false;
    const selection = TextSelection.create(editor.state.doc, range.from, range.to);
    if (!captureFormatSelection(editor, canInteract, selection)) return false;
    const doc = editor.state.doc;
    restoring = true;
    try { editor.view.dispatch(editor.state.tr.setSelection(selection)); }
    finally { restoring = false; }
    // why: plugin filtering/appending is not consent to an intervening document edit.
    if (doc !== editor.state.doc || !editor.state.selection.eq(selection)) return false;
    invalidated = false;
    selectionIntent = undefined;
    editor.view.focus();
    refresh();
    return !!token;
  };
  const restore = (): void => {
    const selection = token && resolveFormatSelection(editor, token, canInteract);
    restoring = true;
    hide();
    if (selection) {
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      editor.view.focus();
    }
    restoring = false;
  };
  const run = (action: InlineFormat): boolean => {
    if (!token) return false;
    applying = true;
    let result;
    try { result = applyInlineFormat(editor, token, action, canInteract); }
    finally { applying = false; }
    if (result === "refused") {
      if (token && !resolveFormatSelection(editor, token, canInteract)) { invalidated = true; selectionIntent = undefined; hide(); }
      return false;
    }
    closeLink();
    editor.view.focus();
    refresh();
    return true;
  };
  const onPointer = (event: Event): void => {
    if (popup.contains(event.target as Node)) {
      if (!popup.contains(document.activeElement)) handoff();
      if (event.target instanceof window.Element && event.target.closest("button")) event.preventDefault();
    } else if (dom.contains(event.target as Node)) beginSelectionIntent(event);
    else hide();
  };
  const beginSelectionIntent = (event: Event): void => {
    // why: popup/synthetic events and plugin selectionSet are not human selection intent.
    if (!event.isTrusted || !invalidated || !canInteract() || !editor.isEditable) return;
    const selection = nativeSelection() ?? editor.state.selection;
    if (selection instanceof TextSelection) selectionIntent = { doc: editor.state.doc, selection };
  };
  const finishSelectionIntent = (): void => { if (selectionIntent) refresh(); selectionIntent = undefined; };
  const cancelSelectionIntent = (): void => { selectionIntent = undefined; };
  const onNativeSelection = (): void => { if (selectionIntent) refresh(); };
  const onFocus = (event: FocusEvent): void => {
    if (popup.contains(event.target as Node)) {
      if (!popup.contains(event.relatedTarget as Node)) handoff();
    } else if (!dom.contains(event.target as Node)) hide();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (dom.contains(event.target as Node) && (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a"))) beginSelectionIntent(event);
    if (event.altKey && event.key === "F10" && dom.contains(event.target as Node)) {
      if (focus()) event.preventDefault();
    } else if (controls.includes(event.target as HTMLButtonElement) && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const enabled = controls.filter((control) => !control.disabled);
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus({ preventScroll: true });
    } else if (event.key === "Tab" && dom.contains(event.target as Node)) handoff();
    else if (event.key === "Escape" && !popup.hidden && (popup.contains(event.target as Node) || dom.contains(event.target as Node))) {
      event.preventDefault(); restore();
    }
  };
  const onClick = (event: Event): void => {
    const action = actions.get(event.currentTarget as HTMLButtonElement);
    if (action !== undefined && !run(action)) hide();
  };
  const openLink = (): void => {
    if (!token || !resolveFormatSelection(editor, token, canInteract) || link.disabled) { hide(); return; }
    if (!form.hidden) { closeLink(); schedule(); return; }
    const selection = resolveFormatSelection(editor, token, canInteract);
    let href = "";
    if (selection) editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
      const mark = node.marks.find((candidate) => candidate.type.name === "link");
      if (mark && typeof mark.attrs["href"] === "string") href = mark.attrs["href"];
    });
    destination.value = href;
    form.hidden = false;
    link.setAttribute("aria-expanded", "true");
    destination.focus({ preventScroll: true });
    schedule();
  };
  const submitLink = (event: Event): void => {
    event.preventDefault();
    if (!run({ link: destination.value })) {
      if (!token || !resolveFormatSelection(editor, token, canInteract)) hide();
      else message.textContent = "Enter a safe URL or note reference.";
    }
  };
  const unlink = (): void => { if (!run({ link: null })) hide(); };
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    if (transaction.docChanged && !applying) { invalidated = true; selectionIntent = undefined; hide(); return; }
    if (!applying) refresh();
  };
  const onUpdate = (): void => { if (!editor.isEditable || !canInteract()) { selectionIntent = undefined; hide(); } };
  const startComposition = (): void => { composing = true; selectionIntent = undefined; hide(); };
  const endComposition = (): void => { composing = false; refresh(); };
  editor.on("transaction", onTransaction);
  editor.on("selectionUpdate", refresh);
  editor.on("update", onUpdate);
  editor.on("destroy", destroy);
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("pointerup", finishSelectionIntent, true);
  document.addEventListener("pointercancel", cancelSelectionIntent, true);
  document.addEventListener("selectionchange", onNativeSelection);
  document.addEventListener("keyup", finishSelectionIntent, true);
  document.addEventListener("focusin", onFocus);
  document.addEventListener("keydown", onKey, true);
  dom.addEventListener("compositionstart", startComposition);
  dom.addEventListener("compositionend", endComposition);
  for (const control of actions.keys()) control.addEventListener("click", onClick);
  link.addEventListener("click", openLink);
  form.addEventListener("submit", submitLink);
  removeLink.addEventListener("click", unlink);
  document.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  const reflow = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(schedule) : undefined;
  reflow?.observe(panel.closest<HTMLElement>(".note-pane") ?? panel);
  reflow?.observe(popup);
  const readiness = new window.MutationObserver(() => { if (!canInteract() || dom.hidden) { selectionIntent = undefined; hide(); } });
  readiness.observe(panel, { attributes: true, attributeFilter: ["data-body"] });
  readiness.observe(dom, { attributes: true, attributeFilter: ["hidden"] });
  refresh();
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    hide();
    editor.off("transaction", onTransaction);
    editor.off("selectionUpdate", refresh);
    editor.off("update", onUpdate);
    editor.off("destroy", destroy);
    document.removeEventListener("pointerdown", onPointer, true);
    document.removeEventListener("pointerup", finishSelectionIntent, true);
    document.removeEventListener("pointercancel", cancelSelectionIntent, true);
    document.removeEventListener("selectionchange", onNativeSelection);
    document.removeEventListener("keyup", finishSelectionIntent, true);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("keydown", onKey, true);
    dom.removeEventListener("compositionstart", startComposition);
    dom.removeEventListener("compositionend", endComposition);
    for (const control of actions.keys()) control.removeEventListener("click", onClick);
    link.removeEventListener("click", openLink);
    form.removeEventListener("submit", submitLink);
    removeLink.removeEventListener("click", unlink);
    document.removeEventListener("scroll", schedule, true);
    window.removeEventListener("resize", schedule);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    reflow?.disconnect();
    readiness.disconnect();
    popup.remove();
  }
  return { refresh, focus, select, destroy };
}
