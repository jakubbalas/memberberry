<!--
  One pane's tab bar (`SPEC.md` §8.2).

  Tabs are draggable between panes, and **every drag has a keyboard equivalent** — §8.4 is
  not a preference. Native HTML5 drag-and-drop is not keyboard-operable at all, so the
  keyboard path is explicit: arrows move focus, Cmd/Ctrl-Shift-arrow moves the tab itself,
  including into the neighbouring pane when it runs off the end.

  The strip is a `tablist`, so a screen reader reports "tab 2 of 4" rather than a row of
  buttons, and the close control is a real button inside each tab rather than a click region.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import { requestRename } from "./rename.js";
  import type { GroupId, Tab, TabGroup } from "./workspace.js";

  interface Props {
    readonly group: TabGroup;
    /** Every pane, in layout order, so a tab can be moved to the next or previous one. */
    readonly panes: readonly GroupId[];
    readonly focused: boolean;
    readonly onactivate: (tab: string) => void;
    readonly onopennewtab: (path: string) => void;
    readonly onclose: (tab: string) => void;
    readonly onmove: (tab: string, toGroup: GroupId, index: number) => void;
    readonly iconOf?: ((path: string) => string | null | undefined) | undefined;
    readonly titleOf?: ((path: string) => string | null) | undefined;
    readonly target?: EventTarget | undefined;
  }

  const { group, panes, focused, onactivate, onopennewtab, onclose, onmove, iconOf, titleOf, target }: Props = $props();

  /** The drag in progress, if the pointer started it in this strip. */
  let dragging = $state<string | undefined>(undefined);
  /** Where a drop would land, so the gap is visible before the mouse is released. */
  let dropIndex = $state<number | undefined>(undefined);
  let context = $state<{ path: string; x: number; y: number } | undefined>(undefined);

  const index = $derived(panes.indexOf(group.id));

  /** The shared note title, falling back to the filename when the note has no title. */
  function label(tab: Tab): string {
    const title = titleOf?.(tab.note);
    if (title !== undefined && title !== null && title !== "") return title;
    const name = tab.note.split("/").pop() ?? tab.note;
    return name.replace(/\.md$/, "");
  }

  function ondragstart(event: DragEvent, tab: string): void {
    dragging = tab;
    // The id travels in the drag payload as well as in local state, so a drop into a
    // *different* strip — a different component instance — can read it.
    event.dataTransfer?.setData("application/x-memberberry-tab", tab);
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
  }

  function ondragend(): void {
    dragging = undefined;
    dropIndex = undefined;
  }

  function ondragover(event: DragEvent, at: number): void {
    if (event.dataTransfer?.types.includes("application/x-memberberry-tab") !== true) return;
    // Without this the browser refuses the drop and the tab springs back with no explanation.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    dropIndex = at;
  }

  function ondrop(event: DragEvent, at: number): void {
    const tab = event.dataTransfer?.getData("application/x-memberberry-tab");
    if (tab === undefined || tab === "") return;
    event.preventDefault();
    dropIndex = undefined;
    dragging = undefined;
    onmove(tab, group.id, at);
  }

  /**
   * Keyboard tab management.
   *
   * Arrows move focus and selection along the strip, which is what a `tablist` is expected
   * to do. Adding Cmd/Ctrl-Shift makes the arrow move the *tab*, and running off either end
   * moves it into the adjacent pane — the keyboard equivalent of dragging it across.
   */
  function onkeydown(event: KeyboardEvent, tab: Tab, at: number): void {
    const moving = (event.metaKey || event.ctrlKey) && event.shiftKey;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;

    if (step !== 0 && moving) {
      event.preventDefault();
      const target = at + step;
      if (target >= 0 && target <= group.tabs.length - 1) {
        onmove(tab.id, group.id, target);
        return;
      }
      // Off the end: into the neighbouring pane, at the near edge, so the tab keeps
      // travelling in the direction the user is pressing.
      const neighbour = panes[index + step];
      if (neighbour === undefined) return;
      onmove(tab.id, neighbour, step === 1 ? 0 : Number.MAX_SAFE_INTEGER);
      return;
    }

    if (step !== 0) {
      event.preventDefault();
      const next = group.tabs[at + step];
      if (next !== undefined) onactivate(next.id);
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onclose(tab.id);
    }
  }
</script>

<div class="tab-strip" role="tablist" aria-label="Open notes" data-focused={focused}>
  {#each group.tabs as tab, at (tab.id)}
    <div
      class="tab"
      role="tab"
      tabindex={tab.id === group.activeTab ? 0 : -1}
      aria-selected={tab.id === group.activeTab}
      title={tab.note}
      draggable="true"
      data-dragging={tab.id === dragging}
      data-drop-before={at === dropIndex}
      data-mode={tab.mode}
      ondragstart={(event) => ondragstart(event, tab.id)}
      {ondragend}
      ondragover={(event) => ondragover(event, at)}
      ondrop={(event) => ondrop(event, at)}
      onclick={() => onactivate(tab.id)}
      onkeydown={(event) => onkeydown(event, tab, at)}
      oncontextmenu={(event) => {
        event.preventDefault();
        context = { path: tab.note, x: event.clientX, y: event.clientY };
      }}
    >
      {#if iconOf?.(tab.note)}
        <span class="tab-icon" aria-hidden="true">{iconOf(tab.note)}</span>
      {/if}
      <span class="tab-label">{label(tab)}</span>
      <button
        type="button"
        class="tab-close"
        aria-label={`Close ${label(tab)}`}
        onclick={(event) => {
          // why: the click would otherwise bubble to the tab and try to activate the tab
          // that is closing. The store treats that as a no-op today, so this is not load
          // bearing — it is here so it stays harmless if the tab's own handler ever does
          // more than activate.
          event.stopPropagation();
          onclose(tab.id);
        }}
      >
        <Icon name="close" />
      </button>
    </div>
  {/each}

  <!--
    The rest of the strip is a drop target for "put it at the end". Without it, dropping in
    the empty space past the last tab does nothing, which reads as a broken drag.
  -->
  <div
    class="tab-strip-rest"
    data-drop-end={dropIndex === group.tabs.length}
    ondragover={(event) => ondragover(event, group.tabs.length)}
    ondrop={(event) => ondrop(event, group.tabs.length)}
    role="presentation"
  ></div>
</div>

<ContextMenu
  open={context !== undefined}
  x={context?.x ?? 0}
  y={context?.y ?? 0}
  onrename={() => {
    if (context !== undefined) requestRename(context.path, target);
    context = undefined;
  }}
  onopennewtab={() => {
    if (context !== undefined) onopennewtab(context.path);
    context = undefined;
  }}
  ondismiss={() => (context = undefined)}
/>
