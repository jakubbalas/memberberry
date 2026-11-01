<!--
  Asking for a name — to rename something (`SPEC.md` §6.6) or to create a note (§6.10).

  A `<dialog>`, for the reasons `Palette.svelte` gives: focus trapping, Escape and an inert
  page behind it belong to the browser rather than to us.

  Two things are worth knowing about what it says. **The rename warning is not decoration** —
  a rename rewrites notes the person doing it may not be able to read, and telling them so
  before they commit is the only place that fact is ever visible, because §6.9 gives the
  audit log no UI. It is a prop rather than fixed text precisely so that creating a note does
  not inherit it: creation touches one file and nobody else's, and a warning that said
  otherwise would be a lie about what the button does. And **the rename result line is
  phrased as "notes you can see"**, because that is precisely what the server counted (§6.5).
-->
<script lang="ts">
  import { tick } from "svelte";
  import { emojiCatalog } from "../emoji-catalog.js";
  import { emojiSuggestions } from "../emoji-suggestions.js";
  import type { EmojiEntry } from "../notes.js";
  import { nameEmojiQuery } from "./name-emoji.js";

  interface Props {
    readonly open: boolean;
    /** "Rename note" or "Rename tag" — also the dialog's accessible name. */
    readonly title: string;
    /** What is being renamed, shown so nobody renames the wrong thing from a palette. */
    readonly subject: string;
    readonly label: string;
    /** Prefilled, and selected on open, so typing replaces it. */
    readonly initial: string;
    /** Set while the request is in flight; the form is disabled and says so. */
    readonly busy?: boolean | undefined;
    /** Note/folder names offer Unicode suggestions; tag prompts opt out. */
    readonly emoji?: boolean | undefined;
    /** A refusal from the server, or from the client's own check of the typed name. */
    readonly error?: string | undefined;
    /** Shown above the buttons when the action reaches further than the thing named. */
    readonly warning?: string | undefined;
    /** The confirm button's resting label, and the one it wears while busy. */
    readonly confirm?: string | undefined;
    readonly confirming?: string | undefined;
    readonly onsubmit: (name: string) => void;
    readonly ondismiss: () => void;
  }

  const {
    open,
    title,
    subject,
    label,
    initial,
    busy = false,
    emoji = true,
    error,
    warning,
    confirm = "Rename",
    confirming = "Renaming…",
    onsubmit,
    ondismiss,
  }: Props = $props();

  let dialog = $state<HTMLDialogElement | undefined>(undefined);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let name = $state("");
  const suggestionsId = $props.id();
  let catalog = $state<readonly EmojiEntry[]>([]);
  let query = $state<ReturnType<typeof nameEmojiQuery>>();
  let selected = $state(0);
  let loading = false;
  let disposed = false;
  const suggestions = $derived(open && emoji && !busy && query !== undefined
    ? emojiSuggestions(catalog, query.text) : []);

  $effect(() => () => { disposed = true; });
  $effect(() => { if (!open || busy) query = undefined; });

  function updateQuery(): void {
    query = !disposed && open && emoji && !busy && input != null && document.activeElement === input
      ? nameEmojiQuery(input.value, input.selectionStart, input.selectionEnd) : undefined;
    selected = 0;
    if (query === undefined || catalog.length > 0 || loading) return;
    loading = true;
    void emojiCatalog().then(entries => { if (!disposed) catalog = entries; }).catch(() => {
      // why: offline catalog failure must leave naming usable; a later query retries.
    }).finally(() => { loading = false; });
  }

  async function choose(index: number): Promise<void> {
    const entry = suggestions[index], range = query;
    if (entry === undefined || range === undefined || input == null || busy) return;
    name = `${name.slice(0, range.from)}${entry.glyph}${name.slice(range.to)}`;
    query = undefined;
    await tick();
    if (disposed || !open || input == null) return;
    input.focus();
    input.setSelectionRange(range.from + entry.glyph.length, range.from + entry.glyph.length);
  }

  function emojiKey(event: KeyboardEvent): void {
    if (event.isComposing || suggestions.length === 0) return;
    if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") query = undefined;
      else if (event.key === "Enter") void choose(selected);
      else selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
    } else if (event.key === "Tab") query = undefined;
  }

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) {
      name = initial;
      query = undefined;
      element.showModal();
      input?.focus();
      // Selected rather than merely focused: the commonest rename replaces the name outright,
      // and a caret at the end makes that a deletion first.
      input?.select();
    }
    if (!open && element.open) element.close();
  });

  function submit(event: Event): void {
    event.preventDefault();
    if (busy) return;
    onsubmit(name);
  }
</script>

<dialog
  class="rename-prompt"
  aria-label={title}
  bind:this={dialog}
  onclose={ondismiss}
  onclick={(event) => {
    if (event.target === dialog) ondismiss();
  }}
>
  <form class="rename-body" onsubmit={submit}>
    <h2 class="rename-title">{title}</h2>
    <p class="rename-subject">{subject}</p>

    <label class="rename-field">
      <span class="rename-label">{label}</span>
      <input
        class="rename-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        disabled={busy}
        aria-describedby={warning === undefined ? undefined : "rename-warning"}
        bind:this={input}
        bind:value={name}
        role={emoji ? "combobox" : undefined}
        aria-autocomplete={emoji ? "list" : undefined}
        aria-expanded={emoji ? suggestions.length > 0 : undefined}
        aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
        aria-activedescendant={suggestions.length > 0 ? `${suggestionsId}-${selected}` : undefined}
        oninput={updateQuery}
        onclick={updateQuery}
        onselect={updateQuery}
        onkeyup={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateQuery(); }}
        onkeydown={emojiKey}
        onblur={(event) => { if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest(`#${CSS.escape(suggestionsId)}`)) query = undefined; }}
      />
    </label>

    {#if suggestions.length > 0}
      <div class="name-emoji-suggestions" id={suggestionsId} role="listbox" aria-label="Emoji suggestions">
        {#each suggestions as entry, index (entry.shortcode)}
          <button type="button" class="emoji-autocomplete-item" id={`${suggestionsId}-${index}`} role="option" aria-selected={index === selected} tabindex="-1" onmousedown={(event) => event.preventDefault()} onclick={() => void choose(index)}>{entry.glyph} :{entry.shortcode}:</button>
        {/each}
      </div>
    {/if}

    {#if warning !== undefined}
      <p class="rename-warning" id="rename-warning">{warning}</p>
    {/if}

    {#if error !== undefined}
      <p class="rename-error" role="alert">{error}</p>
    {/if}

    <div class="rename-actions">
      <button type="button" class="rename-cancel" onclick={ondismiss} disabled={busy}>
        Cancel
      </button>
      <button type="submit" class="rename-confirm" disabled={busy}>
        {busy ? confirming : confirm}
      </button>
    </div>
  </form>
</dialog>
