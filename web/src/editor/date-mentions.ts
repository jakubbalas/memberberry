/** Relative date presentation over plain ISO text, with no editor schema/codec change. */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "y-prosemirror";
import { dateKeywords, fullDateLabel, parseLocalDate, relativeDateLabel, resolveDateKeyword, type DateKeyword } from "./relative-date.js";
import "./date-mentions.css";

const key = new PluginKey<DecorationSet>("memberberryDateMentions");
interface DateRange { readonly from: number; readonly to: number; readonly source: string }
interface DateQuery { readonly from: number; readonly to: number; readonly text: string }

function isolateUndo(view: EditorView): void {
  const state = yUndoPluginKey.getState(view.state) as { undoManager?: { stopCapturing(): void } } | undefined;
  state?.undoManager?.stopCapturing();
}

function literal(node: PMNode): boolean {
  return node.type.spec.code === true || node.type.name === "math_block";
}
function protectedTitle(node: PMNode, pos: number): boolean {
  return pos === 0 && node.type.name === "heading" && node.attrs["level"] === 1;
}

function dateRanges(block: PMNode, pos: number): DateRange[] {
  const text = block.textBetween(0, block.content.size, "\n", "\ufffc");
  const result: DateRange[] = [];
  for (const match of text.matchAll(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g)) {
    const start = match.index; const source = match[0]; const end = start + source.length;
    // why: identifiers, URLs, escaped dates and incomplete/invalid timestamps stay literal.
    if (/[\p{L}\p{N}_@\\/:-]/u.test(text[start - 1] ?? "") || /[\p{L}\p{N}_/:+-]/u.test(text[end] ?? "")
      || (!source.includes(":") && /^ \d{1,2}:/.test(text.slice(end))) || !parseLocalDate(source)) continue;
    let excluded = false;
    block.nodesBetween(start, end, node => {
      if (node.marks.some(mark => mark.type.spec.code || mark.type.name === "link")) excluded = true;
    });
    if (!excluded) result.push({ from: pos + 1 + start, to: pos + 1 + end, source });
  }
  return result;
}

function renderRange(range: DateRange): readonly Decoration[] {
  const value = parseLocalDate(range.source);
  if (!value) return [];
  const label = relativeDateLabel(value);
  const full = fullDateLabel(value);
  return [
    Decoration.widget(range.from, () => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "mb-date-mention";
      button.textContent = `@${label}`; button.title = full;
      button.setAttribute("aria-label", full); button.setAttribute("aria-haspopup", "dialog");
      button.dataset["dateSource"] = range.source;
      button.contentEditable = "false";
      return button;
    }, { side: -1, date: range, key: `${range.from}:${range.source}:${label}:${full}` }),
    Decoration.inline(range.from, range.to, { class: "mb-date-source", "aria-hidden": "true" }),
  ];
}

function collect(doc: PMNode, from = 0, to = doc.content.size): Decoration[] {
  const result: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (literal(node) || protectedTitle(node, pos)) return false;
    if (!node.isTextblock) return true;
    for (const range of dateRanges(node, pos)) result.push(...renderRange(range));
    return false;
  });
  return result;
}

function updateDecorations(transaction: Transaction, previous: DecorationSet): DecorationSet {
  if (transaction.getMeta(key) === true) return DecorationSet.create(transaction.doc, collect(transaction.doc));
  if (!transaction.docChanged) return previous;
  let mapped = previous.map(transaction.mapping, transaction.doc);
  const blocks = new Map<number, PMNode>();
  // why: ordinary typing rescans only affected textblocks, never every date in the note.
  let changedRange = false;
  transaction.steps.forEach((step, index) => step.getMap().forEach((_oldFrom, _oldTo, start, end) => {
    changedRange = true;
    const later = transaction.mapping.slice(index + 1);
    const from = Math.max(0, Math.min(transaction.doc.content.size, later.map(start, -1)));
    const to = Math.max(from, Math.min(transaction.doc.content.size, later.map(end, 1)));
    transaction.doc.nodesBetween(from, to, (node, pos) => {
      if (literal(node) || protectedTitle(node, pos)) { blocks.set(pos, node); return false; }
      if (!node.isTextblock) return true;
      blocks.set(pos, node); return false;
    });
  }));
  // why: mark and attribute steps have empty maps but can turn a date into literal code/link text.
  if (!changedRange) return DecorationSet.create(transaction.doc, collect(transaction.doc));
  for (const [pos, block] of blocks) {
    mapped = mapped.remove(mapped.find(pos, pos + block.nodeSize));
    if (!literal(block) && !protectedTitle(block, pos)) mapped = mapped.add(transaction.doc, dateRanges(block, pos).flatMap(renderRange));
  }
  return mapped;
}

function activeQuery(view: EditorView): DateQuery | undefined {
  const { $from, empty } = view.state.selection;
  if (!empty || !view.editable || view.dom.hidden || view.composing || !$from.parent.isTextblock || literal($from.parent)
    || ($from.depth === 1 && protectedTitle($from.parent, $from.before()))
    || $from.marks().some(mark => mark.type.spec.code || mark.type.name === "link")) return undefined;
  const text = $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, "\n", "\ufffc");
  const match = /(?:^|\s)@([a-z]*)$/i.exec(text);
  return match ? { from: $from.pos - (match[1]?.length ?? 0) - 1, to: $from.pos, text: (match[1] ?? "").toLowerCase() } : undefined;
}

/** Adds keyboard/touch mention entry, live local labels and safe date/time editing. */
export const dateMentions = Extension.create({
  name: "memberberryDateMentions",
  addProseMirrorPlugins() {
    let controls: DateControls | undefined;
    return [new Plugin<DecorationSet>({
      key,
      state: {
        init: (_config, state) => DecorationSet.create(state.doc, collect(state.doc)),
        apply: updateDecorations,
      },
      props: {
        decorations: state => key.getState(state),
        handleKeyDown: (_view, event) => controls?.keyDown(event) ?? false,
        handleTextInput: (_view, _from, _to, text) => text === " " && (controls?.completeSpace() ?? false),
        handleDOMEvents: {
          mousedown: (_view, event) => {
            if (!(event.target instanceof Element) || !event.target.closest(".mb-date-mention")) return false;
            event.preventDefault(); return true;
          },
          click: (_view, event) => {
            if (!(event.target instanceof Element)) return false;
            const button = event.target.closest<HTMLButtonElement>(".mb-date-mention");
            if (!button) return false;
            controls?.edit(button); return true;
          },
          blur: (_view, event) => {
            if (!(event.relatedTarget instanceof Node) || !controls?.contains(event.relatedTarget)) controls?.closeMenu();
            return false;
          },
        },
      },
      view: view => {
        controls = new DateControls(view); controls.update();
        return { update: (_view, previous) => controls?.update(previous), destroy: () => { controls?.destroy(); controls = undefined; } };
      },
    })];
  },
});

class DateControls {
  private menu: HTMLDivElement | undefined;
  private query: DateQuery | undefined;
  private items: readonly DateKeyword[] = [];
  private selected = 0;
  private dismissed: { doc: PMNode; from: number; text: string } | undefined;
  private dialog: HTMLDialogElement | undefined;
  private captured: { doc: PMNode; range: DateRange } | undefined;
  private timer: ReturnType<typeof setTimeout>;
  private readonly refresh = (): void => {
    this.view.dispatch(this.view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
  };
  private readonly viewportChanged = (event: Event): void => {
    if (event.target instanceof Node && this.menu?.contains(event.target)) return;
    this.closeMenu();
  };

  constructor(private readonly view: EditorView) {
    this.timer = this.schedule();
    document.addEventListener("visibilitychange", this.refresh);
    window.addEventListener("focus", this.refresh);
    window.addEventListener("resize", this.viewportChanged);
    window.addEventListener("scroll", this.viewportChanged, true);
    window.visualViewport?.addEventListener("resize", this.viewportChanged);
    window.visualViewport?.addEventListener("scroll", this.viewportChanged);
  }

  private schedule(): ReturnType<typeof setTimeout> {
    return setTimeout(() => { this.refresh(); this.timer = this.schedule(); }, 60_000 - Date.now() % 60_000);
  }

  contains(node: Node): boolean { return (this.menu?.contains(node) || this.dialog?.contains(node)) ?? false; }

  update(previous?: EditorState): void {
    if (!this.view.editable || this.view.dom.hidden) this.closeMenu();
    if (this.captured && (this.captured.doc !== this.view.state.doc || !this.view.editable)) this.closeDialog(false);
    if (previous?.doc === this.view.state.doc && previous.selection.eq(this.view.state.selection)) return;
    const query = activeQuery(this.view);
    if (!query || this.dialog || (this.dismissed?.doc === this.view.state.doc && this.dismissed.from === query.from && this.dismissed.text === query.text)) {
      this.closeMenu(); return;
    }
    const items = dateKeywords.filter(word => word.startsWith(query.text));
    if (items.length === 0) { this.closeMenu(); return; }
    if (this.query?.text !== query.text || this.query.from !== query.from) this.selected = 0;
    this.query = query; this.items = items;
    this.renderMenu();
  }

  closeMenu(): void { this.menu?.remove(); this.menu = undefined; this.query = undefined; this.items = []; }

  private choose(keyword: DateKeyword, suffix = ""): boolean {
    const query = activeQuery(this.view);
    if (!query || !keyword.startsWith(query.text)) return false;
    const source = resolveDateKeyword(keyword) + suffix;
    this.closeMenu();
    isolateUndo(this.view);
    this.view.dispatch(this.view.state.tr.insertText(source, query.from, query.to).scrollIntoView());
    isolateUndo(this.view);
    this.view.focus(); return true;
  }

  completeSpace(): boolean {
    const query = activeQuery(this.view);
    const exact = dateKeywords.find(word => word === query?.text);
    return exact !== undefined && this.choose(exact, " ");
  }

  keyDown(event: KeyboardEvent): boolean {
    if (event.target instanceof Element) {
      const button = event.target.closest<HTMLButtonElement>(".mb-date-mention");
      if (button && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.edit(button); return true; }
    }
    if (event.isComposing || this.view.composing) return false;
    if (event.key === " " && this.completeSpace()) { event.preventDefault(); return true; }
    if (this.items.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.items.length) % this.items.length;
        this.renderMenu(); event.preventDefault(); return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const keyword = this.items[this.selected];
        if (keyword && this.choose(keyword)) { event.preventDefault(); return true; }
      }
      if (event.key === "Escape") {
        if (this.query) this.dismissed = { doc: this.view.state.doc, from: this.query.from, text: this.query.text };
        this.closeMenu(); event.preventDefault(); return true;
      }
    }
    return this.navigateDate(event);
  }

  private navigateDate(event: KeyboardEvent): boolean {
    const { empty, from } = this.view.state.selection;
    if (!empty || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    const backward = event.key === "ArrowLeft" || event.key === "Backspace";
    if (!backward && event.key !== "ArrowRight" && event.key !== "Delete") return false;
    const decorations = key.getState(this.view.state)?.find();
    for (const decoration of decorations ?? []) {
      const stored = decoration.spec["date"] as DateRange | undefined;
      if (!stored) continue;
      const range = { from: decoration.from, to: decoration.from + stored.source.length };
      if (backward ? from <= range.from || from > range.to : from < range.from || from >= range.to) continue;
      const transaction = this.view.state.tr;
      if (event.key === "Backspace" || event.key === "Delete") {
        if (!this.view.editable) return false;
        transaction.delete(range.from, range.to);
      } else transaction.setSelection(TextSelection.create(transaction.doc, backward ? range.from : range.to));
      this.view.dispatch(transaction); event.preventDefault(); return true;
    }
    return false;
  }

  private renderMenu(): void {
    this.menu ??= document.createElement("div");
    this.menu.className = "mb-date-menu"; this.menu.setAttribute("role", "listbox"); this.menu.setAttribute("aria-label", "Date mentions");
    this.menu.replaceChildren();
    this.items.forEach((word, index) => {
      const button = document.createElement("button"); button.type = "button";
      button.setAttribute("role", "option"); button.setAttribute("aria-selected", String(index === this.selected));
      button.textContent = `@${word}`;
      const value = parseLocalDate(resolveDateKeyword(word));
      if (value) { const detail = document.createElement("small"); detail.textContent = fullDateLabel(value); button.append(detail); }
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => this.choose(word));
      this.menu?.append(button);
    });
    document.body.append(this.menu);
    const rect = this.view.dom.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight;
    const caret = typeof Range.prototype.getClientRects === "function" ? this.view.coordsAtPos(this.view.state.selection.from) : rect;
    this.menu.style.left = `${Math.max(left + 8, Math.min(caret.left, left + width - this.menu.offsetWidth - 8))}px`;
    this.menu.style.top = `${Math.max(top + 8, Math.min(caret.bottom + 4, top + height - this.menu.offsetHeight - 8))}px`;
  }

  edit(button: HTMLButtonElement): void {
    if (!this.view.editable || this.view.dom.hidden || this.view.composing) return;
    const pos = this.view.posAtDOM(button, 0);
    const widget = key.getState(this.view.state)?.find(pos, pos).find(decoration => decoration.spec["date"] !== undefined);
    const stored = widget?.spec["date"] as DateRange | undefined;
    const range = stored && widget ? { from: widget.from, to: widget.from + stored.source.length, source: stored.source } : undefined;
    if (!range || this.view.state.doc.textBetween(range.from, range.to) !== range.source) return;
    this.closeMenu(); this.closeDialog(false);
    this.captured = { doc: this.view.state.doc, range };
    const dialog = document.createElement("dialog"); this.dialog = dialog;
    dialog.className = "mb-date-dialog"; dialog.setAttribute("aria-label", "Edit date and time");
    const form = document.createElement("form");
    const heading = document.createElement("h2"); heading.textContent = "Date and time"; form.append(heading);
    const field = (label: string, type: string, value: string): HTMLInputElement => {
      const wrapper = document.createElement("label"); wrapper.textContent = label;
      const input = document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", label);
      wrapper.append(input); form.append(wrapper); return input;
    };
    const date = field("Date", "date", range.source.slice(0, 10)); date.required = true; date.min = "0001-01-01"; date.max = "9999-12-31";
    const includeTime = field("Include time", "checkbox", ""); includeTime.checked = range.source.includes(":");
    const time = field("Time", "time", range.source.slice(11) || "00:00"); time.disabled = !includeTime.checked;
    includeTime.addEventListener("change", () => { time.disabled = !includeTime.checked; });
    const message = document.createElement("p"); message.setAttribute("role", "status"); form.append(message);
    const actions = document.createElement("div"); actions.className = "mb-date-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.closeDialog(true));
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save";
    actions.append(cancel, save); form.append(actions); dialog.append(form); document.body.append(dialog);
    form.addEventListener("submit", event => {
      event.preventDefault();
      const captured = this.captured;
      if (!captured || captured.doc !== this.view.state.doc || !this.view.editable || this.view.composing) { this.closeDialog(false); return; }
      const source = date.value + (includeTime.checked ? ` ${time.value}` : "");
      if (!parseLocalDate(source)) { message.textContent = "Choose a valid local date and time."; return; }
      this.closeDialog(false);
      isolateUndo(this.view);
      const transaction = this.view.state.tr.insertText(source, captured.range.from, captured.range.to);
      transaction.setSelection(TextSelection.create(transaction.doc, captured.range.from + source.length));
      this.view.dispatch(transaction.scrollIntoView()); isolateUndo(this.view); this.view.focus();
    });
    dialog.addEventListener("cancel", event => { event.preventDefault(); this.closeDialog(true); });
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    date.focus();
  }

  private closeDialog(focus: boolean): void {
    const hadDialog = this.dialog !== undefined;
    this.dialog?.remove(); this.dialog = undefined; this.captured = undefined;
    if (focus && hadDialog) this.view.focus();
  }

  destroy(): void {
    clearTimeout(this.timer); document.removeEventListener("visibilitychange", this.refresh);
    window.removeEventListener("focus", this.refresh); window.removeEventListener("resize", this.viewportChanged);
    window.removeEventListener("scroll", this.viewportChanged, true);
    window.visualViewport?.removeEventListener("resize", this.viewportChanged);
    window.visualViewport?.removeEventListener("scroll", this.viewportChanged);
    this.closeMenu(); this.closeDialog(false);
  }
}
