<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { NoteCatalog } from "./note-catalog.svelte.js";

  interface Props {
    readonly catalog: NoteCatalog;
    readonly onopen: (path: string) => void;
    readonly oncreate: () => void;
  }

  const { catalog, onopen, oncreate }: Props = $props();
</script>

<section class="workspace-home" aria-labelledby="home-heading">
  <header>
    <h1 id="home-heading">Home</h1>
    <button type="button" class="home-create" onclick={oncreate}><Icon name="plus" />New note</button>
  </header>
  <section class="home-notes" aria-labelledby="home-notes-heading">
    <div class="home-notes-heading">
      <h2 id="home-notes-heading">Your notes</h2>
      {#if catalog.ready}<span>{catalog.notes.length} {catalog.notes.length === 1 ? "note" : "notes"}</span>{/if}
    </div>
    {#if !catalog.ready}
      <p class="home-description">Loading your notes…</p>
    {:else if catalog.notes.length === 0}
      <p class="home-description">This vault has no notes yet. Create one to get started.</p>
    {:else}
      <ul>
        {#each catalog.notes.slice(0, 8) as note (note.path)}
          {@const folderEnd = note.path.lastIndexOf("/")}
          <li><button type="button" onclick={() => onopen(note.path)}>
            <Icon name="note" />
            <span><strong>{#if folderEnd >= 0}<small>{note.path.slice(0, folderEnd)}{" / "}</small>{/if}{note.title ?? note.path.slice(folderEnd + 1).replace(/\.md$/, "")}</strong></span>
            <Icon name="chevron-right" />
          </button></li>
        {/each}
      </ul>
      {#if catalog.notes.length > 8}<p class="home-description">Find all your notes in the sidebar or search.</p>{/if}
    {/if}
  </section>
</section>
