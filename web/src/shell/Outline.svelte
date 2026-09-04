<!--
  The outline pane (`SPEC.md` §9.5).

  The headings of the note in the focused pane, live: they arrive from the editor as it is
  typed into, so there is nothing to fetch and nothing that can go stale. A row scrolls the
  note to its heading, the section the reader is inside is marked, and a row can be dragged —
  or moved with Alt and an arrow — to reorder the section, **which moves the underlying
  blocks**. That last part is the reason the work happens in the editor: it is a document
  edit, not a view.

  One tab stop with `aria-activedescendant`, as the note tree and the tag pane have. The drag
  and the keyboard are two implementations of one feature, because native drag-and-drop is
  not keyboard-operable at all (§8.2).
-->
<script lang="ts">
  import type { OutlineView } from "./outline.svelte.js";
  import { headingLabel, outlineKeyAction } from "./outline.js";

  interface Props {
    readonly view: OutlineView;
    /** The note in the focused pane, so an empty outline can say why it is empty. */
    readonly note?: string | undefined;
  }

  const { view, note }: Props = $props();

  let cursor = $state(0);
  /** Where a drop would land, so the gap is visible before the pointer is released. */
  let dropIndex = $state<number | undefined>(undefined);
  let dragging = $state<number | undefined>(undefined);

  const headings = $derived(view.headings);

  /**
   * Clears when the pane's note *changes*, and deliberately not when this component mounts.
   *
   * Following a link tears the editor down and builds a new one, and until that one
   * announces the panel would otherwise still show the previous note's headings — rows that
   * scroll a document nobody is looking at. But the panel is also unmounted every time the
   * right sidebar is collapsed, and clearing on mount would leave it empty on reopen until
   * the next keystroke: the announcements are collected by the shell, not by this component,
   * so the view is already current. Hence the `shown` guard rather than a bare effect.
   */
  let shown: string | undefined;
  let mounted = false;
  $effect(() => {
    const current = note;
    if (mounted && current !== shown) {
      view.clear();
      cursor = 0;
    }
    mounted = true;
    shown = current;
  });

  function onkeydown(event: KeyboardEvent): void {
    const action = outlineKeyAction(event.key, event, headings, cursor);
    if (action.kind === "none") return;
    event.preventDefault();
    switch (action.kind) {
      case "move":
        cursor = action.to;
        break;
      case "goto":
        view.goto(action.index);
        break;
      case "reorder":
        view.move(action.from, action.to);
        // The section travelled, so the cursor travels with it — otherwise the next Alt-arrow
        // moves whichever heading happens to have landed here.
        cursor = action.cursor;
        break;
    }
  }

  function ondragstart(event: DragEvent, index: number): void {
    dragging = index;
    event.dataTransfer?.setData("application/x-memberberry-heading", String(index));
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  function ondragover(event: DragEvent, at: number): void {
    if (event.dataTransfer?.types.includes("application/x-memberberry-heading") !== true) {
      return;
    }
    // Without this the browser refuses the drop and the row springs back with no explanation.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dropIndex = at;
  }

  function ondrop(event: DragEvent, at: number): void {
    const payload = event.dataTransfer?.getData("application/x-memberberry-heading");
    const from = payload === undefined ? Number.NaN : Number.parseInt(payload, 10);
    event.preventDefault();
    dropIndex = undefined;
    dragging = undefined;
    if (!Number.isInteger(from)) return;
    view.move(from, at);
    cursor = at;
  }

  function enddrag(): void {
    dropIndex = undefined;
    dragging = undefined;
  }
</script>

<section class="outline-panel tree-section" aria-labelledby="outline-heading">
  <h2 class="tree-heading" id="outline-heading">Outline</h2>

  {#if note === undefined}
    <p class="tree-empty">Open a note to see its outline.</p>
  {:else if headings.length === 0}
    <p class="tree-empty">This note has no headings.</p>
  {:else}
    <div
      class="tree outline-tree"
      role="tree"
      aria-label="Outline"
      tabindex="0"
      aria-activedescendant={headings[cursor] === undefined
        ? undefined
        : `outline-row-${cursor}`}
      {onkeydown}
    >
      {#each headings as heading, index (heading.index)}
        <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
             whole tree is the container above, which owns the arrows, Enter and the
             Alt-arrow reorder. `tabindex="-1"` is the `aria-activedescendant` pattern. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="tree-row outline-row"
          id={`outline-row-${index}`}
          role="treeitem"
          tabindex="-1"
          draggable="true"
          aria-level={heading.level}
          aria-selected={index === cursor}
          data-level={heading.level}
          data-current={index === view.active}
          data-dragging={index === dragging}
          data-drop-before={index === dropIndex}
          style={`--tree-depth: ${heading.level - 1}`}
          title={headingLabel(heading)}
          onclick={() => {
            cursor = index;
            view.goto(index);
          }}
          ondragstart={(event) => ondragstart(event, index)}
          ondragover={(event) => ondragover(event, index)}
          ondrop={(event) => ondrop(event, index)}
          ondragend={enddrag}
        >
          <span class="tree-icon" aria-hidden="true">H{heading.level}</span>
          <span class="tree-label">{headingLabel(heading)}</span>
        </div>
      {/each}
    </div>
  {/if}
</section>
