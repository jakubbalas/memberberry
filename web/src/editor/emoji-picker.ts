import type { Editor } from "@tiptap/core";
import { emojiCatalog } from "../emoji-catalog.js";
import { emojiPackUploadBody, normalizeShortcode, planEmojiImport, planSlackEmojiImport, readEmojiImport, type EmojiImportAsset } from "./emoji-import.js";

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

export interface EmojiImportOptions {
  readonly vault: string;
  readonly status?: HTMLElement;
}

/** Picker entries supplied immediately or loaded on first open with cancellation. */
export type EmojiChoices = readonly EmojiChoice[] | ((signal: AbortSignal) => Promise<readonly EmojiChoice[]>);

const SKIN_TONES = [
  { shortcode: "skin-tone-2", glyph: "🏻" },
  { shortcode: "skin-tone-3", glyph: "🏼" },
  { shortcode: "skin-tone-4", glyph: "🏽" },
  { shortcode: "skin-tone-5", glyph: "🏾" },
  { shortcode: "skin-tone-6", glyph: "🏿" },
] as const;
const PAGE_SIZE = 120;
const RECENTS_KEY = "memberberry.emoji.recents";
const MAX_RECENTS = 24;

/** Loads base emoji offline and best-effort custom entries from the authorized vault route. */
export async function loadEmojiChoices(vault?: string, signal?: AbortSignal): Promise<readonly EmojiChoice[]> {
  const base = await emojiCatalog()
    .then((entries) => entries.map((entry) => ({ ...entry, custom: false })))
    .catch(() => []);
  if (vault === undefined || typeof fetch !== "function" || signal?.aborted) return base;
  try {
    const response = await fetch(`/api/v1/vaults/${encodeURIComponent(vault)}/emoji`, {
      credentials: "same-origin",
      ...(signal === undefined ? {} : { signal }),
    });
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
export function mountEmojiPicker(
  editor: Editor,
  toolbar: HTMLElement,
  choices: EmojiChoices,
  importOptions?: EmojiImportOptions,
): { destroy(): void } {
  let availableChoices = typeof choices === "function" ? [] : [...choices];
  let loaded = typeof choices !== "function";
  let destroyed = false;
  let loading: AbortController | undefined;
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
  panel.setAttribute("aria-modal", "false");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search emoji";
  search.setAttribute("aria-label", "Search emoji");
  const categories = document.createElement("div");
  categories.className = "emoji-picker-categories";
  categories.setAttribute("role", "group");
  categories.setAttribute("aria-label", "Emoji categories");
  let selectedCategory = "all";
  let selectedTone = "";
  let visibleLimit = PAGE_SIZE;
  let recentShortcodes = readRecents();
  const renderCategories = (): void => {
    categories.replaceChildren();
    const categoryNames = ["custom", "recent", ...new Set(availableChoices.filter((choice) => !choice.custom).map((choice) => choice.category))];
    for (const category of ["all", ...categoryNames]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "emoji-picker-category";
      tab.textContent = category === "all" ? "All" : category === "custom" ? "Custom" : category === "recent" ? "Recent" : category;
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
  };
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
    const matches = availableChoices
      .filter((choice) => selectedCategory === "all"
        || (selectedCategory === "recent"
          ? recentShortcodes.includes(choice.shortcode)
          : choice.custom ? selectedCategory === "custom" : selectedCategory === choice.category))
      .map((choice, index) => ({ choice, index, score: query.length === 0 ? 0 : bestEmojiMatch(choice, query) }))
      .filter(({ score }) => query.length === 0 || score !== undefined)
      .sort((left, right) => {
        if (selectedCategory === "recent" && left.choice.shortcode !== right.choice.shortcode) {
          return recentShortcodes.indexOf(left.choice.shortcode) - recentShortcodes.indexOf(right.choice.shortcode);
        }
        return left.score === right.score ? left.index - right.index : (right.score ?? 0) - (left.score ?? 0);
      })
      .map(({ choice }) => choice);
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
          recentShortcodes = [choice.shortcode, ...recentShortcodes.filter((shortcode) => shortcode !== choice.shortcode)].slice(0, MAX_RECENTS);
          writeRecents(recentShortcodes);
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
  const importer = importOptions === undefined ? undefined : mountEmojiImporter(importOptions, () => availableChoices, (added) => {
    availableChoices = [...added, ...availableChoices];
    render();
  }, (pack) => {
    availableChoices = availableChoices.filter((choice) => choice.category !== pack);
    render();
  });
  if (importer !== undefined) panel.append(importer.element);
  const loadStatus = document.createElement("p");
  loadStatus.setAttribute("role", "status");
  loadStatus.hidden = true;
  panel.append(loadStatus);
  const ensureChoices = (): void => {
    if (typeof choices !== "function" || loaded || loading !== undefined || destroyed) return;
    loading = new AbortController();
    panel.setAttribute("aria-busy", "true");
    loadStatus.textContent = "Loading emoji…";
    loadStatus.hidden = false;
    if (importer !== undefined) importer.element.inert = true;
    void choices(loading.signal).then((entries) => {
      if (destroyed) return;
      availableChoices = [...entries];
      loaded = true;
      loadStatus.hidden = true;
      renderCategories();
      render();
    }).catch(() => {
      if (!destroyed) loadStatus.textContent = "Could not load emoji. Close and reopen the picker to try again.";
    }).finally(() => {
      loading = undefined;
      if (destroyed) return;
      panel.removeAttribute("aria-busy");
      if (importer !== undefined) importer.element.inert = false;
    });
  };
  const close = (): void => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  const onToggle = (): void => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) {
      ensureChoices();
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
  renderCategories();
  render();
  return {
    destroy: () => {
      destroyed = true;
      loading?.abort();
      toggle.removeEventListener("click", onToggle);
      search.removeEventListener("input", onSearch);
      panel.removeEventListener("keydown", onKeyDown);
      importer?.destroy();
      wrapper.remove();
    },
  };
}

function mountEmojiImporter(
  options: EmojiImportOptions,
  getChoices: () => readonly EmojiChoice[],
  onImported: (choices: readonly EmojiChoice[]) => void,
  onDeleted: (pack: string) => void,
): { element: HTMLElement; destroy(): void } {
  const controls = document.createElement("div");
  controls.className = "emoji-import-controls";
  const button = importButton("Import custom emoji", "Import custom emoji from a folder or ZIP file");
  const slackButton = importButton("Import Slack export", "Import a local Slack emoji export");
  const manageButton = importButton("Manage custom packs", "Manage vault custom emoji packs");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,image/gif,image/jpeg,image/png,image/webp";
  input.multiple = true;
  input.setAttribute("webkitdirectory", "");
  input.hidden = true;
  const management = document.createElement("div");
  management.className = "emoji-pack-management";
  management.hidden = true;
  controls.append(button, slackButton, manageButton, input, management);
  const setStatus = (message: string): void => {
    if (options.status !== undefined) options.status.textContent = message;
  };
  let mode: "folder" | "slack" = "folder";
  const onButton = (): void => { mode = "folder"; input.click(); };
  const onSlackButton = (): void => { mode = "slack"; input.click(); };
  const onManageButton = (): void => {
    management.hidden = !management.hidden;
    if (!management.hidden) void loadManagedPacks();
  };
  const onChange = (): void => {
    const files = input.files === null ? [] : [...input.files];
    input.value = "";
    if (files.length === 0) return;
    void importEmojiFiles(files, mode);
  };
  const loadManagedPacks = async (): Promise<void> => {
    management.replaceChildren();
    try {
      const response = await fetch(`/api/v1/vaults/${encodeURIComponent(options.vault)}/emoji/packs`, { credentials: "same-origin" });
      if (!response.ok) {
        setStatus("Custom pack management is available to vault owners.");
        return;
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) return;
      for (const value of body) {
        if (!isPackSummary(value)) continue;
        const row = document.createElement("div");
        row.className = "emoji-pack-row";
        const label = document.createElement("span");
        label.textContent = `${value.name} (${value.emoji_count})`;
        const remove = importButton("Delete", `Delete ${value.name} emoji pack`);
        remove.addEventListener("click", () => void deleteManagedPack(value.name, row));
        row.append(label, remove);
        management.append(row);
      }
      if (management.childElementCount === 0) management.textContent = "No vault-local packs.";
    } catch {
      setStatus("Custom pack management is unavailable.");
    }
  };
  const deleteManagedPack = async (pack: string, row: HTMLElement): Promise<void> => {
    if (!window.confirm(`Delete the ${pack} emoji pack?`)) return;
    try {
      const response = await fetch(`/api/v1/vaults/${encodeURIComponent(options.vault)}/emoji/packs/${encodeURIComponent(pack)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        setStatus("The emoji pack could not be deleted.");
        return;
      }
    } catch {
      setStatus("The emoji pack could not be deleted.");
      return;
    }
    row.remove();
    onDeleted(pack);
    setStatus(`Deleted ${pack} emoji pack.`);
  };
  const importEmojiFiles = async (files: readonly File[], importMode: "folder" | "slack"): Promise<void> => {
    try {
      const sources = await readEmojiImport(files);
      const existing = new Set(getChoices().flatMap((choice) => [choice.shortcode, ...(choice.aliases ?? [])]));
      const plan = importMode === "slack" ? planSlackEmojiImport(sources, existing) : planEmojiImport(sources, existing);
      if (plan.assets.length === 0) {
        setStatus("No supported, non-empty emoji images found.");
        return;
      }
      const requestedPackName = window.prompt("Pack name", importMode === "slack" ? "slack-emoji" : "custom-emoji");
      const packName = requestedPackName === null ? undefined : normalizeShortcode(requestedPackName);
      if (packName === undefined) {
        setStatus("Import cancelled: use a simple pack name.");
        return;
      }
      const resolved = resolveCollisions(plan.assets, existing);
      if (resolved === undefined) return;
      const response = await fetch(`/api/v1/vaults/${encodeURIComponent(options.vault)}/emoji/packs/${encodeURIComponent(packName)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: emojiPackUploadBody(packName, { ...plan, assets: resolved }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? "That pack already exists." : "Emoji pack upload failed.");
      const packChoices = resolved.map((asset): EmojiChoice => ({
        shortcode: asset.shortcode,
        glyph: "",
        category: packName,
        custom: true,
        aliases: asset.aliases,
        imageUrl: `/api/v1/vaults/${encodeURIComponent(options.vault)}/emoji/${encodeURIComponent(packName)}/${encodeURIComponent(asset.file)}`,
      }));
      onImported(packChoices);
      setStatus(`Imported ${packChoices.length} custom emoji.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Emoji import failed.");
    }
  };
  button.addEventListener("click", onButton);
  slackButton.addEventListener("click", onSlackButton);
  manageButton.addEventListener("click", onManageButton);
  input.addEventListener("change", onChange);
  return {
    element: controls,
    destroy: () => {
      button.removeEventListener("click", onButton);
      slackButton.removeEventListener("click", onSlackButton);
      manageButton.removeEventListener("click", onManageButton);
      input.removeEventListener("change", onChange);
    },
  };
}

function isPackSummary(value: unknown): value is { readonly name: string; readonly emoji_count: number } {
  return typeof value === "object" && value !== null
    && "name" in value && typeof value.name === "string"
    && "emoji_count" in value && typeof value.emoji_count === "number"
    && Number.isInteger(value.emoji_count) && value.emoji_count >= 0;
}

function importButton(text: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-picker-more";
  button.textContent = text;
  button.setAttribute("aria-label", label);
  return button;
}

function resolveCollisions(assets: readonly EmojiImportAsset[], existing: ReadonlySet<string>): EmojiImportAsset[] | undefined {
  const used = new Set(existing);
  const resolved: EmojiImportAsset[] = [];
  for (const asset of assets) {
    const shortcode = resolveName(asset.shortcode, used);
    if (shortcode === undefined) return undefined;
    used.add(shortcode);
    const aliases: string[] = [];
    for (const alias of asset.aliases) {
      const resolvedAlias = resolveName(alias, used);
      if (resolvedAlias === undefined) return undefined;
      used.add(resolvedAlias);
      aliases.push(resolvedAlias);
    }
    const extension = asset.file.split(".").pop() ?? "png";
    resolved.push({ ...asset, shortcode, file: `${shortcode}.${extension}`, aliases });
  }
  return resolved;
}

function resolveName(name: string, used: ReadonlySet<string>): string | undefined {
  if (!used.has(name)) return name;
  const replacement = window.prompt(`Shortcode :${name}: already exists. Enter a replacement shortcode, or Cancel.`);
  if (replacement === null) return undefined;
  const normalized = normalizeShortcode(replacement);
  if (normalized === undefined || used.has(normalized)) {
    window.alert("Use a unique shortcode with letters, numbers, underscores, plus signs, or hyphens.");
    return undefined;
  }
  return normalized;
}

function bestEmojiMatch(choice: EmojiChoice, query: string): number | undefined {
  const candidates = [choice.shortcode, ...(choice.aliases ?? []), choice.category, choice.glyph];
  return candidates.reduce<number | undefined>((best, candidate) => {
    const score = fuzzyScore(candidate.toLowerCase(), query);
    return score === undefined ? best : best === undefined ? score : Math.max(best, score);
  }, undefined);
}

function fuzzyScore(candidate: string, query: string): number | undefined {
  let queryIndex = 0;
  let score = 0;
  let previousIndex = -1;
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue;
    score += previousIndex + 1 === index ? 3 : 1;
    previousIndex = index;
    queryIndex += 1;
  }
  return queryIndex === query.length ? score + (candidate.length - query.length === 0 ? 2 : 0) : undefined;
}

function readRecents(): string[] {
  try {
    const stored = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = stored === null ? [] : JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed.slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function writeRecents(recents: readonly string[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // why: private browsing and blocked storage should not disable emoji insertion.
  }
}
