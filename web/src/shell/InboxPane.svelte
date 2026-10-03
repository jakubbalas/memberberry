<!--
  The task inbox (`SPEC.md` §10.3).

  Open tasks in the readable set, grouped overdue / today / this week / later / no date, with
  the filters and sort the route already understands. Selecting a row opens the source note —
  completion, due date and priority controls route through that source editor.

  Everything here arrives permission-filtered (E18). There is no filtering in this file and
  there must never be one.
-->
<script lang="ts">
  import type { InboxView } from "./tasks.svelte.js";
  import ContextMenu from "./ContextMenu.svelte";
  import Icon from "./Icon.svelte";
  import type { TaskDisplayPreferences } from "./task-display.js";
  import type { TaskEditAction } from "./note-surface.js";
  import {
    inboxSourceLabel,
    isTaskPriority,
    isTaskSort,
    type TaskPriority,
  } from "./tasks.js";

  interface Props {
    readonly view: InboxView;
    readonly onopen: (path: string) => void;
    readonly onedit?: (path: string, ordinal: number, action: TaskEditAction) => void;
    readonly display?: TaskDisplayPreferences;
    readonly ondisplay?: (display: TaskDisplayPreferences) => void;
    readonly onopenmain?: () => void;
    readonly onclose?: () => void;
    /** Two views may share the same inbox, but never HTML ids. */
    readonly idPrefix?: string;
  }

  const { view, onopen, onedit, display = { showFilenames: false, showPaths: false }, ondisplay, onopenmain, onclose, idPrefix = "inbox" }: Props = $props();

  // why: mount focus belongs to the main view, not to the menu trigger hidden in a mobile drawer.
  let heading = $state<HTMLHeadingElement | undefined>();
  $effect(() => {
    if (onclose !== undefined) heading?.focus({ preventScroll: true });
  });

  let filtersOpen = $state(false);
  let menu = $state<{ x: number; y: number } | undefined>();

  function showMenu(event: MouseEvent): void {
    const button = event.currentTarget;
    if (!(button instanceof HTMLElement)) return;
    // why: touch/programmatic clicks need not focus their button; the menu restores this opener.
    button.focus({ preventScroll: true });
    if (menu !== undefined) { menu = undefined; return; }
    const bounds = button.getBoundingClientRect();
    menu = { x: bounds.right, y: bounds.bottom };
  }

  function setDisplay(field: keyof TaskDisplayPreferences): void {
    ondisplay?.({ ...display, [field]: !display[field] });
    menu = undefined;
  }

  // why: `$effect` rather than `$derived`. Fetching is not a derivation — and `ensure` is a
  // no-op once something has asked, so this settles rather than looping.
  $effect(() => {
    view.ensure();
  });

  function onSort(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (isTaskSort(value)) view.setFilter("sort", value);
  }

  function onPriority(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === "" || isTaskPriority(value)) {
      view.setFilter("priority", value as TaskPriority | "");
    }
  }
</script>

<section class="inbox-panel" aria-labelledby={`${idPrefix}-heading`}>
  <div class="inbox-heading">
    <h3 class="tree-heading" id={`${idPrefix}-heading`} tabindex="-1" bind:this={heading}>Tasks</h3>
    <div class="inbox-heading-actions">
      {#if onclose !== undefined}
        <button type="button" class="icon-button" aria-label="Close tasks main panel" title="Close tasks main panel" onclick={onclose}><Icon name="close" /></button>
      {/if}
      <button type="button" class="icon-button" aria-label="Task options" title="Task options" aria-haspopup="menu" aria-expanded={menu !== undefined} onclick={showMenu}><Icon name="more" /></button>
    </div>
  </div>

  <div class="inbox-toolbar">
    <label class="inbox-field inbox-sort">
      <span class="inbox-field-label">Sort</span>
      <select class="inbox-select" aria-label="Sort tasks" value={view.filters.sort} onchange={onSort}>
        <option value="due">Due</option>
        <option value="priority">Priority</option>
        <option value="created">Created</option>
        <option value="path">Path</option>
      </select>
    </label>
    <button
      type="button"
      class="inbox-filters-toggle"
      aria-expanded={filtersOpen}
      aria-controls={`${idPrefix}-filters`}
      onclick={() => (filtersOpen = !filtersOpen)}
    >
      {filtersOpen ? "Hide filters" : "Filters"}
    </button>
  </div>

  {#if filtersOpen}
    <div class="inbox-filters" id={`${idPrefix}-filters`}>
      <label class="inbox-field">
        <span class="inbox-field-label">Folder</span>
        <input
          class="inbox-input"
          type="text"
          value={view.filters.folder}
          placeholder="Projects"
          aria-label="Filter by folder"
          onchange={(event) => view.setFilter("folder", event.currentTarget.value)}
        />
      </label>
      <label class="inbox-field">
        <span class="inbox-field-label">Tag</span>
        <input
          class="inbox-input"
          type="text"
          value={view.filters.tag}
          placeholder="#work"
          aria-label="Filter by tag"
          onchange={(event) => view.setFilter("tag", event.currentTarget.value)}
        />
      </label>
      <label class="inbox-field">
        <span class="inbox-field-label">Priority</span>
        <select class="inbox-select" aria-label="Filter by priority" value={view.filters.priority} onchange={onPriority}>
          <option value="">Any</option>
          <option value="highest">Highest</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
          <option value="lowest">Lowest</option>
        </select>
      </label>
      <label class="inbox-field">
        <span class="inbox-field-label">Due from</span>
        <input
          class="inbox-input"
          type="date"
          value={view.filters.dueFrom}
          aria-label="Due from"
          onchange={(event) => view.setFilter("dueFrom", event.currentTarget.value)}
        />
      </label>
      <label class="inbox-field">
        <span class="inbox-field-label">Due to</span>
        <input
          class="inbox-input"
          type="date"
          value={view.filters.dueTo}
          aria-label="Due to"
          onchange={(event) => view.setFilter("dueTo", event.currentTarget.value)}
        />
      </label>
      <label class="inbox-field">
        <span class="inbox-field-label">Note</span>
        <input
          class="inbox-input"
          type="text"
          value={view.filters.note}
          placeholder="Inbox/Due.md"
          aria-label="Filter by note path"
          onchange={(event) => view.setFilter("note", event.currentTarget.value)}
        />
      </label>
    </div>
  {/if}

  {#if view.loading}
    <p class="tree-empty">Loading tasks…</p>
  {:else if view.unavailable}
    <p class="tree-empty">Tasks are unavailable for this vault.</p>
  {:else if view.empty}
    <p class="tree-empty">No open tasks in the notes you can read.</p>
  {:else}
    <div class="inbox-groups">
      {#each view.groups as group (group.id)}
        <section class="inbox-group" data-group={group.id} aria-labelledby={`${idPrefix}-group-${group.id}`}>
          <h4 class="inbox-group-heading" id={`${idPrefix}-group-${group.id}`}>
            {group.label}
            <span class="inbox-group-count">{group.tasks.length}</span>
          </h4>
          <ul class="inbox-list">
            {#each group.tasks as task (task.path + ":" + task.ordinal)}
              <li>
                <div class="inbox-task-row" data-editable={onedit !== undefined} data-path={task.path} data-block={task.blockId ?? undefined}>
                  {#if onedit !== undefined}
                    <label class="inbox-task-check">
                      <input type="checkbox" aria-label={`Complete task: ${task.text}`} checked={false} onchange={(event) => {
                        // why: the source editor owns the write; a click is not a server acknowledgement.
                        event.currentTarget.checked = false;
                        onedit?.(task.path, task.ordinal, { kind: "complete" });
                      }} />
                    </label>
                  {/if}
                  <button type="button" class="inbox-task" data-path={task.path} data-block={task.blockId ?? undefined} onclick={() => onopen(task.path)}>
                  <span class="inbox-task-text">{task.text}</span>
                  <span class="inbox-task-source">{inboxSourceLabel(task, display.showFilenames)}</span>
                  {#if display.showPaths}<span class="inbox-task-path">{task.path}</span>{/if}
                  {#if task.due !== null}
                    <span class="inbox-task-due">{task.due}</span>
                  {/if}
                  {#if task.priority !== null}
                    <span class="inbox-task-priority" data-priority={task.priority}>{task.priority}</span>
                  {/if}
                  </button>
                  {#if onedit !== undefined}
                    <div class="inbox-task-fields">
                    <input
                      class="inbox-task-date"
                      type="date"
                      value={task.due ?? ""}
                      aria-label={`Due date for ${task.text}`}
                      onchange={(event) => onedit?.(task.path, task.ordinal, { kind: "due", value: event.currentTarget.value })}
                    />
                    <select
                      class="inbox-task-priority"
                      aria-label={`Priority for ${task.text}`}
                      value={task.priority ?? ""}
                      onchange={(event) => {
                        const value = event.currentTarget.value;
                        onedit?.(task.path, task.ordinal, { kind: "priority", value: value === "" ? null : value as TaskPriority });
                      }}
                    >
                      <option value="">No priority</option>
                      <option value="highest">Highest</option><option value="high">High</option>
                      <option value="medium">Medium</option><option value="low">Low</option><option value="lowest">Lowest</option>
                    </select>
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  {/if}
</section>

<ContextMenu open={menu !== undefined} label="Task options" x={menu?.x ?? 0} y={menu?.y ?? 0}
  onopenmain={onopenmain === undefined ? undefined : () => { menu = undefined; onopenmain(); }}
  options={ondisplay === undefined ? [] : [
    { label: "Show filenames", checked: display.showFilenames, ontoggle: () => setDisplay("showFilenames") },
    { label: "Show file paths", checked: display.showPaths, ontoggle: () => setDisplay("showPaths") },
  ]}
  ondismiss={() => { menu = undefined; }} />
