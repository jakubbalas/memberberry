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
  import Icon from "./Icon.svelte";
  import Home from "./Home.svelte";
  import NamePrompt from "./NamePrompt.svelte";
  import { createFolder, fetchFolders } from "./folders.js";
  import Sidebar from "./Sidebar.svelte";
  import TopBar from "./TopBar.svelte";
  import TagPane from "./TagPane.svelte";
  import SearchPane from "./SearchPane.svelte";
  import InboxPane from "./InboxPane.svelte";
  import CalendarPane from "./CalendarPane.svelte";
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
  import type { createNote as createNoteRequest } from "./create.js";
  import { notePathFor, renameNote as renameNoteRequest, type renameTag as renameTagRequest } from "./rename.js";
  import { titleForNoteName } from "./create.js";
  import { TagView } from "./tags.svelte.js";
  import { SearchView } from "./search.svelte.js";
  import { InboxView } from "./tasks.svelte.js";
  import { DailyView } from "./daily.svelte.js";
  import type { TaskEditAction } from "./note-surface.js";
  import type { Platform } from "./hotkeys.js";
  import { type SwipeStart, swipeProgress, swipeStart } from "./gestures.js";
  import { type LayoutMode, currentLayoutMode, watchLayoutMode } from "./layout.js";
  import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "../editor/links.js";
  import { followLink, type resolveNote } from "./open-note.js";
  import type { openNoteSurface } from "./note-surface.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import { groups } from "./workspace.js";
  import SharesPane from "./SharesPane.svelte";
  import { ShareView } from "./shares.js";
  import HistoryPane from "./HistoryPane.svelte";
  import { HistoryView } from "./history.js";
  import TrashPane from "./TrashPane.svelte";
  import { TrashView } from "./trash.js";
  import type { ShippedTheme } from "./theme.js";
  import { requestPalette } from "./palette.js";
  import { detectPlatform, formatBinding, parseBinding } from "./hotkeys.js";
  import { obsidianDefaultBinding } from "./default-keymap.js";

  interface Props {
    /** Shows the vault home until a workspace action opens a note. */
    readonly home?: boolean;
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
    /** The task inbox (§10.3). Supplied by a test; built from the session otherwise. */
    readonly inbox?: InboxView | undefined;
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
    readonly createNote?: typeof createNoteRequest | undefined;
    readonly daily?: DailyView | undefined;
    /** Authenticated public-share management, supplied by a test or built from the session. */
    readonly shares?: ShareView | undefined;
    readonly vaultTheme?: ShippedTheme | undefined;
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
    inbox: suppliedInbox,
    pins: suppliedPins,
    graph: suppliedGraph,
    vaultGraph: suppliedVaultGraph,
    outline: suppliedOutline,
    resolveLink,
    renameNote,
    renameTag,
    createNote,
    daily: suppliedDaily,
    shares: suppliedShares,
    vaultTheme,
    home = false,
  }: Props = $props();

  const vaultSlug = $derived(session?.vault ?? "local-demo");
  const initialWorkspace = untrack(() => store.current);
  const showingHome = $derived(home && store.current === initialWorkspace);
  let emptyFolders = $state<readonly string[]>([]);
  let folderPrompt = $state(false);
  let folderBusy = $state(false);
  let folderError = $state<string | undefined>();
  let folderStatus = $state("");

  async function refreshFolders(): Promise<void> {
    const folders = await fetchFolders(vaultSlug);
    emptyFolders = folders ?? [];
    folderStatus = folders === undefined ? "Empty folders are unavailable." : "";
  }

  $effect(() => {
    if (session !== undefined) void refreshFolders();
  });

  async function submitFolder(typed: string): Promise<void> {
    if (folderBusy) return;
    folderBusy = true;
    folderError = undefined;
    const result = await createFolder(vaultSlug, typed.trim());
    folderBusy = false;
    if ("refused" in result) {
      folderError = result.refused;
      return;
    }
    folderPrompt = false;
    navigationView = "Notes";
    await refreshFolders();
  }

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
  const inbox = untrack(
    () => suppliedInbox ?? new InboxView({ vault: session?.vault ?? "local-demo" }),
  );
  const daily = untrack(
    () => suppliedDaily ?? new DailyView({ vault: session?.vault ?? "local-demo" }),
  );
  const search = untrack(() => new SearchView({ vault: session?.vault ?? "local-demo" }));
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
  let taskEdit = $state<{ readonly path: string; readonly ordinal: number; readonly action: TaskEditAction } | undefined>(undefined);

  function editTask(path: string, ordinal: number, action: TaskEditAction): void {
    taskEdit = { path, ordinal, action };
    store.open(path);
  }

  function openNavigationNote(path: string, newTab = false): void {
    if (newTab) {
      store.open(path, { reuse: false });
      return;
    }
    // why: Home can show a note already active in a hidden restored tab; opening focuses it
    // while navigating it to the same path would be a no-op.
    if (showingHome) {
      store.open(path);
      return;
    }
    const active = store.activeTab;
    if (active === undefined) store.open(path);
    else store.navigate(active.id, path);
  }

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
  const shares = untrack(() => suppliedShares ?? new ShareView({ vault: session?.vault ?? "local-demo" }));
  const history = untrack(() => new HistoryView({ vault: session?.vault ?? "local-demo" }));
  const trash = untrack(() => new TrashView({ vault: session?.vault ?? "local-demo" }));

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
    const byDefault = { left: narrowViewport, right: home || narrowViewport };
    try {
      const raw = preferences?.getItem(COLLAPSE_KEY);
      if (raw === null || raw === undefined) return byDefault;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return byDefault;
      const record = parsed as Record<string, unknown>;
      return { left: home ? narrowViewport : record["left"] === true, right: home || record["right"] === true };
    } catch {
      // A corrupt preference costs the user nothing worth recovering.
      return byDefault;
    }
  }

  let collapsed = $state(readCollapsed());

  $effect(() => {
    if (!narrowViewport) return;
    collapsed = { left: true, right: true };
  });

  function toggle(side: "left" | "right"): void {
    collapsed = { ...collapsed, [side]: !collapsed[side] };
    try {
      preferences?.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // A full or blocked storage must not stop the sidebar from moving.
    }
  }

  async function deleteFromTree(path: string): Promise<void> {
    if (!globalThis.confirm(`Move ${path} to trash?`)) return;
    if (!await trash.delete(path)) return;
    for (const tab of [...store.tabs]) {
      if (tab.note === path) store.close(tab.id);
    }
    void trash.refresh();
    void catalog.refresh();
  }

  const panes = $derived(groups(store.current.root).map((group) => group.id));

  const titleOf = (path: string): string | null =>
    catalog.notes.find((note) => note.path === path)?.title ?? null;

  const iconOf = (path: string): string | null | undefined =>
    catalog.notes.find((note) => note.path === path)?.icon;

  function untitledTitleFor(path: string): string {
    const folder = path.includes("/") ? `${path.slice(0, path.lastIndexOf("/") + 1)}` : "";
    for (let number = 0; ; number += 1) {
      const title = number === 0 ? "untitled" : `untitled ${number + 1}`;
      const candidate = `${folder}${title}.md`;
      if (!catalog.notes.some((note) => note.path === candidate)) return title;
    }
  }

  async function renameFromTitleNow(path: string, title: string): Promise<void> {
    const next = notePathFor(path, title);
    if (next === undefined) return;
    const result = await (renameNote ?? renameNoteRequest)(vaultSlug, path, next, { title: titleForNoteName(title) });
    if ("refused" in result) return;
    for (const tab of store.tabs) {
      if (tab.note === path) store.navigate(tab.id, result.ok.to);
    }
    void catalog.refresh();
  }

  async function moveFromTree(from: string, to: string): Promise<void> {
    const title = catalog.notes.find((note) => note.path === from)?.title;
    const result = await (renameNote ?? renameNoteRequest)(
      vaultSlug,
      from,
      to,
      title === null || title === undefined ? {} : { title },
    );
    if ("refused" in result) return;
    for (const tab of store.tabs) {
      if (tab.note === from) store.navigate(tab.id, result.ok.to);
    }
    void catalog.refresh();
    void refreshFolders();
  }

  function renameFromTitle(path: string, title: string): void {
    void renameFromTitleNow(path, title);
  }

  const handleTitleChange = (path: string, title: string): string | undefined => {
    if (title.trim() === "") return untitledTitleFor(path);
    renameFromTitle(path, title);
    return undefined;
  };

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
  const navigationViews = [
    { name: "Notes", icon: "note" },
    { name: "Search", icon: "search" },
    { name: "Tags", icon: "tags" },
    { name: "Tasks", icon: "tasks" },
    { name: "Calendar", icon: "calendar" },
  ] as const;
  let navigationView = $state<(typeof navigationViews)[number]["name"]>("Notes");

  function selectNavigationView(name: (typeof navigationViews)[number]["name"]): void {
    navigationView = name;
    if (name === "Tags") void tags.refresh();
  }

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

  /** How the quick switcher's keystroke is written on this platform, for the bar's hint. */
  const findHint = $derived.by(() => {
    const binding = parseBinding(obsidianDefaultBinding("palette.notes"));
    return binding === undefined
      ? undefined
      : formatBinding(binding, platform ?? detectPlatform());
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
  <TopBar
    vault={vaultSlug}
    leftCollapsed={collapsed.left}
    rightCollapsed={collapsed.right}
    ontoggle={toggle}
    onfind={() => requestPalette("notes", target ?? window)}
    {findHint}
    {vaultTheme}
    themeStorage={preferences}
  />

  <Sidebar
    side="left"
    label="Navigation"
    collapsed={collapsed.left}
    user={session?.user}
  >
    {#snippet controls()}
      <div class="navigation-tools" role="group" aria-label="Navigation views">
        {#each navigationViews as view}
          <button
            type="button"
            aria-label={view.name}
            title={view.name}
            aria-pressed={navigationView === view.name}
            aria-controls={`navigation-${view.name.toLowerCase()}`}
            onclick={() => selectNavigationView(view.name)}
          ><Icon name={view.icon} /></button>
        {/each}
      </div>
    {/snippet}
    <section class="navigation-view" id="navigation-search" aria-label="Search" hidden={navigationView !== "Search"}>
      <SearchPane view={search} onopen={openNavigationNote} />
    </section>
    <section class="navigation-view" id="navigation-notes" aria-label="Notes" hidden={navigationView !== "Notes"}>
      <NoteTree
        {catalog}
        {bookmarks}
        {emptyFolders}
        activeNote={showingHome ? undefined : store.activeTab?.note}
        onopen={openNavigationNote}
        ondelete={(path) => void deleteFromTree(path)}
        onmove={(from, to) => void moveFromTree(from, to)}
        oncreate={() => requestPalette("create", target ?? window)}
        onfolder={() => { folderError = undefined; folderPrompt = true; }}
        {target}
      />
      {#if folderStatus}<p class="tree-empty" role="status">{folderStatus}</p>{/if}
      {#if session !== undefined}
        <details class="notebook-section">
          <summary><Icon name="chevron-right" />Share a note</summary>
          <SharesPane view={shares} note={store.activeTab?.note} />
        </details>
      {/if}
    </section>
    <section class="navigation-view" id="navigation-tags" aria-label="Tags" hidden={navigationView !== "Tags"}>
      <TagPane view={tags} onopen={openNavigationNote} />
    </section>
    <section class="navigation-view" id="navigation-tasks" aria-label="Tasks" hidden={navigationView !== "Tasks"}>
      <InboxPane view={inbox} onopen={openNavigationNote} onedit={editTask} />
    </section>
    <section class="navigation-view" id="navigation-calendar" aria-label="Calendar" hidden={navigationView !== "Calendar"}>
      <CalendarPane view={daily} onopen={openNavigationNote} />
    </section>
  </Sidebar>

  <main class="workspace-main" aria-label="Open notes">
    {#if showGraph && vaultGraph !== undefined && GraphPane !== undefined}
      <!-- Over the panes rather than inside one: a graph is a view of the *vault*, and the
           workspace model (§8.1) holds notes in tabs. Recorded in §9.4 with what it costs. -->
      <GraphPane
        view={vaultGraph}
        onopen={(path) => {
          showGraph = false;
          openNavigationNote(path);
        }}
        onclose={() => (showGraph = false)}
      />
    {/if}
    {#if showingHome}
      <Home {catalog} onopen={openNavigationNote} oncreate={() => requestPalette("create", target ?? window)} />
    {:else if layout === "mobile"}
      <MobileMain {store} {session} {open} {titleOf} {iconOf} {taskEdit} {daily} ontitlechange={handleTitleChange} />
    {:else}
      <PaneTree node={store.current.root} {store} {panes} {session} {open} {iconOf} {taskEdit} {daily} {target} {titleOf} ontitlechange={handleTitleChange} />
    {/if}
  </main>

  <Sidebar side="right" label="Context" collapsed={collapsed.right}>
    <Outline view={outline} note={store.activeTab?.note} />
    <Backlinks
      view={backlinks}
      note={store.activeTab?.note}
      onopen={openNavigationNote}
    />
    {#if session !== undefined}
      <details class="notebook-section">
        <summary><Icon name="chevron-right" />Note history</summary>
        <HistoryPane view={history} note={store.activeTab?.note} />
      </details>
      <details class="notebook-section">
        <summary><Icon name="chevron-right" />Deleted notes</summary>
      <TrashPane
        view={trash}
        note={store.activeTab?.note}
        ondeleted={() => {
          const active = store.activeTab;
          if (active !== undefined) store.close(active.id);
        }}
      />
      </details>
    {/if}
    <LocalGraph view={graph} note={store.activeTab?.note} onopen={openNavigationNote} />
  </Sidebar>
</div>

{#if folderPrompt}
  <NamePrompt open={folderPrompt} title="New folder" subject="At the vault root. Use / for nested folders." label="Folder name" initial="" busy={folderBusy} error={folderError} confirm="Create folder" confirming="Creating…" onsubmit={(name) => void submitFolder(name)} ondismiss={() => { if (!folderBusy) folderPrompt = false; }} />
{/if}

<!-- Outside the shell element: the palettes are modal dialogs over the whole page, and the
     hotkeys they register have to work wherever focus is. -->
<CommandCenter
  {store}
  {catalog}
  {tags}
  {pins}
  {renameNote}
  {renameTag}
  {createNote}
  vault={vaultSlug}
  {layout}
  {target}
  {chrome}
  {platform}
  {loadVaults}
  {onvault}
  {daily}
  user={session?.user}
  ongraph={() => void openGraph()}
/>
