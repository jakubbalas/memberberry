<!--
  The backlinks panel (`SPEC.md` §9.5).

  Inbound links to the note in the focused pane, grouped by the note they come from, each
  showing the block it sits in — and below them, notes that name this one without linking to
  it. Rows are buttons: §8.4 means what it says, and a panel of clickable divs is a panel a
  keyboard cannot use.

  The two sections are kept visibly apart because they are different claims. A backlink is
  something an author wrote on purpose; a mention is a coincidence of words that may be worth
  linking, and may equally be a different Roadmap entirely.

  Everything here arrives permission-filtered from the server (E8). There is no filtering in
  this file and there must never be one — the client never receives a note it may not see, so
  it never has anything to hide.
-->
<script lang="ts">
  import type { BacklinkView } from "./backlinks.svelte.js";
  import { sourceLabel } from "./backlinks.js";

  interface Props {
    readonly view: BacklinkView;
    /** The note in the focused pane, or `undefined` when no note is open. */
    readonly note?: string | undefined;
    readonly onopen: (path: string) => void;
  }

  const { view, note, onopen }: Props = $props();

  // why: `$effect` rather than `$derived`. Fetching is not a derivation — it is what has to
  // happen when the note changes — and `BacklinkView.show` is idempotent for the note it is
  // already showing, so this settles rather than looping.
  $effect(() => {
    view.show(note);
  });

  const total = $derived(
    view.sources.reduce((count, source) => count + source.links.length, 0),
  );
  const mentioned = $derived(
    view.mentions.reduce((count, mention) => count + mention.contexts.length, 0),
  );
</script>

<div class="backlinks-panel">
  <h2 class="tree-heading" id="backlinks-heading">
    Backlinks{#if total > 0}<span class="backlinks-count">{total}</span>{/if}
  </h2>

  {#if note === undefined}
    <p class="tree-empty">Open a note to see what links to it.</p>
  {:else if view.loading}
    <p class="tree-empty">Looking for backlinks…</p>
  {:else if view.unavailable}
    <!-- Deliberately not "no backlinks": the server did not answer, and saying there are
         none would be a statement nobody checked. -->
    <p class="tree-empty">Backlinks are unavailable for this note.</p>
  {:else if view.empty}
    <p class="tree-empty">Nothing links here yet.</p>
  {:else}
    <ul class="backlink-list" aria-labelledby="backlinks-heading">
      {#each view.sources as source (source.path)}
        <li class="backlink-source">
          <button
            type="button"
            class="tree-row backlink-row"
            data-path={source.path}
            onclick={() => onopen(source.path)}
          >
            <span class="tree-icon" aria-hidden="true">↩</span>
            <span class="tree-label">{sourceLabel(source)}</span>
            {#if source.links.length > 1}
              <span class="backlinks-count">{source.links.length}</span>
            {/if}
          </button>
          <ul class="backlink-contexts">
            {#each source.links as link, index (index)}
              <li class="backlink-context">
                {#if link.embed}
                  <!-- A transclusion is an inbound link *and* a copy of this note on that
                       page (§9.2), which is worth telling apart from a mention. -->
                  <span class="backlink-badge">embed</span>
                {/if}
                {#if link.anchorKind !== "none" && link.anchor !== null}
                  <span class="backlink-badge"
                    >{link.anchorKind === "block" ? "^" : "#"}{link.anchor}</span
                  >
                {/if}
                <span class="backlink-text">{link.context ?? "—"}</span>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- No section at all when nothing mentions the note: unlike "nothing links here", a
       reader has not asked a question that an empty list would be the answer to. The
       section is also absent while loading and after a refusal, for which the message
       above already speaks for the whole panel. -->
  {#if note !== undefined && !view.loading && !view.unavailable && view.mentions.length > 0}
    <h2 class="tree-heading mentions-heading" id="mentions-heading">
      Unlinked mentions<span class="backlinks-count">{mentioned}</span>
    </h2>
    <ul class="backlink-list mention-list" aria-labelledby="mentions-heading">
      {#each view.mentions as mention (mention.path)}
        <li class="backlink-source">
          <button
            type="button"
            class="tree-row mention-row"
            data-path={mention.path}
            onclick={() => onopen(mention.path)}
          >
            <span class="tree-icon" aria-hidden="true">≈</span>
            <span class="tree-label">{sourceLabel(mention)}</span>
            {#if mention.contexts.length > 1}
              <span class="backlinks-count">{mention.contexts.length}</span>
            {/if}
          </button>
          <ul class="backlink-contexts">
            {#each mention.contexts as context, index (index)}
              <li class="backlink-context">
                <span class="backlink-text">{context}</span>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</div>
