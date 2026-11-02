import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import type { EmojiEntry } from "../notes.js";
import { observeCustomEmoji } from "../custom-emoji.js";

import { emojiSuggestions } from "../emoji-suggestions.js";
export { emojiSuggestions } from "../emoji-suggestions.js";

const autocompleteKey = new PluginKey("memberberryEmojiAutocomplete");

/** Whether this editor's inline emoji menu currently owns suggestion keys. */
export function hasEmojiSuggestions(editor: Editor): boolean {
  const state = autocompleteKey.getState(editor.state) as AutocompleteState | undefined;
  return (state?.items.length ?? 0) > 0;
}

/** Adds an offline, keyboard-navigable `:` shortcode menu to a Tiptap editor. */
export function emojiAutocomplete(catalog: readonly EmojiEntry[], vault?: string): Extension {
  return Extension.create({
    name: "memberberryEmojiAutocomplete",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin({
        key: autocompleteKey,
        props: {
          handleKeyDown: (_view, event) => {
            const state = autocompleteKey.getState(_view.state) as AutocompleteState | undefined;
            if (state === undefined || state.items.length === 0) return false;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              state.move(event.key === "ArrowDown" ? 1 : -1);
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              state.choose(state.selected);
              return true;
            }
            if (event.key === "Escape") {
              state.close();
              return true;
            }
            return false;
          },
        },
        state: {
          init: () => createAutocompleteState(editor, catalog, vault),
          apply: (_transaction, previous) => previous,
        },
        view: (view) => {
          const state = autocompleteKey.getState(view.state) as AutocompleteState;
          state.view = view;
          state.refresh();
          return {
            update: () => state.refresh(),
            destroy: () => state.destroy(),
          };
        },
      })];
    },
  });
}

interface EmojiSuggestion extends EmojiEntry { readonly custom?: true; readonly imageUrl?: string }
interface AutocompleteState {
  readonly items: readonly EmojiSuggestion[];
  selected: number;
  view?: import("@tiptap/pm/view").EditorView;
  refresh(): void;
  move(delta: number): void;
  choose(index: number): void;
  close(): void;
  destroy(): void;
}

function createAutocompleteState(editor: Editor, base: readonly EmojiEntry[], vault?: string): AutocompleteState {
  let catalog: readonly EmojiSuggestion[] = base;
  let items: readonly EmojiSuggestion[] = [];
  let unsubscribe: (() => void) | undefined;
  let selected = 0;
  let popup: HTMLDivElement | undefined;
  let queryStart = 0;

  const state: AutocompleteState = {
    get items() { return items; },
    get selected() { return selected; },
    set selected(value: number) { selected = value; },
    refresh: () => {
      const view = state.view;
      if (view === undefined) {
        state.close();
        return;
      }
      const query = activeQuery(view);
      if (query === undefined) {
        state.close();
        return;
      }
      if (vault !== undefined && unsubscribe === undefined) unsubscribe = observeCustomEmoji(vault, (custom) => {
        catalog = [...custom, ...base];
        state.refresh();
      });
      queryStart = query.from;
      items = emojiSuggestions(catalog, query.text);
      selected = Math.min(selected, Math.max(0, items.length - 1));
      render(view);
    },
    move: (delta) => {
      if (items.length === 0) return;
      selected = (selected + delta + items.length) % items.length;
      render(state.view);
    },
    choose: (index) => {
      const entry = items[index];
      const view = state.view;
      if (entry === undefined || view === undefined) return;
      const content = entry.custom === true ? { type: "emoji", attrs: { shortcode: entry.shortcode } } : entry.glyph;
      editor.chain().focus().insertContentAt({ from: queryStart, to: view.state.selection.from }, content).run();
      state.close();
    },
    close: () => {
      items = [];
      popup?.remove();
      popup = undefined;
    },
    destroy: () => { unsubscribe?.(); state.close(); },
  };
  return state;

  function render(view: import("@tiptap/pm/view").EditorView | undefined): void {
    if (view === undefined || items.length === 0) {
      state.close();
      return;
    }
    popup ??= document.createElement("div");
    popup.className = "emoji-autocomplete";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("aria-label", "Emoji suggestions");
    popup.replaceChildren();
    items.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "emoji-autocomplete-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selected));
      button.textContent = `${entry.glyph} :${entry.shortcode}:`;
      if (entry.imageUrl !== undefined) {
        const image = document.createElement("img");
        image.src = entry.imageUrl; image.alt = `:${entry.shortcode}:`; image.className = "custom-emoji-image";
        image.onerror = () => { button.textContent = `:${entry.shortcode}:`; };
        button.prepend(image);
      }
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => state.choose(index));
      popup?.append(button);
    });
    if (popup.parentElement === null) document.body.append(popup);
    try {
      const rect = view.coordsAtPos(view.state.selection.from);
      const size = popup.getBoundingClientRect();
      const ownerWindow = view.dom.ownerDocument.defaultView;
      const viewport = ownerWindow?.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? ownerWindow?.innerWidth ?? size.width;
      const height = viewport?.height ?? ownerWindow?.innerHeight ?? size.height;
      const menuHeight = Math.min(size.height, height);
      // why: caret coordinates near a phone's edge must not push options outside the viewport.
      const below = rect.bottom + 4;
      const y = below + menuHeight <= top + height ? below : rect.top - menuHeight - 4;
      popup.style.maxHeight = `${height}px`;
      popup.style.left = `${Math.max(left, Math.min(rect.left, left + width - size.width))}px`;
      popup.style.top = `${Math.max(top, Math.min(y, top + height - menuHeight))}px`;
    } catch {
      popup.style.left = "0px";
      popup.style.top = "0px";
    }
  }
}

function activeQuery(view: import("@tiptap/pm/view").EditorView): { from: number; text: string } | undefined {
  const { $from, empty } = view.state.selection;
  if (!empty || !$from.parent.isTextblock) return undefined;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const match = /(^|\s):([a-z0-9_+\-]*)$/i.exec(before);
  if (match === null || (match[2]?.length ?? 0) < 1) return undefined;
  return { from: $from.pos - (match[2]?.length ?? 0) - 1, text: match[2] ?? "" };
}
