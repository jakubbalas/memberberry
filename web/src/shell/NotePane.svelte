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
  import { type NoteSurface, type TaskEditAction, openNoteSurface } from "./note-surface.js";
  import type { Tab } from "./workspace.js";
  import type { DailyView } from "./daily.svelte.js";

  interface Props {
    readonly tab: Tab | undefined;
    /** What the server said about this session; the note comes from the tab. */
    readonly session?: Pick<NoteBootstrap, "vault" | "user"> | undefined;
    readonly onscroll?: ((scroll: number) => void) | undefined;
    /** Injectable so a layout test can render panes without editors or sockets. */
    readonly open?: typeof openNoteSurface | undefined;
    readonly taskEdit?: { readonly ordinal: number; readonly action: TaskEditAction } | undefined;
    readonly daily?: DailyView | undefined;
    readonly ondailyopen?: ((path: string) => void) | undefined;
    readonly ontitlechange?: ((title: string) => string | undefined) | undefined;
  }

  const { tab, session, onscroll, open = openNoteSurface, taskEdit, daily, ondailyopen, ontitlechange }: Props = $props();

  let pane = $state<HTMLElement | undefined>(undefined);
  let surface = $state<HTMLElement | undefined>(undefined);
  let panel = $state<HTMLElement | undefined>(undefined);
  let status = $state<HTMLElement | undefined>(undefined);
  let failure = $state<string | undefined>(undefined);
  let liveSurface = $state<NoteSurface | undefined>(undefined);
  let appliedEdit: object | undefined;

  const bootstrap = $derived(
    session === undefined || tab === undefined
      ? undefined
      : { vault: session.vault, user: session.user, note: tab.note },
  );

  /**
   * The two facts the editor's lifetime depends on, as values rather than as a prop.
   *
   * why: `$derived` of a string, not `tab.id` read inside the effect. The store is immutable,
   * so *every* mutation hands this component a new `tab` object — including `setScroll`,
   * which fires continuously — and an effect that reads a field of the prop re-runs for the
   * new object even when the field is unchanged. Reading through a derived primitive stops
   * there, because a derived whose value is `===` its previous one notifies nobody.
   *
   * That is not a tidiness point. Once scrolling actually reached the store (it did not, see
   * below), the effect tore the editor down and rebuilt it on every scroll event, the rebuild
   * restored the scroll, and the restore scrolled: a loop that mounted dozens of editors a
   * second and left the outline announcing a note that was always at offset zero.
   */
  const editorTab = $derived(tab?.id);
  const editorNote = $derived(tab?.note);
  const previousDaily = $derived(tab === undefined ? undefined : daily?.neighbourForPath(tab.note, -1));
  const nextDaily = $derived(tab === undefined ? undefined : daily?.neighbourForPath(tab.note, 1));

  $effect(() => {
    if (editorTab === undefined || editorNote === undefined) return;
    if (surface === undefined || panel === undefined || status === undefined) return;
    if (pane === undefined) return;
    const elements = { surface, panel, status };
    const scroller = pane;
    const restore = untrack(() => tab?.scroll ?? 0);
    const openSurface = untrack(() => open);
    const titleChange = untrack(() => ontitlechange);

    let live = true;
    let opened: NoteSurface | undefined;
    void openSurface({
      ...elements,
      bootstrap: untrack(() => bootstrap),
      ...(titleChange === undefined ? {} : { onTitleChange: titleChange }),
    })
      .then((result) => {
        // The pane can be closed, or the tab navigated, while the editor is still restoring
        // from IndexedDB. Dropping the guard leaks an editor on a detached element with its
        // socket open — and under tabs and splits that happens constantly.
        if (!live) {
          void result.destroy();
          return;
        }
        opened = result;
        liveSurface = result;
        // why: the pane, not the surface. `.note-pane` is what has `overflow: auto`
        // (`app.css`); the surface inside it never scrolls, so both the restore and the
        // `onscroll` below used to address an element whose `scrollTop` is always 0 — §8.1's
        // per-tab scroll offset was written as 0 and restored as nothing, silently, for two
        // milestones. `e2e/workspace.spec.ts` now switches tabs and looks.
        if (restore > 0) scroller.scrollTop = restore;
      })
      .catch((error: unknown) => {
        failure = error instanceof Error ? error.message : "the note could not be opened";
      });

    return () => {
      live = false;
      void opened?.destroy();
      opened = undefined;
      liveSurface = undefined;
    };
  });

  $effect(() => {
    if (taskEdit === undefined || liveSurface === undefined || appliedEdit === taskEdit) return;
    liveSurface.editTask?.(taskEdit.ordinal, taskEdit.action);
    appliedEdit = taskEdit;
  });

  /**
   * Reports the scroll offset, at most once per frame.
   *
   * A scroll fires many times per frame and each report rebuilds the workspace tree, so the
   * unthrottled version did that work tens of times for one flick of a trackpad. §21.2
   * budgets a sustained 60 fps scroll; this keeps the store off that path.
   */
  let pending = 0;
  function reportScroll(event: Event): void {
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement) || pending !== 0) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      onscroll?.(element.scrollTop);
    });
  }

  $effect(() => () => {
    if (pending !== 0) cancelAnimationFrame(pending);
  });
</script>

{#if tab === undefined}
  <!-- An empty pane. Reachable: closing the last tab leaves the root pane with nothing. -->
  <div class="note-pane is-empty">
    <p class="note-pane-empty">No note open in this pane.</p>
  </div>
{:else}
  {#key `${tab.id}:${tab.note}`}
    <div class="note-pane" bind:this={pane} onscroll={reportScroll}>
      {#if previousDaily !== undefined || nextDaily !== undefined}
        <nav class="daily-navigation" aria-label="Daily note navigation">
          <button type="button" aria-label="Previous day" disabled={previousDaily === undefined} onclick={() => previousDaily && ondailyopen?.(previousDaily.path)}>Previous day</button>
          <button type="button" aria-label="Next day" disabled={nextDaily === undefined} onclick={() => nextDaily && ondailyopen?.(nextDaily.path)}>Next day</button>
        </nav>
      {/if}
      <section
        class="editor-panel"
        aria-label={`Note editor: ${tab.note}`}
        bind:this={panel}
      >
        <div id="editor" class="editor-surface" bind:this={surface}></div>
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
