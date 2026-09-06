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
  import { untrack } from "svelte";

  import Backlinks from "./Backlinks.svelte";
  import CommandCenter from "./CommandCenter.svelte";
  import MobileMain from "./MobileMain.svelte";
  import LocalGraph from "./LocalGraph.svelte";
  import NoteTree from "./NoteTree.svelte";
  import Outline from "./Outline.svelte";
  import PaneTree from "./PaneTree.svelte";
  import Sidebar from "./Sidebar.svelte";
  import TagPane from "./TagPane.svelte";
  import { BacklinkView } from "./backlinks.svelte.js";
  import { GraphView } from "./graph.svelte.js";
  import type { VaultGraphView } from "./vault-graph.svelte.js";

  /** The lazily imported graph pane, held as a value so it can be rendered when it lands. */
  type GlobalGraphComponent = typeof import("./GlobalGraph.svelte").default;
  import { Bookmarks } from "./bookmarks.svelte.js";
  import type { NoteBootstrap } from "./bootstrap.js";
  import type { fetchVaults } from "./catalog.js";
  import { NoteCatalog } from "./note-catalog.svelte.js";
  import { PinnedNotes } from "./pins.svelte.js";
  import { OUTLINE_EVENT, type OutlineDetail } from "../editor/outline.js";
  import { fromVisiblePane } from "./outline.js";
  import { OutlineView } from "./outline.svelte.js";
  import type { renameNote as renameNoteRequest, renameTag as renameTagRequest } from "./rename.js";
  import { TagView } from "./tags.svelte.js";
  import type { Platform } from "./hotkeys.js";
  import { type SwipeStart, swipeProgress, swipeStart } from "./gestures.js";
  import { type LayoutMode, currentLayoutMode, watchLayoutMode } from "./layout.js";
  import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "../editor/links.js";
  import { followLink, type resolveNote } from "./open-note.js";
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
    /**
     * Passed to `CommandCenter`, so a test can supply its own lists and navigation.
     *
     * Named rather than spread from a bag: a `Record<string, unknown>` forwarded into a typed
     * component silently accepts a misspelled prop, which is exactly the class of mistake
     * §4.3 exists to prevent — and one this codebase has already made once, with `narrow`.
     */
    /** Which modifier `Mod` means; tests pin it so they do not depend on the runner. */
    readonly platform?: Platform | undefined;
    readonly loadVaults?: typeof fetchVaults | undefined;
    readonly onvault?: ((slug: string) => void) | undefined;
    /** The note list and bookmarks. Supplied by a test; built from the session otherwise. */
    readonly catalog?: NoteCatalog | undefined;
    readonly bookmarks?: Bookmarks | undefined;
    /** The backlinks of the focused note. Supplied by a test; built from the session otherwise. */
    readonly backlinks?: BacklinkView | undefined;
    /** The vault's tags. Supplied by a test; built from the session otherwise. */
    readonly tags?: TagView | undefined;
    /** The notes kept offline (§7.2). Supplied by a test; built from the session otherwise. */
    readonly pins?: PinnedNotes | undefined;
    /** The focused note's neighbourhood. Supplied by a test; built from the session otherwise. */
    readonly graph?: GraphView | undefined;
    /** The whole-vault graph (§9.4). Injectable for tests, like the panels above. */
    readonly vaultGraph?: VaultGraphView | undefined;
    /** The open note's headings. Supplied by a test; built here otherwise. */
    readonly outline?: OutlineView | undefined;
    /** How a wikilink is resolved to a note. Injectable so a test needs no server. */
    readonly resolveLink?: typeof resolveNote | undefined;
    /** How a rename is sent (§6.6). Injectable so a test needs no server. */
    readonly renameNote?: typeof renameNoteRequest | undefined;
    readonly renameTag?: typeof renameTagRequest | undefined;
  }

  const {
    store,
    session,
    open,
    chrome,
    target,
    mode,
    platform,
    loadVaults,
    onvault,
    catalog: suppliedCatalog,
    bookmarks: suppliedBookmarks,
    backlinks: suppliedBacklinks,
    tags: suppliedTags,
    pins: suppliedPins,
    graph: suppliedGraph,
    vaultGraph: suppliedVaultGraph,
    outline: suppliedOutline,
    resolveLink,
    renameNote,
    renameTag,
  }: Props = $props();

  const vaultSlug = $derived(session?.vault ?? "local-demo");

  /**
   * Built once, from the session as it was at mount.
   *
   * why: `untrack`, and why that is safe. Both hold fetched state, so rebuilding either would
   * refetch the largest payload the shell asks for on every render. Reading `session` without
   * tracking it is only correct because the session cannot change under a mounted shell —
   * switching vaults is a full navigation (see `CommandCenter`), precisely so the ACL, the
   * note index and the layout are all handed over fresh by the server.
   */
  const catalog = untrack(
    () => suppliedCatalog ?? new NoteCatalog({ vault: session?.vault ?? "local-demo" }),
  );
  const bookmarks = untrack(
    () => suppliedBookmarks ?? new Bookmarks({ vault: session?.vault ?? "local-demo" }),
  );
  const backlinks = untrack(
    () => suppliedBacklinks ?? new BacklinkView({ vault: session?.vault ?? "local-demo" }),
  );
  const tags = untrack(
    () => suppliedTags ?? new TagView({ vault: session?.vault ?? "local-demo" }),
  );
  const graph = untrack(
    () => suppliedGraph ?? new GraphView({ vault: session?.vault ?? "local-demo" }),
  );
  // Only for a vault a server bootstrapped: pinning a note on a local-only replica would be
  // asking to keep offline the one document that is already nowhere else (§7.2).
  const pins = untrack(() =>
    session === undefined ? undefined : (suppliedPins ?? new PinnedNotes({ vault: session.vault })),
  );
  // At mount rather than when the palette opens: the pin command is a toggle whose *wording*
  // depends on this, and one that appeared a frame after the list was first read would pop
  // into a palette somebody is already looking at. It is one read of a local store.
  $effect(() => {
    pins?.ensure();
  });
  /**
   * The graph, loaded the first time somebody asks for it.
   *
   * why: a dynamic import. The renderer, the force layout, the quadtree and the filters are
   * the largest thing in the shell and most sessions never open the graph, so putting them
   * on the critical path would spend §21.1's already-breached bundle budget on a feature
   * behind a command. The worker is a chunk of its own for the same reason.
   *
   * The mobile cap is decided once, here: §9.4 caps a phone to the top N nodes by degree, and
   * which device this is cannot change under a mounted shell any more than the session can.
   */
  let vaultGraph = $state<VaultGraphView | undefined>(untrack(() => suppliedVaultGraph));
  let GraphPane = $state<GlobalGraphComponent | undefined>();
  let showGraph = $state(false);

  async function openGraph(): Promise<void> {
    const [pane, state, wire] = await Promise.all([
      import("./GlobalGraph.svelte"),
      import("./vault-graph.svelte.js"),
      import("./vault-graph.js"),
    ]);
    GraphPane = pane.default;
    vaultGraph ??= new state.VaultGraphView({
      vault: session?.vault ?? "local-demo",
      ...(currentLayoutMode() === "mobile" ? { limit: wire.MOBILE_NODE_CAP } : {}),
    });
    showGraph = true;
  }
  // Fetches nothing, so unlike the three above it costs nothing to build and needs no
  // session: the headings arrive from whichever editor is mounted.
  const outline = untrack(() => suppliedOutline ?? new OutlineView());

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
   * A note's title, for the breadcrumbs a pane draws.
   *
   * Passed as a function rather than handing the catalog down: a pane needs one string, not
   * the whole index, and the layout components have no other reason to know what a catalog is.
   */
  const titleOf = (path: string): string | null =>
    catalog.notes.find((note) => note.path === path)?.title ?? null;

  /**
   * §8.3: the tablet gets the desktop layout with at most one split, and mobile none at all.
   *
   * Enforced at the call site rather than in the model: the model is layout-agnostic on
   * purpose, and "how many panes fit" is a fact about the viewport, not about the workspace.
   * A layout restored from a wider device keeps its panes — they are simply not added to.
   */

  /**
   * Following a link out of a note (§8.2, §9.2).
   *
   * why: one listener here rather than a callback threaded down through `PaneTree` into
   * every pane. The event bubbles out of whichever editor raised it, and the two things
   * needed to place the result — which pane was being read, and whether a split fits — are
   * both known here and nowhere below. Focus follows the pointer into a pane
   * (`PaneTree.svelte`), so the focused group *is* the pane the link was clicked in.
   */
  let shell = $state<HTMLElement | undefined>(undefined);

  $effect(() => {
    const element = shell;
    if (element === undefined) return;
    const aborter = new AbortController();
    const handle = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as OpenNoteDetail;
      const group = store.focusedGroup;
      const pane = store.groups.find((candidate) => candidate.id === group);
      const tab = pane?.tabs.find((candidate) => candidate.id === pane.activeTab);
      if (tab === undefined) return;
      void followLink(
        {
          store,
          group,
          tab: tab.id,
          layout,
          vault: vaultSlug,
          from: tab.note,
          signal: aborter.signal,
          ...(resolveLink === undefined ? {} : { resolve: resolveLink }),
        },
        detail,
      );
    };
    // §9.5: the outline follows the focused pane, so a split's other editor is ignored
    // rather than allowed to overwrite the panel from behind.
    const announce = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      if (!fromVisiblePane(event.target)) return;
      outline.receive(event.detail as OutlineDetail, event.target);
    };
    element.addEventListener(OPEN_NOTE_EVENT, handle);
    element.addEventListener(OUTLINE_EVENT, announce);
    return () => {
      element.removeEventListener(OPEN_NOTE_EVENT, handle);
      element.removeEventListener(OUTLINE_EVENT, announce);
      // A pane closed while a resolution is in flight must not open a tab afterwards.
      aborter.abort();
    };
  });

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

</script>

<div
  class="workspace-shell"
  role="application"
  aria-label="Memberberry workspace"
  data-layout={layout}
  bind:this={shell}
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
    awaiting="search in M9"
  >
    <NoteTree
      {catalog}
      {bookmarks}
      activeNote={store.activeTab?.note}
      onopen={(path) => store.open(path)}
    />
    <TagPane view={tags} onopen={(path) => store.open(path)} />
  </Sidebar>

  <main class="workspace-main" aria-label="Open notes">
    {#if showGraph && vaultGraph !== undefined && GraphPane !== undefined}
      <!-- Over the panes rather than inside one: a graph is a view of the *vault*, and the
           workspace model (§8.1) holds notes in tabs. Recorded in §9.4 with what it costs. -->
      <GraphPane
        view={vaultGraph}
        onopen={(path) => {
          showGraph = false;
          store.open(path);
        }}
        onclose={() => (showGraph = false)}
      />
    {/if}
    {#if layout === "mobile"}
      <MobileMain {store} {session} {open} {titleOf} />
    {:else}
      <PaneTree node={store.current.root} {store} {panes} {session} {open} {titleOf} />
    {/if}
  </main>

  <Sidebar
    side="right"
    label="Context"
    collapsed={collapsed.right}
    ontoggle={() => toggle("right")}
    awaiting="tasks in M14"
  >
    <Outline view={outline} note={store.activeTab?.note} />
    <Backlinks
      view={backlinks}
      note={store.activeTab?.note}
      onopen={(path) => store.open(path)}
    />
    <LocalGraph view={graph} note={store.activeTab?.note} onopen={(path) => store.open(path)} />
  </Sidebar>
</div>

<!-- Outside the shell element: the palettes are modal dialogs over the whole page, and the
     hotkeys they register have to work wherever focus is. -->
<CommandCenter
  {store}
  {catalog}
  {tags}
  {pins}
  {renameNote}
  {renameTag}
  vault={vaultSlug}
  {layout}
  {target}
  {chrome}
  {platform}
  {loadVaults}
  {onvault}
  ongraph={() => void openGraph()}
/>
