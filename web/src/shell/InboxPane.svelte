<!--
  The task inbox (`SPEC.md` §10.3).

  Open tasks in the readable set, grouped overdue / today / this week / later / no date, with
  the filters and sort the route already understands. Selecting a row opens the source note —
  editing the task *from* the inbox (toggle, due, priority) is the remaining M14 item.

  Everything here arrives permission-filtered (E18). There is no filtering in this file and
  there must never be one.
-->
<script lang="ts">
  import type { InboxView } from "./tasks.svelte.js";
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
  }

  const { view, onopen, onedit }: Props = $props();

  let filtersOpen = $state(false);

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

<section class="inbox-panel" aria-labelledby="inbox-heading">
  <h3 class="tree-heading" id="inbox-heading">Tasks</h3>

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
      aria-controls="inbox-filters"
      onclick={() => (filtersOpen = !filtersOpen)}
    >
      {filtersOpen ? "Hide filters" : "Filters"}
    </button>
  </div>

  {#if filtersOpen}
    <div class="inbox-filters" id="inbox-filters">
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
        <section class="inbox-group" data-group={group.id} aria-labelledby={`inbox-group-${group.id}`}>
          <h4 class="inbox-group-heading" id={`inbox-group-${group.id}`}>
            {group.label}
            <span class="inbox-group-count">{group.tasks.length}</span>
          </h4>
          <ul class="inbox-list">
            {#each group.tasks as task (task.path + ":" + task.ordinal)}
              <li>
                <div class="inbox-task-row" data-path={task.path} data-block={task.blockId ?? undefined}>
                  <button type="button" class="inbox-task" data-path={task.path} data-block={task.blockId ?? undefined} onclick={() => onopen(task.path)}>
                  <span class="inbox-task-text">{task.text}</span>
                  <span class="inbox-task-source">{inboxSourceLabel(task)}</span>
                  {#if task.due !== null}
                    <span class="inbox-task-due">{task.due}</span>
                  {/if}
                  {#if task.priority !== null}
                    <span class="inbox-task-priority" data-priority={task.priority}>{task.priority}</span>
                  {/if}
                  </button>
                  {#if onedit !== undefined}
                    <button type="button" class="inbox-task-action" aria-label="Toggle task" onclick={() => onedit(task.path, task.ordinal, { kind: "toggle" })}>Toggle</button>
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
