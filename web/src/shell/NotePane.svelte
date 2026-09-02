<!--
  One pane, showing one tab (`SPEC.md` §8.2).

  **Only the active tab of a pane holds an editor.** An inactive tab is a row in the strip
  and a scroll offset in the model, nothing more. That is a memory decision rather than a
  simplification: an editor is a Tiptap instance, a Y.Doc and a socket subscription, and
  §21.2 budgets 250 MB for a whole 10k-note vault on a phone. Four open panes should cost
  four editors, not four times the number of tabs.

  The `{#key}` is what makes navigation correct. Following a wikilink changes the tab's note,
  and an editor cannot be re-pointed at a different document — so the pane is torn down and
  rebuilt, which is also what restores the right scroll offset.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import type { NoteBootstrap } from "./bootstrap.js";
  import { type NoteSurface, openNoteSurface } from "./note-surface.js";
  import type { Tab } from "./workspace.js";

  interface Props {
    readonly tab: Tab | undefined;
    /** What the server said about this session; the note comes from the tab. */
    readonly session?: Pick<NoteBootstrap, "vault" | "user"> | undefined;
    readonly onscroll?: ((scroll: number) => void) | undefined;
    /** Injectable so a layout test can render panes without editors or sockets. */
    readonly open?: typeof openNoteSurface | undefined;
  }

  const { tab, session, onscroll, open = openNoteSurface }: Props = $props();

  let surface = $state<HTMLElement | undefined>(undefined);
  let panel = $state<HTMLElement | undefined>(undefined);
  let status = $state<HTMLElement | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const bootstrap = $derived(
    session === undefined || tab === undefined
      ? undefined
      : { vault: session.vault, user: session.user, note: tab.note },
  );

  $effect(() => {
    if (tab === undefined) return;
    if (surface === undefined || panel === undefined || status === undefined) return;
    const elements = { surface, panel, status };

    // why: the effect depends on *which* note this pane shows, and nothing else. Reading the
    // whole tab would make it re-run on every mutation of it — including `scroll`, which
    // fires continuously — tearing down and rebuilding the editor mid-keystroke. That is
    // exactly what happened: typing landed at the top of the document because the editor had
    // just been recreated under the cursor. `untrack` is what keeps a *read* from becoming a
    // dependency.
    void tab.id;
    void tab.note;
    const restore = untrack(() => tab.scroll);

    let live = true;
    let opened: NoteSurface | undefined;
    void open({ ...elements, bootstrap: untrack(() => bootstrap) })
      .then((result) => {
        // The pane can be closed, or the tab navigated, while the editor is still restoring
        // from IndexedDB. Dropping the guard leaks an editor on a detached element with its
        // socket open — and under tabs and splits that happens constantly.
        if (!live) {
          void result.destroy();
          return;
        }
        opened = result;
        if (restore > 0) elements.surface.scrollTop = restore;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : "the note could not be opened";
      });

    return () => {
      live = false;
      void opened?.destroy();
      opened = undefined;
    };
  });

  function reportScroll(event: Event): void {
    const element = event.currentTarget;
    if (element instanceof HTMLElement) onscroll?.(element.scrollTop);
  }
</script>

{#if tab === undefined}
  <!-- An empty pane. Reachable: closing the last tab leaves the root pane with nothing. -->
  <div class="note-pane is-empty">
    <p class="note-pane-empty">No note open in this pane.</p>
  </div>
{:else}
  {#key `${tab.id}:${tab.note}`}
    <div class="note-pane">
      <section
        class="editor-panel"
        aria-label={`Note editor: ${tab.note}`}
        bind:this={panel}
      >
        <div
          id="editor"
          class="editor-surface"
          bind:this={surface}
          onscroll={reportScroll}
        ></div>
      </section>
      {#if failure === undefined}
        <p class="offline-status" role="status" bind:this={status}>Local replica ready.</p>
      {:else}
        <p class="offline-status" role="alert" bind:this={status}>
          This note could not be opened: {failure}
        </p>
      {/if}
    </div>
  {/key}
{/if}
