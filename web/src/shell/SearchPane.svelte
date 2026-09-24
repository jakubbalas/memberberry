<!-- Full-vault search, exact online or compact-prefix offline (`SPEC.md` §14.3). -->
<script lang="ts">
  import type { SearchView } from "./search.svelte.js";

  interface Props {
    readonly view: SearchView;
    readonly onopen: (path: string) => void;
  }

  const { view, onopen }: Props = $props();
</script>

<section class="search-panel" aria-labelledby="search-heading">
  <h3 class="tree-heading" id="search-heading">Search</h3>
  <input
    class="search-input"
    type="search"
    value={view.query}
    placeholder="Search this vault"
    aria-label="Search this vault"
    oninput={(event) => view.search(event.currentTarget.value)}
  />

  {#if view.loading}
    <p class="tree-empty">Searching…</p>
  {:else if view.unavailable}
    <p class="tree-empty">Search is unavailable online and no local index is ready.</p>
  {:else if view.answer !== undefined}
    <p class="search-mode" data-mode={view.answer.mode}>
      {view.answer.mode === "online" ? "Online — exact search" : "Offline — prefix search"}
    </p>
    {#if view.answer.phraseDegraded}
      <p class="search-warning">Quoted phrases match all words while offline.</p>
    {/if}
    {#if view.answer.hits.length === 0}
      <p class="tree-empty">No matching notes.</p>
    {:else}
      <ul class="search-results">
        {#each view.answer.hits as hit}
          <li>
            <button type="button" class="search-result" data-path={hit.path} onclick={() => onopen(hit.path)}>
              <span class="tree-label">{hit.title ?? hit.path}</span>
              <span class="search-path">{hit.path}</span>
              <span class="search-context">{hit.context}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
