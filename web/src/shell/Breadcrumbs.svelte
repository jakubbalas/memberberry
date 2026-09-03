<!--
  Where the open note sits in the vault (`SPEC.md` §8.2).

  A `nav` with an ordered list, which is what a breadcrumb is: the folder segments are not
  links, because §4.1 says "folders are ordinary folders, not note containers" — there is
  nothing to open at `Projects/`. They are orientation, and marking them up as links would
  promise something the application cannot do.
-->
<script lang="ts">
  interface Props {
    /** The vault-relative note path, or `undefined` when the pane is empty. */
    readonly path?: string | undefined;
    /** The note's title, shown as the last crumb when it differs from the filename. */
    readonly title?: string | null | undefined;
  }

  const { path, title }: Props = $props();

  const segments = $derived(path === undefined ? [] : path.split("/").filter((s) => s !== ""));
  const folders = $derived(segments.slice(0, -1));
  const leaf = $derived.by(() => {
    const filename = (segments.at(-1) ?? "").replace(/\.md$/, "");
    return title === null || title === undefined || title === "" ? filename : title;
  });
</script>

{#if path !== undefined}
  <nav class="breadcrumbs" aria-label="Note location">
    <ol class="breadcrumb-list">
      {#each folders as folder, index (index)}
        <li class="breadcrumb"><span class="breadcrumb-folder">{folder}</span></li>
      {/each}
      <li class="breadcrumb">
        <span class="breadcrumb-note" aria-current="page">{leaf}</span>
      </li>
    </ol>
  </nav>
{/if}
