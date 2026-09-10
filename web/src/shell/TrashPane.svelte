<script lang="ts">
  import type { TrashEntry, TrashView } from "./trash.js";

  interface Props {
    readonly view: TrashView;
    readonly note?: string | undefined;
    readonly ondeleted?: (() => void) | undefined;
  }

  const { view, note, ondeleted }: Props = $props();
  let entries = $state<readonly TrashEntry[]>([]);
  let revision = $state(0);
  let loading = $state(true);
  let busy = $state(false);
  let message = $state<string | undefined>(undefined);

  $effect(() => {
    void load();
  });

  async function load(): Promise<void> {
    loading = true;
    try {
      await view.refresh();
      entries = view.entries;
      revision += 1;
    } catch {
      message = "Trash is unavailable.";
    } finally {
      loading = false;
    }
  }

  async function moveToTrash(): Promise<void> {
    if (note === undefined || busy || !globalThis.confirm(`Move ${note} to trash?`)) return;
    busy = true;
    message = undefined;
    try {
      if (await view.delete(note)) {
        message = "Note moved to trash.";
        ondeleted?.();
        await load();
      } else message = "Could not move the note to trash.";
    } finally {
      busy = false;
    }
  }

  async function restore(id: string): Promise<void> {
    busy = true;
    message = undefined;
    try {
      if (await view.restore(id)) {
        message = "Note restored.";
        await load();
      } else message = "Could not restore that note.";
    } finally {
      busy = false;
    }
  }

  const date = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString();
</script>

<section class="trash-pane" aria-labelledby="trash-heading" data-revision={revision} aria-busy={loading}>
  <h3 class="tree-heading" id="trash-heading">Trash</h3>
  {#if note !== undefined}
    <button type="button" class="trash-delete" disabled={busy} onclick={() => void moveToTrash()}>
      Move current note to trash
    </button>
  {/if}
  {#if message}<p class="tree-empty" role="status" aria-live="polite">{message}</p>{/if}
  {#if loading}<p class="tree-empty">Loading trash…</p>
  {:else if entries.length === 0}<p class="tree-empty">Trash is empty.</p>
  {:else}
    <ul class="trash-list">
      {#each entries.filter((entry): entry is TrashEntry => entry !== undefined) as entry (entry.id)}
        <li class="trash-row">
          <span class="trash-note">{entry.path}</span>
          <span class="trash-meta">Deleted {date(entry.deleted_at)} by {entry.actor}</span>
          <button type="button" disabled={busy} onclick={() => void restore(entry.id)}>Restore</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
