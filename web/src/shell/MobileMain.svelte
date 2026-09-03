<!--
  The mobile main area (`SPEC.md` §8.3).

  **One active document.** The whole pane tree still exists in state — that is what lets the
  same workspace open on a phone and a 32" monitor and mean the same thing — but only the
  active leaf renders. An unrendered pane is not merely hidden: it holds no editor, no Y.Doc
  and no socket, which is the difference between a phone-sized memory budget and a laptop one
  (§21.2).

  Beneath it sits a bar with back, forward and the tab switcher. §8.3 asks for back/forward
  *gestures*; see `Workspace.svelte` for why they are buttons here and edge swipes belong to
  the drawers instead.
-->
<script lang="ts">
  import NotePane from "./NotePane.svelte";
  import TabSheet from "./TabSheet.svelte";
  import type { NoteBootstrap } from "./bootstrap.js";
  import type { openNoteSurface } from "./note-surface.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import { canGoBack, canGoForward } from "./workspace.js";

  interface Props {
    readonly store: WorkspaceStore;
    readonly session?: Pick<NoteBootstrap, "vault" | "user"> | undefined;
    readonly open?: typeof openNoteSurface | undefined;
  }

  const { store, session, open }: Props = $props();

  let sheetOpen = $state(false);

  const active = $derived(store.activeTab);
  const back = $derived(active !== undefined && canGoBack(active));
  const forward = $derived(active !== undefined && canGoForward(active));
</script>

<div class="mobile-main">
  <NotePane
    tab={active}
    {session}
    {open}
    onscroll={active === undefined ? undefined : (scroll) => store.setScroll(active.id, scroll)}
  />

  <nav class="mobile-bar" aria-label="Navigation">
    <button
      type="button"
      class="mobile-bar-button"
      aria-label="Back"
      disabled={!back}
      onclick={() => {
        if (active !== undefined) store.back(active.id);
      }}
    >
      ‹
    </button>
    <button
      type="button"
      class="mobile-bar-button"
      aria-label="Forward"
      disabled={!forward}
      onclick={() => {
        if (active !== undefined) store.forward(active.id);
      }}
    >
      ›
    </button>

    <button
      type="button"
      class="mobile-bar-tabs"
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      onclick={() => {
        sheetOpen = true;
      }}
    >
      <span class="mobile-bar-count">{store.tabs.length}</span>
      <span class="mobile-bar-note">{active?.note.split("/").pop() ?? "No note open"}</span>
    </button>
  </nav>
</div>

<TabSheet
  open={sheetOpen}
  tabs={store.tabs}
  activeTab={active?.id}
  onactivate={(tab) => {
    store.activate(tab);
    sheetOpen = false;
  }}
  onclose={(tab) => store.close(tab)}
  ondismiss={() => {
    sheetOpen = false;
  }}
/>
