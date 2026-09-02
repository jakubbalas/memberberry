<!--
  A collapsible sidebar (`SPEC.md` §8.2).

  **Deliberately empty in M7.** Everything §8.2 lists for these panels — note tree, search,
  tags, tasks, bookmarks on the left; backlinks, outline, local graph on the right — belongs
  to M8, M9 and M14. What ships here is the frame: a labelled, collapsible, keyboard-reachable
  region with its state persisted, so those milestones have somewhere to render and do not
  each invent their own chrome.

  The placeholder says which milestone fills it, rather than "coming soon". A reader who
  opens this should be able to tell whether it is unfinished or broken.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    readonly side: "left" | "right";
    readonly label: string;
    readonly collapsed: boolean;
    readonly ontoggle: () => void;
    /** What the sidebar shows once a later milestone has something to put in it. */
    readonly children?: Snippet;
    /** Named for the reader: which milestone fills this, per SPEC §23. */
    readonly awaiting?: string;
  }

  const { side, label, collapsed, ontoggle, children, awaiting }: Props = $props();

  const id = $derived(`sidebar-${side}`);
</script>

<div class="sidebar-frame" data-side={side} data-collapsed={collapsed}>
  <!--
    The toggle lives outside the collapsible region on purpose: inside it, collapsing the
    sidebar would remove the only control that reopens it, which is a trap for a keyboard
    user and an accessibility failure rather than a styling detail.
  -->
  <button
    type="button"
    class="sidebar-toggle"
    aria-expanded={!collapsed}
    aria-controls={id}
    onclick={ontoggle}
  >
    <span class="sidebar-toggle-icon" aria-hidden="true">{side === "left" ? "◧" : "◨"}</span>
    <span class="sidebar-toggle-label">{collapsed ? `Show ${label}` : `Hide ${label}`}</span>
  </button>

  <aside {id} class="sidebar" aria-label={label} hidden={collapsed}>
    {#if children}
      {@render children()}
    {:else}
      <p class="sidebar-placeholder">
        {label} arrives with {awaiting ?? "a later milestone"}.
      </p>
    {/if}
  </aside>
</div>
