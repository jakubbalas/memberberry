/** Searchable insertion and conversion controls using the existing Markdown schema. */
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "y-prosemirror";
import { insertBlock } from "./commands.js";
import { applyBlockFormat, blockFormatState, captureBlockSelection, type BlockSelection } from "./block-format.js";
import { singleEditorMessages, type SingleEditorGate } from "./single-editor.js";
import { parseNaturalDate, todayDate } from "./task-metadata.js";
import { openTemplatePalette } from "../shell/templates.js";
import "./block-catalog.css";

/** The host supplies current editor readiness and existing media/emoji controls. */
export interface BlockCatalogOptions {
  readonly editor: Editor;
  readonly host: HTMLElement;
  readonly status: HTMLElement;
  readonly canInteract: () => boolean;
  readonly gate?: SingleEditorGate;
  readonly image?: () => void;
  readonly emoji: () => void;
  readonly onDraftStateChange?: () => void;
}
interface Entry { label: string; group: string; icon: string; hint?: string; aliases?: string; content?: JSONContent; form?: "code" | "math" | "inline" | "web" | "date"; action?: "image" | "emoji" | "note" | "table" | "template" }
const entries: readonly Entry[] = [
  { label: "Text", group: "Basic blocks", icon: "T", content: { type: "paragraph" } },
  ...[1, 2, 3, 4].map(level => ({ label: `Heading ${level}`, group: "Basic blocks", icon: `H${level}`, hint: "#".repeat(level), content: { type: "heading", attrs: { level } } })),
  { label: "Bulleted list", aliases: "bullet list", group: "Basic blocks", icon: "•", hint: "-", content: { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph" }] }] } },
  { label: "Numbered list", group: "Basic blocks", icon: "1.", hint: "1.", content: { type: "ordered_list", attrs: { start: 1 }, content: [{ type: "list_item", content: [{ type: "paragraph" }] }] } },
  { label: "To-do list", aliases: "task checkbox", group: "Basic blocks", icon: "☑", hint: "[]", content: { type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] }, content: [{ type: "paragraph" }] }] } },
  { label: "Toggle list", group: "Basic blocks", icon: "▸", content: { type: "callout", attrs: { kind: "note", fold: "expanded" }, content: [{ type: "callout_title" }, { type: "paragraph" }] } },
  { label: "Callout", group: "Basic blocks", icon: "!", content: { type: "callout", attrs: { kind: "note", fold: "none" }, content: [{ type: "callout_title" }, { type: "paragraph" }] } },
  { label: "Quote", group: "Basic blocks", icon: "❞", hint: ">", content: { type: "blockquote", content: [{ type: "paragraph" }] } },
  { label: "Table", group: "Basic blocks", icon: "▦", action: "table" },
  { label: "Divider", group: "Basic blocks", icon: "—", hint: "***", content: { type: "divider" } },
  { label: "Image", group: "Media", icon: "▧", action: "image" },
  { label: "Code", group: "Media", icon: "</>", hint: "```", form: "code" },
  { label: "Web bookmark", aliases: "web link url", group: "Media", icon: "↗", form: "web" },
  { label: "Block equation", group: "Advanced blocks", icon: "∑", hint: "$$", form: "math" },
  { label: "Template", group: "Advanced blocks", icon: "▤", action: "template" },
  { label: "Link to note", aliases: "page mention document", group: "Inline", icon: "↗", hint: "[[", action: "note" },
  { label: "Date", group: "Inline", icon: "▣", form: "date" },
  { label: "Emoji", group: "Inline", icon: "☺", action: "emoji" },
  { label: "Inline equation", group: "Inline", icon: "√", hint: "$", form: "inline" },
];
interface Target { doc: PMNode; from: number; to: number; below: boolean; slash: boolean }

/** Mounts one catalogue; a changed document invalidates every captured insertion/form. */
export function mountBlockCatalog(options: BlockCatalogOptions) {
  const { editor, host, status } = options;
  const menu = document.createElement("div");
  menu.className = "slash-menu block-catalog";
  menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", "Block menu"); menu.hidden = true;
  const search = document.createElement("input"); search.type = "search"; search.placeholder = "Type to filter…"; search.setAttribute("aria-label", "Filter blocks");
  const list = document.createElement("div"); list.setAttribute("role", "menu"); list.setAttribute("aria-label", "Block choices");
  const form = document.createElement("form"); form.hidden = true;
  const message = document.createElement("p"); message.setAttribute("role", "status");
  const closeButton = document.createElement("button"); closeButton.type = "button"; closeButton.textContent = "Close menu";
  menu.append(search, list, form, message, closeButton); host.after(menu);
  let destroyed = false; let applying = false; let manual = false; let dismissed: string | undefined;
  let dismissedDoc: PMNode | undefined;
  let target: Target | undefined; let conversion: BlockSelection | undefined;
  let submit: (() => void) | undefined;
  const allowed = (): boolean => !destroyed && !editor.isDestroyed && editor.isEditable && editor.view.editable
    && !editor.view.composing && !editor.view.dom.hidden && options.canInteract();
  const current = (): boolean => allowed() && target?.doc === editor.state.doc;
  const conversionAllowed = (): boolean => allowed() && options.gate !== undefined && options.gate.refusal() === undefined;
  const beforeCaret = (): string => {
    const { $from } = editor.state.selection;
    return $from.parent.textBetween(0, $from.parentOffset, "\n", "\ufffc");
  };
  const query = (): string | null => /(?:^|\s)\/(.*)$/.exec(beforeCaret())?.[1] ?? null;
  const hide = (): void => {
    const draft = !menu.hidden && !form.hidden;
    menu.hidden = true; manual = false; target = undefined; conversion = undefined; submit = undefined; dismissed = beforeCaret(); dismissedDoc = editor.state.doc;
    if (draft) options.onDraftStateChange?.();
  };
  const close = (): void => { hide(); if (!editor.isDestroyed) editor.view.focus(); };
  const position = (): void => {
    if (menu.hidden || editor.isDestroyed) return;
    const rect = host.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight;
    const chromeBottom = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? top;
    const availableTop = Math.max(top, chromeBottom);
    menu.style.maxHeight = `${Math.max(0, top + height - availableTop - 16)}px`;
    menu.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(availableTop + 8, Math.min(rect.bottom + 4, top + height - menu.offsetHeight - 8))}px`;
  };
  const isolate = (): void => {
    const undo = yUndoPluginKey.getState(editor.state) as { undoManager?: { stopCapturing(): void } } | undefined;
    undo?.undoManager?.stopCapturing();
  };
  const insert = (content: JSONContent): boolean => {
    if (!current() || !target) { hide(); return false; }
    const captured = target;
    applying = true; isolate();
    try {
      const node = editor.schema.nodeFromJSON(content);
      const replacement = captured.below && node.isInline ? editor.schema.nodes["paragraph"]?.create(null, node) : node;
      if (!replacement) return false;
      const resolved = captured.doc.resolve(captured.from);
      const belowRoot = !captured.slash && !captured.below && node.isBlock && resolved.depth > 0;
      const from = belowRoot ? resolved.after(1) : captured.from;
      const to = belowRoot ? from : captured.to;
      const transaction = editor.state.tr.replaceWith(from, to, replacement);
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(transaction.doc.content.size, from + (replacement.isLeaf ? replacement.nodeSize : 1))), 1));
      transaction.setStoredMarks([]);
      editor.view.dispatch(transaction);
      return editor.state.doc !== captured.doc;
    } finally { isolate(); applying = false; close(); }
  };
  const prepareExternal = (): boolean => {
    if (!current() || !target) { hide(); return false; }
    const captured = target;
    applying = true;
    try {
      const transaction = editor.state.tr;
      if (captured.below) {
        const paragraph = editor.schema.nodes["paragraph"]?.create();
        if (!paragraph) return false;
        transaction.insert(captured.from, paragraph);
        transaction.setSelection(TextSelection.create(transaction.doc, captured.from + 1));
      } else {
        transaction.delete(captured.from, captured.to);
        transaction.setSelection(TextSelection.create(transaction.doc, captured.from));
      }
      editor.view.dispatch(transaction);
      hide();
      return true;
    } finally { applying = false; }
  };
  const showForm = (kind: NonNullable<Entry["form"]>): void => {
    manual = true;
    form.replaceChildren(); list.hidden = true; search.hidden = true; form.hidden = false;
    const field = (label: string, type = "text", value = ""): HTMLInputElement => {
      const wrapper = document.createElement("label"); wrapper.textContent = label;
      const input = document.createElement("input"); input.type = type; input.value = value; input.setAttribute("aria-label", label);
      wrapper.append(input); form.append(wrapper); return input;
    };
    const value = field(kind === "web" ? "URL" : kind === "date" ? "Date" : kind === "code" ? "Language" : "Equation", kind === "date" ? "date" : kind === "web" ? "url" : "text", kind === "date" ? todayDate() : "");
    value.required = kind !== "code";
    const label = kind === "web" ? field("Link label") : undefined;
    const apply = document.createElement("button"); apply.type = "submit"; apply.textContent = "Insert"; form.append(apply);
    submit = (): void => {
      if (!current()) { close(); return; }
      const text = value.value.trim();
      if (kind === "web") {
        let url: URL;
        try { url = new URL(text); } catch { message.textContent = "Enter a complete http or https URL."; return; }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) { message.textContent = "Use an http or https URL without credentials."; return; }
        insert({ type: "text", text: label?.value.trim() || text, marks: [{ type: "link", attrs: { href: text, title: null } }] });
      } else if (kind === "date") {
        const date = parseNaturalDate(text);
        if (date === null) { message.textContent = "Choose a valid date."; return; }
        insert({ type: "text", text: date.value });
      } else if (kind === "code") {
        if (!/^[a-zA-Z0-9_+#.-]*$/.test(text)) { message.textContent = "Use a single language name, such as typescript."; return; }
        insert({ type: "code_block", attrs: { lang: text || null } });
      } else if (text !== "") {
        if (kind === "inline" && /[$\r\n]/u.test(text)) { message.textContent = "Enter the equation without dollar delimiters or line breaks."; return; }
        insert(kind === "inline" ? { type: "inline_math", attrs: { value: text } } : { type: "math_block", content: [{ type: "text", text }] });
      }
    };
    value.focus(); position(); options.onDraftStateChange?.();
  };
  const choose = (entry: Entry): void => {
    if (!current()) { hide(); return; }
    if (entry.form) { showForm(entry.form); return; }
    if (entry.content) { insert(entry.content); return; }
    if (!prepareExternal()) return;
    if (entry.action === "image") options.image?.();
    if (entry.action === "emoji") options.emoji();
    if (entry.action === "note") editor.chain().focus().insertContent("[[").run();
    if (entry.action === "table") insertBlock(editor, "table");
    if (entry.action === "template") openTemplatePalette();
  };
  const render = (): void => {
    list.replaceChildren(); message.textContent = "";
    const filter = search.value.trim().toLowerCase();
    let group = ""; let count = 0;
    const add = (label: string, icon: string, hint: string | undefined, action: () => void, disabled = false): void => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("aria-label", label);
      button.setAttribute("role", "menuitem"); button.dataset["icon"] = icon;
      if (hint) button.dataset["hint"] = hint;
      button.disabled = disabled; button.addEventListener("click", action); list.append(button); count++;
    };
    if (conversion) {
      const token = conversion;
      for (const choice of blockFormatState(editor, token, allowed).choices) {
        if (!choice.label.toLowerCase().includes(filter)) continue;
        add(choice.label, "T", undefined, () => {
          if (!conversionAllowed()) { status.textContent = "Conversion unavailable. This note must be edited in only one editor."; close(); return; }
          applying = true;
          try { applyBlockFormat(editor, token, choice.format, conversionAllowed); } finally { applying = false; close(); }
        }, !choice.enabled || !conversionAllowed());
      }
      const refusal = options.gate?.refusal();
      message.textContent = refusal ? singleEditorMessages[refusal] : "Single-editor conversions only. Do not edit this note elsewhere, including offline.";
    } else for (const entry of entries) {
      if (entry.action === "image" && options.image === undefined) continue;
      if (![entry.label, ...(entry.aliases?.split(" ") ?? [])].some(value => value.toLowerCase().includes(filter))) continue;
      if (group !== entry.group) {
        group = entry.group; const heading = document.createElement("p"); heading.className = "block-catalog-category"; heading.textContent = group; list.append(heading);
      }
      add(entry.label, entry.icon, entry.hint, () => choose(entry));
    }
    if (count === 0) message.textContent = "No matching blocks.";
    if (!manual && count === 0) menu.hidden = true;
    position();
  };
  const reset = (): void => { search.value = ""; search.hidden = false; list.hidden = false; form.hidden = true; submit = undefined; conversion = undefined; };
  const show = (rootStart?: number, turnInto = false): void => {
    if (!allowed()) return;
    reset(); manual = true;
    const selection = editor.state.selection;
    if (rootStart === undefined) {
      const title = editor.state.doc.firstChild;
      if (!turnInto && title?.type.name === "heading" && title.attrs["level"] === 1 && selection.to < title.nodeSize) {
        target = { doc: editor.state.doc, from: title.nodeSize, to: title.nodeSize, below: true, slash: false };
      } else target = { doc: editor.state.doc, from: selection.to, to: selection.to, below: false, slash: false };
    }
    else {
      const node = editor.state.doc.nodeAt(rootStart);
      if (!node) return;
      target = { doc: editor.state.doc, from: rootStart + node.nodeSize, to: rootStart + node.nodeSize, below: true, slash: false };
    }
    if (turnInto) {
      const selected = rootStart === undefined ? selection : TextSelection.near(editor.state.doc.resolve(rootStart + 1));
      conversion = captureBlockSelection(editor, allowed, selected);
      if (!conversion) { status.textContent = "Select a text block to convert. Container unwrapping is not supported yet."; hide(); return; }
    }
    menu.hidden = false; render(); search.focus(); position();
  };
  const sync = (): void => {
    if (applying) return;
    if (!allowed()) { hide(); return; }
    if (manual) { if (!current()) hide(); return; }
    const { $from, empty } = editor.state.selection;
    const text = beforeCaret();
    if (dismissedDoc !== editor.state.doc) { dismissed = undefined; dismissedDoc = undefined; }
    const match = /(?:^|\s)\/([^\s]*)$/.exec(text);
    if (!empty || $from.parent.type.spec.code || $from.parent.type.name === "math_block" || $from.marks().some(mark => mark.type.spec.code)
      || ($from.parent === editor.state.doc.firstChild && $from.parent.type.name === "heading" && $from.parent.attrs["level"] === 1)
      || !match || dismissed === text) { menu.hidden = true; return; }
    const typed = match[1] ?? "";
    if (!menu.hidden && target?.doc === editor.state.doc && target.to === $from.pos && search.value === typed) { position(); return; }
    reset();
    target = { doc: editor.state.doc, from: $from.pos - typed.length - 1, to: $from.pos, below: false, slash: true };
    search.value = typed; menu.hidden = false; render();
  };
  const key = (event: KeyboardEvent): void => {
    if (menu.hidden) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.target instanceof Node && form.contains(event.target)) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key) || buttons.length === 0) return;
    if (event.target === editor.view.dom && !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Enter") { (buttons[index] ?? buttons[0])?.click(); return; }
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const onSubmit = (event: SubmitEvent): void => { event.preventDefault(); submit?.(); };
  const outside = (event: PointerEvent): void => { if (event.target instanceof Node && !menu.contains(event.target) && event.target !== host) hide(); };
  const onInput = (): void => render();
  const changed = (): void => { if (!applying && target && target.doc !== editor.state.doc) { if (manual) hide(); else sync(); } };
  const viewportChanged = (): void => { if (!menu.hidden) position(); };
  search.addEventListener("input", onInput); form.addEventListener("submit", onSubmit); closeButton.addEventListener("click", close);
  menu.addEventListener("keydown", key); editor.view.dom.addEventListener("keydown", key, true);
  document.addEventListener("pointerdown", outside); window.addEventListener("resize", viewportChanged); document.addEventListener("scroll", viewportChanged, true);
  window.visualViewport?.addEventListener("resize", viewportChanged); window.visualViewport?.addEventListener("scroll", viewportChanged);
  editor.on("transaction", changed);
  const unsubscribe = options.gate?.subscribe(() => { if (conversion && !menu.hidden) render(); });
  return { query, sync, show, hide, hasOpenDraft: (): boolean => !menu.hidden && !form.hidden, destroy: (): void => {
    if (destroyed) return;
    hide(); destroyed = true; unsubscribe?.(); editor.off("transaction", changed);
    search.removeEventListener("input", onInput); form.removeEventListener("submit", onSubmit); closeButton.removeEventListener("click", close); menu.removeEventListener("keydown", key);
    editor.view.dom.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", viewportChanged); document.removeEventListener("scroll", viewportChanged, true);
    window.visualViewport?.removeEventListener("resize", viewportChanged); window.visualViewport?.removeEventListener("scroll", viewportChanged); menu.remove();
  } };
}
