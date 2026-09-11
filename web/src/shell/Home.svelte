<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { NoteCatalog } from "./note-catalog.svelte.js";

  interface Props {
    readonly vault: string;
    readonly catalog: NoteCatalog;
    readonly onopen: (path: string) => void;
    readonly oncreate: () => void;
  }

  const { vault, catalog, onopen, oncreate }: Props = $props();
</script>

<section class="workspace-home" aria-labelledby="home-heading">
  <header>
    <p class="home-vault">{vault}</p>
    <h1 id="home-heading">Home</h1>
    <p class="home-description">Pick up a note, or start with a blank page.</p>
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
          <li><button type="button" onclick={() => onopen(note.path)}>
            <Icon name="note" />
            <span><strong>{note.title ?? note.path.replace(/\.md$/, "")}</strong><small>{note.path}</small></span>
            <Icon name="chevron-right" />
          </button></li>
        {/each}
      </ul>
      {#if catalog.notes.length > 8}<p class="home-description">Find all your notes in the sidebar or search.</p>{/if}
    {/if}
  </section>
</section>
