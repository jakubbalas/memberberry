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
  import NoteTree from "./NoteTree.svelte";
  import PaneTree from "./PaneTree.svelte";
  import Sidebar from "./Sidebar.svelte";
  import TagPane from "./TagPane.svelte";
  import { BacklinkView } from "./backlinks.svelte.js";
  import { Bookmarks } from "./bookmarks.svelte.js";
  import type { NoteBootstrap } from "./bootstrap.js";
  import type { fetchVaults } from "./catalog.js";
  import { NoteCatalog } from "./note-catalog.svelte.js";
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
    /** How a wikilink is resolved to a note. Injectable so a test needs no server. */
    readonly resolveLink?: typeof resolveNote | undefined;
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
    resolveLink,
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
    element.addEventListener(OPEN_NOTE_EVENT, handle);
    return () => {
      element.removeEventListener(OPEN_NOTE_EVENT, handle);
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
    awaiting="the outline and the local graph in M8"
  >
    <Backlinks
      view={backlinks}
      note={store.activeTab?.note}
      onopen={(path) => store.open(path)}
    />
  </Sidebar>
</div>

<!-- Outside the shell element: the palettes are modal dialogs over the whole page, and the
     hotkeys they register have to work wherever focus is. -->
<CommandCenter
  {store}
  {catalog}
  vault={vaultSlug}
  {layout}
  {target}
  {chrome}
  {platform}
  {loadVaults}
  {onvault}
/>
