<!--
  The note tree and bookmark list (`SPEC.md` §8.2).

  A `tree` widget with **one tab stop**, not one per row. Roving `tabindex` plus arrow keys is
  what the role promises and what a screen reader announces; a list where Tab walks through
  four hundred notes is not navigable by anyone.

  Every decision about what a keypress means lives in `tree.ts`, so this component only routes
  the answer. That is what keeps the renderer and the keyboard working from the same list of
  visible rows — walk the tree twice and they disagree the moment a folder closes.
-->
<script lang="ts">
  import type { Bookmarks } from "./bookmarks.svelte.js";
  import type { NoteCatalog } from "./note-catalog.svelte.js";
  import { buildTree, treeKeyAction, visibleRows } from "./tree.js";

  interface Props {
    readonly catalog: NoteCatalog;
    readonly bookmarks: Bookmarks;
    /** The note showing in the focused pane, so the tree can mark it. */
    readonly activeNote?: string | undefined;
    readonly onopen: (path: string) => void;
  }

  const { catalog, bookmarks, activeNote, onopen }: Props = $props();

  let expanded = $state<ReadonlySet<string>>(new Set());
  let cursor = $state(0);

  $effect(() => {
    catalog.ensure();
    bookmarks.ensure();
  });

  const tree = $derived(buildTree(catalog.notes));
  const rows = $derived(visibleRows(tree, expanded));

  /** The bookmark rows, resolved back to their titles so they read like the tree does. */
  const bookmarked = $derived(
    bookmarks.paths.map((path) => {
      const note = catalog.notes.find((candidate) => candidate.path === path);
      return {
        path,
        label: note?.title ?? (path.split("/").pop() ?? path).replace(/\.md$/, ""),
        conflicts: note?.conflicts ?? 0,
      };
    }),
  );

  function setExpanded(path: string, open: boolean): void {
    const next = new Set(expanded);
    if (open) next.add(path);
    else next.delete(path);
    expanded = next;
  }

  function onkeydown(event: KeyboardEvent): void {
    const action = treeKeyAction(event.key, rows, cursor);
    if (action.kind === "none") return;
    event.preventDefault();
    switch (action.kind) {
      case "move":
        cursor = action.to;
        break;
      case "expand":
        setExpanded(action.path, true);
        break;
      case "collapse":
        setExpanded(action.path, false);
        break;
      case "open":
        onopen(action.path);
        break;
    }
  }

  const label = (row: (typeof rows)[number]): string =>
    row.node.kind === "note" ? (row.node.title ?? row.node.name) : row.node.name;

  const conflictLabel = (count: number): string =>
    `${count} unresolved ${count === 1 ? "conflict" : "conflicts"}`;
</script>

<div class="tree-panel">
  {#if bookmarked.length > 0}
    <section class="tree-section" aria-labelledby="bookmarks-heading">
      <h3 class="tree-heading" id="bookmarks-heading">Bookmarks</h3>
      <ul class="bookmark-list">
        {#each bookmarked as entry (entry.path)}
          <li>
            <button
              type="button"
              class="tree-row is-bookmark"
              data-current={entry.path === activeNote}
              title={entry.path}
              onclick={() => onopen(entry.path)}
            >
              <span class="tree-icon" aria-hidden="true">★</span>
              <span class="tree-label">{entry.label}</span>
              {#if entry.conflicts > 0}
                <span class="tree-conflicts" aria-label={conflictLabel(entry.conflicts)}>
                  {entry.conflicts}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="tree-section" aria-labelledby="notes-heading">
    <h3 class="tree-heading" id="notes-heading">Notes</h3>

    {#if !catalog.ready}
      <p class="tree-empty">Loading…</p>
    {:else if rows.length === 0}
      <p class="tree-empty">This vault has no notes you can read.</p>
    {:else}
      <!--
        One tab stop for the whole tree, with `aria-activedescendant` naming the current row.
        Tab moves past the tree; arrows move within it.
      -->
      <div
        class="tree"
        role="tree"
        aria-label="Notes"
        tabindex="0"
        aria-activedescendant={rows[cursor] === undefined ? undefined : `tree-row-${cursor}`}
        {onkeydown}
      >
        {#each rows as row, index (row.node.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
               whole tree is the container above, which owns arrows and Enter. `tabindex="-1"`
               is the `aria-activedescendant` pattern: the container is the single tab stop and
               a row is focusable only programmatically, so Tab moves past the tree rather than
               through four hundred notes. -->
          <div
            class="tree-row"
            id={`tree-row-${index}`}
            role="treeitem"
            tabindex="-1"
            aria-level={row.depth + 1}
            aria-expanded={row.node.kind === "folder" ? row.expanded === true : undefined}
            aria-selected={index === cursor}
            data-kind={row.node.kind}
            data-current={row.node.kind === "note" && row.node.path === activeNote}
            style={`--tree-depth: ${row.depth}`}
            title={row.node.path}
            onclick={() => {
              cursor = index;
              if (row.node.kind === "note") onopen(row.node.path);
              else setExpanded(row.node.path, row.expanded !== true);
            }}
          >
            <span class="tree-icon" aria-hidden="true">
              {#if row.node.kind === "folder"}{row.expanded === true ? "▾" : "▸"}{:else}·{/if}
            </span>
            <span class="tree-label">{label(row)}</span>

            {#if row.node.kind === "note"}
              {@const path = row.node.path}
              {#if row.node.conflicts > 0}
                <span class="tree-conflicts" aria-label={conflictLabel(row.node.conflicts)}>
                  {row.node.conflicts}
                </span>
              {/if}
              <button
                type="button"
                class="tree-bookmark"
                aria-pressed={bookmarks.has(path)}
                aria-label={`${bookmarks.has(path) ? "Remove" : "Add"} bookmark for ${label(row)}`}
                onclick={(event) => {
                  // Without this the click also reaches the row and opens the note, which is
                  // not what someone reaching for a star meant.
                  event.stopPropagation();
                  bookmarks.toggle(path);
                }}
              >
                {bookmarks.has(path) ? "★" : "☆"}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
