<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { NoteCatalog } from "./note-catalog.svelte.js";
  import { buildTree, type TreeNode } from "./tree.js";

  interface Props {
    readonly path: string;
    readonly catalog: NoteCatalog;
    readonly emptyFolders: readonly string[];
    /** The empty-directory request can finish after the note catalog. */
    readonly foldersLoading?: boolean;
    readonly onopen: (path: string) => void;
    readonly onfolder: (path: string) => void;
    readonly onclose: () => void;
  }
  const { path, catalog, emptyFolders, foldersLoading = false, onopen, onfolder, onclose }: Props = $props();
  let heading = $state<HTMLHeadingElement | undefined>();
  const name = $derived(path === "" ? "Vault" : path.slice(path.lastIndexOf("/") + 1));
  const parent = $derived(path.slice(0, Math.max(0, path.lastIndexOf("/"))));
  const parentName = $derived(parent === "" ? "Vault" : parent.slice(parent.lastIndexOf("/") + 1));
  const entries = $derived.by((): readonly TreeNode[] | undefined => {
    let level = buildTree(catalog.notes, emptyFolders);
    if (path === "") return level;
    let prefix = "";
    for (const part of path.split("/")) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      const folder = level.find((entry) => entry.kind === "folder" && entry.path === prefix);
      if (folder?.kind !== "folder") return undefined;
      level = folder.children;
    }
    return level;
  });
  $effect(() => { catalog.ensure(); });
  $effect(() => { void path; heading?.focus(); });
</script>

<section class="workspace-home folder-contents" aria-labelledby="folder-heading">
  <header>
    <h1 id="folder-heading" tabindex="-1" bind:this={heading}>{name}</h1>
    <button type="button" class="icon-button" aria-label="Close folder view" title="Close folder view" onclick={onclose}><Icon name="close" /></button>
  </header>
  <nav class="folder-navigation" aria-label="Folder navigation">
    {#if path !== ""}<button type="button" onclick={() => onfolder(parent)}>Up to {parentName}</button>{/if}
    <span>{path === "" ? "Vault root" : path}</span>
  </nav>
  <section class="home-notes" aria-label="Folder contents">
    {#if !catalog.ready || foldersLoading}
      <p class="home-description" role="status">Loading folder contents…</p>
    {:else if entries === undefined}
      <p class="home-description" role="status">This folder is no longer available.</p>
    {:else if entries.length === 0}
      <p class="home-description">This folder is empty.</p>
    {:else}
      <ul>
        {#each entries as entry (entry.path)}
          <li><button type="button" title={entry.path} aria-label={entry.kind === "folder" ? `Open folder ${entry.name}` : undefined} onclick={() => entry.kind === "folder" ? onfolder(entry.path) : onopen(entry.path)}>
            <Icon name={entry.kind === "folder" ? "folder" : "note"} />
            <span><strong>{entry.kind === "folder" ? entry.name : entry.title ?? entry.name}</strong></span>
            <Icon name="chevron-right" />
          </button></li>
        {/each}
      </ul>
    {/if}
  </section>
</section>
