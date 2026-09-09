import type { Editor } from "@tiptap/core";
import { emojiCatalog } from "../emoji-catalog.js";

/** One item shown by the emoji picker. */
export interface EmojiChoice {
  readonly shortcode: string;
  readonly glyph: string;
  readonly category: string;
  readonly custom: boolean;
  readonly aliases?: readonly string[];
  readonly imageUrl?: string;
  readonly supportsSkinTone?: boolean;
}

const SKIN_TONES = [
  { shortcode: "skin-tone-2", glyph: "🏻" },
  { shortcode: "skin-tone-3", glyph: "🏼" },
  { shortcode: "skin-tone-4", glyph: "🏽" },
  { shortcode: "skin-tone-5", glyph: "🏾" },
  { shortcode: "skin-tone-6", glyph: "🏿" },
] as const;
const PAGE_SIZE = 120;

/** Loads base emoji offline and best-effort custom entries from the authorized vault route. */
export async function loadEmojiChoices(vault?: string): Promise<readonly EmojiChoice[]> {
  const base = await emojiCatalog()
    .then((entries) => entries.map((entry) => ({ ...entry, custom: false })))
    .catch(() => []);
  if (vault === undefined || typeof fetch !== "function") return base;
  try {
    const response = await fetch(`/api/v1/vaults/${encodeURIComponent(vault)}/emoji`, { credentials: "same-origin" });
    if (!response.ok) return base;
    const body: unknown = await response.json();
    return mergeEmojiChoices(base, body, vault);
  } catch {
    return base;
  }
}

/** Merges a server response without trusting its shape or allowing it to replace base emoji. */
export function mergeEmojiChoices(
  base: readonly EmojiChoice[],
  body: unknown,
  vault = "",
): readonly EmojiChoice[] {
  if (!Array.isArray(body)) return base;
  const custom = body.flatMap((value): EmojiChoice[] => {
    if (!isRecord(value)
      || typeof value["shortcode"] !== "string"
      || typeof value["pack"] !== "string"
      || typeof value["file"] !== "string"
      || !Array.isArray(value["aliases"])
      || !value["aliases"].every((alias) => typeof alias === "string")) return [];
    const asset = [value["pack"], value["file"]].map(encodeURIComponent).join("/");
    return [{
      shortcode: value["shortcode"],
      glyph: "",
      category: value["pack"],
      custom: true,
      aliases: value["aliases"],
      imageUrl: `/api/v1/vaults/${encodeURIComponent(vault)}/emoji/${asset}`,
    }];
  });
  return [...custom, ...base];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Mounts a searchable, keyboard-accessible emoji picker beside an editor toolbar. */
export function mountEmojiPicker(editor: Editor, toolbar: HTMLElement, choices: readonly EmojiChoice[]): { destroy(): void } {
  const wrapper = document.createElement("div");
  wrapper.className = "emoji-picker-wrap";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "emoji-picker-toggle";
  toggle.textContent = "Emoji";
  toggle.setAttribute("aria-label", "Insert emoji");
  toggle.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "emoji-picker";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Emoji picker");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search emoji";
  search.setAttribute("aria-label", "Search emoji");
  const categories = document.createElement("div");
  categories.className = "emoji-picker-categories";
  categories.setAttribute("role", "group");
  categories.setAttribute("aria-label", "Emoji categories");
  const customChoices = choices.filter((choice) => choice.custom);
  const categoryNames = ["custom", ...new Set(choices.filter((choice) => !choice.custom).map((choice) => choice.category))];
  let selectedCategory = "all";
  let selectedTone = "";
  let visibleLimit = PAGE_SIZE;
  for (const category of ["all", ...categoryNames]) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "emoji-picker-category";
    tab.textContent = category === "all" ? "All" : category === "custom" ? "Custom" : category;
    tab.setAttribute("aria-label", `Show ${category} emoji`);
    tab.addEventListener("click", () => {
      selectedCategory = category;
      visibleLimit = PAGE_SIZE;
      for (const sibling of categories.querySelectorAll<HTMLButtonElement>("button")) {
        sibling.setAttribute("aria-pressed", String(sibling === tab));
      }
      render();
    });
    tab.setAttribute("aria-pressed", String(category === selectedCategory));
    categories.append(tab);
  }
  const tone = document.createElement("div");
  tone.className = "emoji-picker-tones";
  tone.setAttribute("role", "group");
  tone.setAttribute("aria-label", "Skin tone");
  for (const option of [{ shortcode: "default", glyph: "●" }, ...SKIN_TONES]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-picker-tone";
    button.textContent = option.glyph;
    button.setAttribute("aria-label", option.shortcode === "default" ? "Default skin tone" : option.shortcode);
    button.setAttribute("aria-pressed", String(option.shortcode === "default" ? selectedTone === "" : selectedTone === option.glyph));
    button.addEventListener("click", () => {
      selectedTone = option.shortcode === "default" ? "" : option.glyph;
      for (const sibling of tone.querySelectorAll<HTMLButtonElement>("button")) {
        sibling.setAttribute("aria-pressed", String(sibling === button));
      }
      render();
    });
    tone.append(button);
  }
  const grid = document.createElement("div");
  grid.className = "emoji-picker-grid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", "Emoji results");
  panel.append(search, categories, tone, grid);
  wrapper.append(toggle, panel);
  toolbar.append(wrapper);

  const render = (): void => {
    const query = search.value.trim().toLowerCase();
    grid.replaceChildren();
    const matches = choices
      .filter((choice) => selectedCategory === "all"
        || (choice.custom ? selectedCategory === "custom" : selectedCategory === choice.category))
      .filter((choice) => query.length === 0 || choice.shortcode.includes(query) || choice.aliases?.some((alias) => alias.includes(query)) === true || choice.glyph.includes(query) || choice.category.includes(query));
    matches
      .slice(0, visibleLimit)
      .forEach((choice) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "emoji-picker-item";
        item.setAttribute("aria-label", `:${choice.shortcode}:`);
        item.title = `:${choice.shortcode}:`;
        if (choice.custom && choice.imageUrl !== undefined) {
          const image = document.createElement("img");
          image.src = choice.imageUrl;
          image.alt = `:${choice.shortcode}:`;
          image.loading = "lazy";
          item.append(image);
        } else {
          item.textContent = choice.custom
            ? `:${choice.shortcode}:`
            : `${choice.glyph}${choice.supportsSkinTone === true ? selectedTone : ""}`;
        }
        item.addEventListener("click", () => {
          editor.chain().focus().insertContent(
            choice.custom ? `:${choice.shortcode}:` : `${choice.glyph}${choice.supportsSkinTone === true ? selectedTone : ""}`,
          ).run();
          close();
        });
        grid.append(item);
      });
    if (matches.length > visibleLimit) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "emoji-picker-more";
      more.textContent = `Show ${Math.min(PAGE_SIZE, matches.length - visibleLimit)} more`;
      more.addEventListener("click", () => {
        visibleLimit += PAGE_SIZE;
        render();
        grid.querySelector<HTMLButtonElement>(`.emoji-picker-item:nth-of-type(${visibleLimit - PAGE_SIZE + 1})`)?.focus();
      });
      grid.append(more);
    }
  };
  const close = (): void => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  const onToggle = (): void => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) {
      render();
      search.focus();
    }
  };
  const onSearch = (): void => {
    visibleLimit = PAGE_SIZE;
    render();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      close();
      toggle.focus();
    }
  };
  toggle.addEventListener("click", onToggle);
  search.addEventListener("input", onSearch);
  panel.addEventListener("keydown", onKeyDown);
  render();
  return {
    destroy: () => {
      toggle.removeEventListener("click", onToggle);
      search.removeEventListener("input", onSearch);
      panel.removeEventListener("keydown", onKeyDown);
      wrapper.remove();
    },
  };
}
