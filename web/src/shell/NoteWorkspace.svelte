<!--
  The note workspace, as it stands before the split/tab layout lands (`SPEC.md` §8).

  Presentational, per `AGENTS.md` §4.4: the markup is here and every piece of logic is in a
  plain module beside it. The single `$effect` is not a modelling mistake — the editor, its
  Y.Doc and its socket are objects with lifecycles rather than values to derive, and this is
  exactly the case `$effect` exists for. What it must do is clean up, which is why the
  teardown path is written out rather than assumed.
-->
<script lang="ts">
  import type { NoteBootstrap } from "./bootstrap.js";
  import { type NoteSurface, openNoteSurface } from "./note-surface.js";

  interface Props {
    /** What the server said this page is, or `undefined` for a local-only replica. */
    readonly bootstrap?: NoteBootstrap | undefined;
    /** Injectable so a test can open a note without a real editor or a real socket. */
    readonly open?: typeof openNoteSurface;
  }

  const { bootstrap, open = openNoteSurface }: Props = $props();

  let surface = $state<HTMLElement | undefined>(undefined);
  let panel = $state<HTMLElement | undefined>(undefined);
  let status = $state<HTMLElement | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);

  const title = $derived(bootstrap?.note ?? "Scratch note");

  $effect(() => {
    if (surface === undefined || panel === undefined || status === undefined) return;
    // Read once, so the effect does not re-run because a child element was re-bound.
    const elements = { surface, panel, status };

    let live = true;
    let opened: NoteSurface | undefined;
    void open({ ...elements, bootstrap })
      .then((result) => {
        // why: the pane can be closed while `startNoteEditor` is still awaiting IndexedDB.
        // Without this the editor mounts into a detached element and its socket stays open —
        // a leak that only shows up under fast tab switching, which is normal use.
        if (!live) {
          void result.destroy();
          return;
        }
        opened = result;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : "the note could not be opened";
      });

    return () => {
      live = false;
      // Not awaited: Svelte's cleanup is synchronous, and nothing here needs to know when
      // the socket finally closed. A layout swapping two panes on the same note does, which
      // is why `destroy` returns a promise at all.
      void opened?.destroy();
      opened = undefined;
    };
  });
</script>

<main class="workspace">
  <header class="workspace-header">
    <p class="eyebrow">Memberberry</p>
    <h1>{title}</h1>
    <p class="lede">Local-first editing. Changes are persisted in this browser.</p>
  </header>

  <section class="editor-panel" aria-label="Note editor" bind:this={panel}>
    <div id="editor" class="editor-surface" bind:this={surface}></div>
  </section>

  {#if failure === undefined}
    <p class="offline-status" role="status" bind:this={status}>
      Local replica ready.
    </p>
  {:else}
    <p class="offline-status" role="alert" bind:this={status}>
      This note could not be opened: {failure}
    </p>
  {/if}
</main>
