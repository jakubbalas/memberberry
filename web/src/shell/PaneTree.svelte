<!--
  The recursive pane renderer (`SPEC.md` §8.1, §8.2).

  A `SplitNode` becomes two children with a divider between them; a `TabGroup` becomes a tab
  strip and one editor. The component imports itself, which is exactly the shape of the model
  it draws.

  It defends against nothing. `workspaceProblems` guarantees no pane inside a split is empty
  and every group's active tab is its own, and the store refuses any mutation that would
  break that — so this can render the tree it is given rather than checking it first. That is
  what the invariants are for.
-->
<script lang="ts">
  import Breadcrumbs from "./Breadcrumbs.svelte";
  import NotePane from "./NotePane.svelte";
  import PaneTree from "./PaneTree.svelte";
  import SplitDivider from "./SplitDivider.svelte";
  import TabStrip from "./TabStrip.svelte";
  import type { NoteBootstrap } from "./bootstrap.js";
  import type { openNoteSurface, TaskEditAction } from "./note-surface.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import type { GroupId, WorkspaceNode } from "./workspace.js";
  import type { DailyView } from "./daily.svelte.js";

  interface Props {
    readonly node: WorkspaceNode;
    readonly store: WorkspaceStore;
    readonly panes: readonly GroupId[];
    readonly session?: Pick<NoteBootstrap, "vault" | "user"> | undefined;
    readonly open?: typeof openNoteSurface | undefined;
    /** A note's title, for the breadcrumbs each pane draws. */
    readonly titleOf?: ((path: string) => string | null) | undefined;
    readonly iconOf?: ((path: string) => string | null | undefined) | undefined;
    readonly taskEdit?: { readonly path: string; readonly ordinal: number; readonly action: TaskEditAction } | undefined;
    readonly daily?: DailyView | undefined;
  }

  const { node, store, panes, session, open, titleOf, iconOf, taskEdit, daily }: Props = $props();

  /** The split's own box, which the divider measures a pointer position against. */
  let container = $state<HTMLElement | undefined>(undefined);

  function editFor(path: string | undefined): { readonly ordinal: number; readonly action: TaskEditAction } | undefined {
    if (taskEdit === undefined || path === undefined || taskEdit.path !== path) return undefined;
    return { ordinal: taskEdit.ordinal, action: taskEdit.action };
  }
</script>

{#if node.kind === "group"}
  {@const active = node.tabs.find((tab) => tab.id === node.activeTab)}
  <!--
    Focus follows the pointer into a pane, so "open in this pane" and the split commands act
    on the one being looked at. `focusin` rather than `click`: tabbing into the editor has to
    count too, or a keyboard user's commands land in whichever pane the mouse last touched.
  -->
  <div
    class="pane"
    data-focused={node.id === store.focusedGroup}
    onfocusin={() => store.focus(node.id)}
    onpointerdown={() => store.focus(node.id)}
    role="group"
    aria-label="Note pane"
  >
    <TabStrip
      group={node}
      {panes}
      focused={node.id === store.focusedGroup}
      onactivate={(tab) => store.activate(tab)}
      onclose={(tab) => store.close(tab)}
      onmove={(tab, toGroup, index) => store.move(tab, toGroup, index)}
      {iconOf}
    />
    <Breadcrumbs
      path={active?.note}
      title={active === undefined ? undefined : titleOf?.(active.note)}
      icon={active === undefined ? undefined : iconOf?.(active.note)}
    />
    <NotePane
      tab={active}
      {session}
      {open}
      onscroll={active === undefined
        ? undefined
        : (scroll) => store.setScroll(active.id, scroll)}
      taskEdit={editFor(active?.note)}
      {daily}
      ondailyopen={(path) => store.open(path)}
    />
  </div>
{:else}
  <div
    class="pane-split"
    data-direction={node.direction}
    style={`--split-ratio: ${node.ratio}`}
    bind:this={container}
  >
    <div class="pane-split-side">
      <PaneTree node={node.first} {store} {panes} {session} {open} {titleOf} {iconOf} {taskEdit} {daily} />
    </div>
    <SplitDivider
      split={node}
      {container}
      onresize={(ratio) => store.resize(node.id, ratio)}
    />
    <div class="pane-split-side">
      <PaneTree node={node.second} {store} {panes} {session} {open} {titleOf} {iconOf} {taskEdit} {daily} />
    </div>
  </div>
{/if}
