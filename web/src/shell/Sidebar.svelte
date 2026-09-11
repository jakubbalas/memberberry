<!--
  One side panel (`SPEC.md` §8.2).

  A labelled, collapsible, keyboard-reachable region and nothing else: what goes *in* it is
  the panes the workspace renders as children, and the panel's job is to give them one
  scrolling column, one set of spacing rules and one account footer so that two panels in one
  sidebar do not read as two applications.

  **The toggle is not here.** It used to be, immediately above the collapsible region, which
  made every panel start with a full-width text button and gave the window two competing
  pieces of chrome before any content. It now lives in the top bar (`TopBar.svelte`) — still
  outside the region it controls, for the original reason: a control inside a collapsible
  region vanishes when the region collapses, and a keyboard user cannot get it back.

  What this element still owns is `id` and `hidden`: the top bar's button points at this `id`
  with `aria-controls`, and `hidden` is what actually collapses the panel.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    readonly side: "left" | "right";
    readonly label: string;
    readonly collapsed: boolean;
    /** The panes rendered inside the panel. */
    readonly children?: Snippet;
    /** View controls kept reachable while the panel body scrolls. */
    readonly controls?: Snippet;
    /** The authenticated username shown in the account footer. Left panel only. */
    readonly user?: string | undefined;
    /** Named for the reader: which milestone fills this, per SPEC §23. */
    readonly awaiting?: string;
  }

  const { side, label, collapsed, children, controls, awaiting, user }: Props = $props();

  const id = $derived(`sidebar-${side}`);
  /** One letter, as a stand-in for a portrait this application will never fetch (C1). */
  const monogram = $derived((user ?? "").trim().slice(0, 1).toUpperCase());
</script>

<div class="sidebar-frame" data-side={side} data-collapsed={collapsed}>
  <aside {id} class="sidebar" aria-label={label} hidden={collapsed}>
    {#if controls}
      {@render controls()}
    {/if}
    <div class="sidebar-body">
      {#if children}
        {@render children()}
      {:else}
        <p class="sidebar-placeholder">
          {label} arrives with {awaiting ?? "a later milestone"}.
        </p>
      {/if}
    </div>

    {#if side === "left" && user !== undefined}
      <!-- Pinned to the bottom of the panel rather than scrolling with the panes: who you
           are signed in as, and the way out, are the two things that must not require
           scrolling a note tree to find. -->
      <div class="sidebar-account">
        <span class="sidebar-monogram" aria-hidden="true">{monogram}</span>
        <span class="account-user">{user}</span>
        <a class="account-logout" href="/logout">Log out</a>
      </div>
    {/if}
  </aside>
</div>
