<!--
  The tag pane (`SPEC.md` §9.3).

  A collapsible tree of nested tags with per-node counts, in the left sidebar beside the note
  tree. Selecting a node lists the notes carrying that tag or any tag nested under it; §9.3
  says selecting a node *searches* that prefix, and the search index arrives with M9 (§14.1),
  so until then this lists them — the part of that promise the index can already keep.

  One tab stop for the whole tree with `aria-activedescendant`, exactly as `NoteTree.svelte`
  does it and for the same reason: Tab must not walk through four hundred tags. Every decision
  about what a keypress means lives in `tags.ts`.

  Everything here arrives permission-filtered (E16) — counts included, because a count is a
  statement about how many notes exist. There is no filtering in this file and there must
  never be one.
-->
<script lang="ts">
  import type { TagView } from "./tags.svelte.js";
  import { buildTagTree, tagKeyAction, taggedLabel, visibleTagRows } from "./tags.js";

  interface Props {
    readonly view: TagView;
    readonly onopen: (path: string) => void;
  }

  const { view, onopen }: Props = $props();

  let expanded = $state<ReadonlySet<string>>(new Set());
  let cursor = $state(0);

  // why: `$effect` rather than `$derived`. Fetching is not a derivation — and `ensure` is a
  // no-op once something has asked, so this settles rather than looping.
  $effect(() => {
    view.ensure();
  });

  const tree = $derived(buildTagTree(view.counts));
  const rows = $derived(visibleTagRows(tree, expanded));

  function setExpanded(key: string, open: boolean): void {
    const next = new Set(expanded);
    if (open) next.add(key);
    else next.delete(key);
    expanded = next;
  }

  function onkeydown(event: KeyboardEvent): void {
    const action = tagKeyAction(event.key, rows, cursor);
    if (action.kind === "none") return;
    event.preventDefault();
    switch (action.kind) {
      case "move":
        cursor = action.to;
        break;
      case "expand":
        setExpanded(action.key, true);
        break;
      case "collapse":
        setExpanded(action.key, false);
        break;
      case "select":
        view.select(action.key);
        break;
    }
  }
</script>

<section class="tree-section tag-pane" aria-labelledby="tags-heading">
  <h3 class="tree-heading" id="tags-heading">Tags</h3>

  {#if view.loading}
    <p class="tree-empty">Loading…</p>
  {:else if view.unavailable}
    <!-- Deliberately not "no tags": the server did not answer, and saying there are none
         would be a statement nobody checked. -->
    <p class="tree-empty">Tags are unavailable for this vault.</p>
  {:else if view.empty}
    <p class="tree-empty">No tags in the notes you can read.</p>
  {:else}
    <div
      class="tree tag-tree"
      role="tree"
      aria-label="Tags"
      tabindex="0"
      aria-activedescendant={rows[cursor] === undefined ? undefined : `tag-row-${cursor}`}
      {onkeydown}
    >
      {#each rows as row, index (row.node.key)}
        <div class="tag-row-frame" style={`--tree-depth: ${row.depth}`}>
          {#if row.expanded !== undefined}
            <!-- A separate control from the row: selecting a tag and opening its children are
                 two different intentions, and a row that did both would make either of them
                 impossible to do alone. The arrow keys reach both without it (`tags.ts`), so
                 this is the pointer's equivalent rather than the only way in. -->
            <button
              type="button"
              class="tag-twisty"
              aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.node.name}`}
              aria-expanded={row.expanded}
              onclick={() => setExpanded(row.node.key, !row.expanded)}
            >
              <span aria-hidden="true">{row.expanded ? "▾" : "▸"}</span>
            </button>
          {:else}
            <span class="tag-twisty is-leaf" aria-hidden="true"></span>
          {/if}

          <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
               whole tree is the container above, which owns the arrows and Enter.
               `tabindex="-1"` is the `aria-activedescendant` pattern: the container is the
               single tab stop and a row is focusable only programmatically. -->
          <div
            class="tree-row tag-row"
            id={`tag-row-${index}`}
            role="treeitem"
            tabindex="-1"
            aria-level={row.depth + 1}
            aria-expanded={row.expanded}
            aria-selected={view.selected === row.node.key}
            data-tag={row.node.key}
            data-current={view.selected === row.node.key}
            onclick={() => {
              cursor = index;
              view.select(row.node.key);
            }}
          >
            <span class="tree-icon" aria-hidden="true">#</span>
            <span class="tree-label">{row.node.name}</span>
            <span class="tag-count">{row.node.notes}</span>
          </div>
        </div>

        {#if view.selected === row.node.key}
          <div class="tag-notes" style={`--tree-depth: ${row.depth + 1}`}>
            {#if view.notesLoading}
              <p class="tree-empty">Looking for notes…</p>
            {:else if view.notesUnavailable}
              <p class="tree-empty">Notes for this tag are unavailable.</p>
            {:else if view.notes.length === 0}
              <p class="tree-empty">No notes carry this tag.</p>
            {:else}
              <ul class="tag-note-list">
                {#each view.notes as note (note.path)}
                  <li>
                    <button
                      type="button"
                      class="tree-row is-tagged"
                      data-path={note.path}
                      title={note.path}
                      onclick={() => onopen(note.path)}
                    >
                      <span class="tree-icon" aria-hidden="true">·</span>
                      <span class="tree-label">{taggedLabel(note)}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</section>
