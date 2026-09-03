<!--
  The desktop workspace shell (`SPEC.md` §8.2).

  Left sidebar, a main area of recursive splits and tab groups, right sidebar. One state model
  drives it (§8.1) and the same model drives the mobile layout, which renders only the active
  leaf — so nothing here is desktop-specific except the CSS and the fact that it draws the
  whole tree.

  The pane commands live on this element rather than on `window`: a global keydown handler in
  a page that contains a text editor intercepts keystrokes meant for the document, and the
  editor is the thing this shell exists to hold.
-->
<script lang="ts">
  import MobileMain from "./MobileMain.svelte";
  import PaneTree from "./PaneTree.svelte";
  import Sidebar from "./Sidebar.svelte";
  import type { NoteBootstrap } from "./bootstrap.js";
  import { type SwipeStart, swipeProgress, swipeStart } from "./gestures.js";
  import { type LayoutMode, currentLayoutMode, splitLimitFor, watchLayoutMode } from "./layout.js";
  import type { openNoteSurface } from "./note-surface.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import { groups } from "./workspace.js";

  interface Props {
    readonly store: WorkspaceStore;
    readonly session?: Pick<NoteBootstrap, "vault" | "user"> | undefined;
    /** Injectable so a layout test can render panes without editors or sockets. */
    readonly open?: typeof openNoteSurface | undefined;
    /** Injectable for tests; defaults to `localStorage`. */
    readonly chrome?: Pick<Storage, "getItem" | "setItem"> | undefined;
    /** Where the shell listens for its commands. Injectable so a test need not use `window`. */
    readonly target?: EventTarget | undefined;
    /** Which layout to render. Injectable for tests; otherwise watched from the viewport. */
    readonly mode?: LayoutMode | undefined;
  }

  const { store, session, open, chrome, target, mode }: Props = $props();

  // Seeded synchronously, then kept current by the watcher. Starting from a default and
  // waiting for the effect meant the first render used the wrong layout — see
  // `currentLayoutMode` for what that cost.
  let watched = $state<LayoutMode>(currentLayoutMode());
  $effect(() => watchLayoutMode({ onChange: (next) => (watched = next) }));

  /** §8.2 and §8.3, decided in one place (`layout.ts`) so the CSS and the components agree. */
  const layout = $derived(mode ?? watched);
  const narrowViewport = $derived(layout === "mobile");

  /**
   * Sidebar collapse, kept in `localStorage` rather than in the persisted workspace.
   *
   * why: the workspace model is the *document* layout — which notes are open, in which panes.
   * Whether the chrome around it is showing is a different kind of state: users want it
   * consistent across vaults, not restored per vault, and putting it in the pane tree would
   * mean a format change for something that does not travel with the panes.
   */
  const COLLAPSE_KEY = "memberberry.sidebars";

  const preferences = $derived(
    chrome ?? (typeof localStorage === "undefined" ? undefined : localStorage),
  );

  /**
   * Sidebars start closed on a narrow viewport.
   *
   * why: below the §8.3 breakpoint a sidebar is a drawer over the content, and a drawer open
   * on arrival covers the note and swallows taps meant for the content beneath it. On a wide
   * viewport they sit beside the content and start open.
   */
  function readCollapsed(): { left: boolean; right: boolean } {
    const byDefault = { left: narrowViewport, right: narrowViewport };
    try {
      const raw = preferences?.getItem(COLLAPSE_KEY);
      if (raw === null || raw === undefined) return byDefault;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return byDefault;
      const record = parsed as Record<string, unknown>;
      return { left: record["left"] === true, right: record["right"] === true };
    } catch {
      // A corrupt preference costs the user nothing worth recovering.
      return byDefault;
    }
  }

  let collapsed = $state(readCollapsed());

  function toggle(side: "left" | "right"): void {
    collapsed = { ...collapsed, [side]: !collapsed[side] };
    try {
      preferences?.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // A full or blocked storage must not stop the sidebar from moving.
    }
  }

  const panes = $derived(groups(store.current.root).map((group) => group.id));

  /**
   * §8.3: the tablet gets the desktop layout with at most one split, and mobile none at all.
   *
   * Enforced at the call site rather than in the model: the model is layout-agnostic on
   * purpose, and "how many panes fit" is a fact about the viewport, not about the workspace.
   * A layout restored from a wider device keeps its panes — they are simply not added to.
   */
  const splitLimit = $derived(splitLimitFor(layout));
  const canSplit = $derived(panes.length <= splitLimit);

  /** The edge swipes that open the drawers (§8.3). */
  let swipe = $state<SwipeStart | undefined>(undefined);

  function onpointerdown(event: PointerEvent): void {
    if (!narrowViewport) return;
    swipe = swipeStart(event, { width: window.innerWidth });
  }

  function onpointermove(event: PointerEvent): void {
    const started = swipe;
    if (started === undefined) return;
    const result = swipeProgress(started, event, { width: window.innerWidth });
    if (result.kind === "pending") return;
    swipe = undefined;
    if (result.kind === "open") collapsed = { ...collapsed, [result.edge]: false };
  }

  function endSwipe(): void {
    swipe = undefined;
  }

  /**
   * The pane-level keyboard commands (§8.4).
   *
   * Only two, and both chosen because the editor does not want them. **`Cmd/Ctrl-B` is not
   * one of them**: it is bold, in an application whose main content is a rich text editor,
   * and a shell that steals it is a shell that broke the editor. The sidebars are toggled by
   * their own buttons, which are focusable and therefore already satisfy §8.4 — a *shortcut*
   * is a convenience, and remappable ones are their own milestone item.
   *
   * On `window` rather than on the shell element: a `div` cannot hold focus, so a handler
   * bound to it only fires once the user has clicked into something. Nothing here calls
   * `preventDefault` on a combination it does not handle, so the editor keeps everything else.
   */
  function onkeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey)) return;

    // Cmd/Ctrl-\\ splits beside, Cmd/Ctrl-Shift-\\ splits below — the shape most editors use.
    if (event.key === "\\") {
      event.preventDefault();
      if (!canSplit) return;
      store.split(store.focusedGroup, event.shiftKey ? "horizontal" : "vertical");
      return;
    }
    // Cmd/Ctrl-W closes the note's tab, not the browser's: inside a workspace that is what
    // the user means.
    if (event.key === "w") {
      const active = store.activeTab;
      if (active === undefined) return;
      event.preventDefault();
      store.close(active.id);
    }
  }

  $effect(() => {
    const host = target ?? window;
    host.addEventListener("keydown", onkeydown as EventListener);
    return () => host.removeEventListener("keydown", onkeydown as EventListener);
  });
</script>

<div
  class="workspace-shell"
  role="application"
  aria-label="Memberberry workspace"
  data-layout={layout}
  {onpointerdown}
  {onpointermove}
  onpointerup={endSwipe}
  onpointercancel={endSwipe}
>
  <Sidebar
    side="left"
    label="Navigation"
    collapsed={collapsed.left}
    ontoggle={() => toggle("left")}
    awaiting="the note tree in M7 and search in M9"
  />

  <main class="workspace-main" aria-label="Open notes">
    {#if layout === "mobile"}
      <MobileMain {store} {session} {open} />
    {:else}
      <PaneTree node={store.current.root} {store} {panes} {session} {open} />
    {/if}
  </main>

  <Sidebar
    side="right"
    label="Context"
    collapsed={collapsed.right}
    ontoggle={() => toggle("right")}
    awaiting="backlinks and the outline in M8"
  />
</div>
