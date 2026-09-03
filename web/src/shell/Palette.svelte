<!--
  The command palette, quick switcher and vault switcher (`SPEC.md` §8.4).

  **One component, three uses.** They differ only in what fills the list and what happens on
  Enter, and three near-identical overlays is three places for the keyboard handling to be
  subtly wrong — which is the part users notice and the part nobody re-tests.

  A `<dialog>` again, for the reasons in `TabSheet.svelte`: focus trapping, Escape and an inert
  page behind it are the browser's rather than ours.

  The listbox is `aria-activedescendant`, not roving focus. Focus has to stay in the input —
  the user is still typing — so the *virtual* cursor moves through the options instead. This is
  the pattern combobox exists for, and it is why the input carries `aria-controls` and the
  options carry ids.
-->
<script lang="ts">
  import { type HighlightRun, highlight } from "./fuzzy.js";

  /** One row. `hint` is the trailing text — a folder path, or a formatted shortcut. */
  export interface PaletteItem {
    readonly id: string;
    readonly label: string;
    readonly hint?: string | undefined;
    readonly group?: string | undefined;
    /** Where the query matched `label`, for highlighting. */
    readonly positions?: readonly number[] | undefined;
    readonly disabled?: boolean | undefined;
  }

  interface Props {
    readonly open: boolean;
    readonly title: string;
    readonly placeholder: string;
    readonly query: string;
    readonly items: readonly PaletteItem[];
    readonly onquery: (query: string) => void;
    readonly onchoose: (id: string) => void;
    readonly ondismiss: () => void;
    /** Shown instead of the list when there is nothing to show. */
    readonly empty?: string | undefined;
  }

  const { open, title, placeholder, query, items, onquery, onchoose, ondismiss, empty }: Props =
    $props();

  let dialog = $state<HTMLDialogElement | undefined>(undefined);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let active = $state(0);

  const selectable = $derived(items.filter((item) => item.disabled !== true));
  const current = $derived(selectable[Math.min(active, Math.max(0, selectable.length - 1))]);

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) {
      element.showModal();
      // The whole point of a palette is that it is ready to type into.
      input?.focus();
    }
    if (!open && element.open) element.close();
  });

  $effect(() => {
    // Reset the cursor whenever the list changes underneath it: keeping index 3 after the
    // results narrow to two selects something the user never looked at.
    void items;
    active = 0;
  });

  function move(by: number): void {
    if (selectable.length === 0) return;
    // Wrapping, because a list you cannot cycle is a list you have to look at to use.
    active = (active + by + selectable.length) % selectable.length;
  }

  function onkeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        active = 0;
        break;
      case "End":
        event.preventDefault();
        active = Math.max(0, selectable.length - 1);
        break;
      case "Enter": {
        event.preventDefault();
        const chosen = current;
        if (chosen !== undefined) onchoose(chosen.id);
        break;
      }
      default:
        break;
    }
  }

  function runs(item: PaletteItem): readonly HighlightRun[] {
    return highlight(item.label, item.positions ?? []);
  }

  const optionId = (item: PaletteItem): string => `palette-option-${item.id}`;
</script>

<dialog
  class="palette"
  aria-label={title}
  bind:this={dialog}
  onclose={ondismiss}
  onclick={(event) => {
    if (event.target === dialog) ondismiss();
  }}
>
  <div class="palette-body">
    <input
      class="palette-input"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls="palette-list"
      aria-autocomplete="list"
      aria-activedescendant={current === undefined ? undefined : optionId(current)}
      aria-label={title}
      {placeholder}
      value={query}
      bind:this={input}
      oninput={(event) => onquery(event.currentTarget.value)}
      {onkeydown}
    />

    {#if items.length === 0}
      <p class="palette-empty">{empty ?? "Nothing matches."}</p>
    {:else}
      <ul class="palette-list" id="palette-list" role="listbox" aria-label={title}>
        {#each items as item (item.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
               whole list is the combobox above, which owns arrows and Enter. An option that
               took focus of its own would break `aria-activedescendant`, which requires focus
               to stay in the input. -->
          <li
            class="palette-option"
            id={optionId(item)}
            role="option"
            aria-selected={item.id === current?.id}
            aria-disabled={item.disabled === true ? "true" : undefined}
            data-active={item.id === current?.id}
            onclick={() => {
              if (item.disabled !== true) onchoose(item.id);
            }}
          >
            <span class="palette-label">
              {#each runs(item) as run, index (index)}
                {#if run.matched}<mark class="palette-match">{run.text}</mark>{:else}{run.text}{/if}
              {/each}
            </span>
            {#if item.hint !== undefined}
              <span class="palette-hint">{item.hint}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</dialog>
