<!--
  The mobile tab switcher, as a bottom sheet (`SPEC.md` §8.3).

  A real `<dialog>` opened with `showModal()`, not a styled `div`. That buys focus trapping,
  Escape-to-close, inertness of the page behind it and the right role announced to a screen
  reader — all of which would otherwise have to be reimplemented, and all of which are
  routinely reimplemented wrongly.

  It lists every open tab across every pane, not just the focused one. On mobile only one leaf
  renders (§8.3), so this sheet is the *only* way to reach a tab in another pane — a tab the
  user can neither see nor otherwise switch to.
-->
<script lang="ts">
  import type { Tab, TabId } from "./workspace.js";

  interface Props {
    readonly open: boolean;
    readonly tabs: readonly Tab[];
    readonly activeTab: TabId | undefined;
    readonly onactivate: (tab: TabId) => void;
    readonly onclose: (tab: TabId) => void;
    readonly ondismiss: () => void;
    readonly iconOf?: ((path: string) => string | null | undefined) | undefined;
  }

  const { open, tabs, activeTab, onactivate, onclose, ondismiss, iconOf }: Props = $props();

  let sheet = $state<HTMLDialogElement | undefined>(undefined);

  function label(tab: Tab): string {
    const name = tab.note.split("/").pop() ?? tab.note;
    return name.replace(/\.md$/, "");
  }

  /** The folder a note sits in, shown under its name so two `Index.md` are distinguishable. */
  function folder(tab: Tab): string | undefined {
    const parts = tab.note.split("/");
    return parts.length > 1 ? parts.slice(0, -1).join("/") : undefined;
  }

  $effect(() => {
    const element = sheet;
    if (element === undefined) return;
    // why: driven from a prop rather than from a click handler, so the sheet's open state has
    // exactly one source of truth. `showModal` on an already-open dialog throws.
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });
</script>

<dialog
  class="tab-sheet"
  aria-label="Open notes"
  bind:this={sheet}
  onclose={ondismiss}
  onclick={(event) => {
    // The backdrop is the dialog element itself, so a click that lands on it rather than on
    // the content is a click outside — the conventional way to dismiss a sheet.
    if (event.target === sheet) ondismiss();
  }}
>
  <div class="tab-sheet-body">
    <div class="tab-sheet-handle" aria-hidden="true"></div>
    <h2 class="tab-sheet-title">Open notes</h2>

    {#if tabs.length === 0}
      <p class="tab-sheet-empty">Nothing is open.</p>
    {:else}
      <ul class="tab-sheet-list">
        {#each tabs as tab (tab.id)}
          <li class="tab-sheet-item" data-current={tab.id === activeTab}>
            <button
              type="button"
              class="tab-sheet-open"
              aria-current={tab.id === activeTab ? "true" : undefined}
              onclick={() => onactivate(tab.id)}
            >
              {#if iconOf?.(tab.note)}
                <span class="tab-sheet-icon" aria-hidden="true">{iconOf(tab.note)}</span>
              {/if}
              <span class="tab-sheet-name">{label(tab)}</span>
              {#if folder(tab) !== undefined}
                <span class="tab-sheet-folder">{folder(tab)}</span>
              {/if}
            </button>
            <button
              type="button"
              class="tab-sheet-close"
              aria-label={`Close ${label(tab)}`}
              onclick={() => onclose(tab.id)}
            >
              ×
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <button type="button" class="tab-sheet-dismiss" onclick={ondismiss}>Done</button>
  </div>
</dialog>
