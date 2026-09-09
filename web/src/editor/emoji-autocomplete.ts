import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

import type { EmojiEntry } from "../notes.js";

const autocompleteKey = new PluginKey("memberberryEmojiAutocomplete");
const MAX_SUGGESTIONS = 8;

/** Returns the Unicode entries matching an inline colon query, ordered by fuzzy relevance. */
export function emojiSuggestions(catalog: readonly EmojiEntry[], query: string): readonly EmojiEntry[] {
  const normalized = query.toLowerCase();
  return catalog
    .map((entry, index) => ({ entry, index, score: emojiScore(entry, normalized) }))
    .filter(({ score }) => score !== undefined)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.index - right.index)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ entry }) => entry);
}

/** Adds an offline, keyboard-navigable `:` shortcode menu to a Tiptap editor. */
export function emojiAutocomplete(catalog: readonly EmojiEntry[]): Extension {
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
          init: () => createAutocompleteState(editor, catalog),
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

interface AutocompleteState {
  readonly items: readonly EmojiEntry[];
  selected: number;
  view?: import("@tiptap/pm/view").EditorView;
  refresh(): void;
  move(delta: number): void;
  choose(index: number): void;
  close(): void;
  destroy(): void;
}

function createAutocompleteState(editor: Editor, catalog: readonly EmojiEntry[]): AutocompleteState {
  let items: readonly EmojiEntry[] = [];
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
      editor.chain().focus().insertContentAt({ from: queryStart, to: view.state.selection.from }, entry.glyph).run();
      state.close();
    },
    close: () => {
      items = [];
      popup?.remove();
      popup = undefined;
    },
    destroy: () => state.close(),
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
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => state.choose(index));
      popup?.append(button);
    });
    if (popup.parentElement === null) document.body.append(popup);
    try {
      const rect = view.coordsAtPos(view.state.selection.from);
      popup.style.left = `${rect.left}px`;
      popup.style.top = `${rect.bottom + 4}px`;
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
  if (match === null || (match[2]?.length ?? 0) < 2) return undefined;
  return { from: $from.pos - (match[2]?.length ?? 0) - 1, text: match[2] ?? "" };
}

function emojiScore(entry: EmojiEntry, query: string): number | undefined {
  return [entry.shortcode, ...entry.aliases].reduce<number | undefined>((best, name) => {
    const score = subsequenceScore(name, query);
    return score === undefined ? best : best === undefined ? score : Math.max(best, score);
  }, undefined);
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let queryIndex = 0;
  let score = 0;
  let previous = -2;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    score += previous + 1 === index ? 3 : 1;
    previous = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? score : undefined;
}
