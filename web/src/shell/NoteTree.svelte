<!--
  The note tree and bookmark list (`SPEC.md` §8.2).

  A `tree` widget with **one tab stop**, not one per row. Roving `tabindex` plus arrow keys is
  what the role promises and what a screen reader announces; a list where Tab walks through
  four hundred notes is not navigable by anyone.

  Every decision about what a keypress means lives in `tree.ts`, so this component only routes
  the answer. That is what keeps the renderer and the keyboard working from the same list of
  visible rows — walk the tree twice and they disagree the moment a folder closes.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { Bookmarks } from "./bookmarks.svelte.js";
  import type { NoteCatalog } from "./note-catalog.svelte.js";
  import { buildTree, treeKeyAction, visibleRows } from "./tree.js";
  import { requestRename } from "./rename.js";
  import NamePrompt from "./NamePrompt.svelte";
  import { validFolder } from "./folders.js";
  import { readTreeExpansion, writeTreeExpansion, type TreeExpansion } from "./tree-expansion.js";

  interface Props {
    readonly catalog: NoteCatalog;
    readonly bookmarks: Bookmarks;
    /** The note showing in the focused pane, so the tree can mark it. */
    readonly activeNote?: string | undefined;
    readonly onopen: (path: string, newTab?: boolean) => void;
    /** Empty folders already filtered by the server. */
    readonly emptyFolders?: readonly string[];
    /** Opens note creation from the file-list heading. */
    readonly oncreate?: (from: string) => void;
    /** Opens folder creation from the file-list heading. */
    readonly onfolder?: () => void;
    /** Opens a contents view; a folder is never passed to the note editor. */
    readonly onopenfolder?: (path: string) => void;
    readonly showFilenames?: boolean;
    readonly onfilenames?: (show: boolean) => void;
    /** Moves a note to the server-owned trash after confirmation. */
    readonly ondelete?: (path: string) => void;
    /** Moves a note to a vault-relative folder, or to the vault root when empty. */
    readonly onmove?: (from: string, to: string, kind: "note" | "folder") => Promise<string | undefined>;
    readonly target?: EventTarget | undefined;
    readonly expansion?: TreeExpansion;
  }

  const { catalog, bookmarks, activeNote, onopen, emptyFolders = [], oncreate, onfolder, onopenfolder, showFilenames = false, onfilenames, ondelete, onmove, target, expansion }: Props = $props();

  let expanded = $state<ReadonlySet<string>>(new Set());
  let cursor = $state(0);
  let selectionMade = $state(false);
  let context = $state<{ path: string; kind: "note" | "folder"; source: "tree" | "bookmark"; x: number; y: number } | undefined>(undefined);
  let settings = $state<{ x: number; y: number } | undefined>(undefined);
  let treeElement = $state<HTMLDivElement | undefined>(undefined);
  let panel = $state<HTMLDivElement | undefined>(undefined);
  let draggingPath = $state<string | undefined>(undefined);
  let dropFolder = $state<string | undefined>(undefined);
  let moveSubject = $state<string | undefined>(undefined);
  let moveError = $state<string | undefined>(undefined);
  let moveBusy = $state(false);

  $effect(() => {
    expanded = readTreeExpansion(expansion);
  });

  $effect(() => {
    catalog.ensure();
    bookmarks.ensure();
  });

  const tree = $derived(buildTree(catalog.notes, emptyFolders));
  const rows = $derived(visibleRows(tree, expanded));

  /** The bookmark rows, resolved back to their titles so they read like the tree does. */
  const bookmarked = $derived(
    bookmarks.paths.map((path) => {
      const note = catalog.notes.find((candidate) => candidate.path === path);
      return {
        path,
        label: showFilenames ? basename(path) : (note?.title ?? basename(path).replace(/\.md$/, "")),
        conflicts: note?.conflicts ?? 0,
      };
    }),
  );

  function setExpanded(path: string, open: boolean): void {
    const next = new Set(expanded);
    if (open) next.add(path);
    else next.delete(path);
    expanded = next;
    writeTreeExpansion(expansion, expanded);
  }

  function onkeydown(event: KeyboardEvent): void {
    const row = rows[cursor];
    if (row !== undefined && isMenuKey(event)) {
      openContextMenu(event, row.node.path, row.node.kind);
      return;
    }
    if (event.target instanceof HTMLButtonElement) return;
    if (event.key === "F2" && row?.node.kind === "folder") {
      event.preventDefault();
      moveError = undefined;
      moveSubject = row.node.path;
      return;
    }
    const action = treeKeyAction(event.key, rows, cursor);
    if (action.kind === "none") return;
    event.preventDefault();
    selectionMade = true;
    switch (action.kind) {
      case "move":
        cursor = action.to;
        break;
      case "expand":
        setExpanded(action.path, true);
        break;
      case "collapse":
        setExpanded(action.path, false);
        break;
      case "open":
        onopen(action.path);
        break;
    }
  }

  function isMenuKey(event: KeyboardEvent): boolean {
    return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
  }

  function openContextMenu(event: MouseEvent | KeyboardEvent, path: string, kind: "note" | "folder" = "note"): void {
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement)) return;
    const source = element.closest(".bookmark-list") === null ? "tree" : "bookmark";
    if (event.type === "click" && context?.path === path && context.source === source) {
      context = undefined;
      element.focus();
      return;
    }
    settings = undefined;
    if (source === "tree") {
      const index = rows.findIndex((row) => row.node.path === path);
      if (index >= 0) cursor = index;
    }
    // why: right-click need not focus its target, and touch clicks differ across browsers.
    // Restore tree focus for row menus, but the actual button for explicit menu clicks.
    const opener = source === "tree" && !(element instanceof HTMLButtonElement) ? treeElement : element;
    opener?.focus();
    const bounds = (source === "tree" && event instanceof KeyboardEvent ? treeElement?.querySelector<HTMLElement>(`#tree-row-${cursor}`) : element)?.getBoundingClientRect();
    context = {
      path, kind, source,
      x: event.type === "contextmenu" && event instanceof MouseEvent ? event.clientX : bounds?.left ?? 0,
      y: event.type === "contextmenu" && event instanceof MouseEvent ? event.clientY : bounds?.bottom ?? 0,
    };
  }

  function openSettings(event: MouseEvent): void {
    context = undefined;
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
    if (settings !== undefined) { settings = undefined; return; }
    const bounds = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined;
    settings = { x: bounds?.left ?? 0, y: bounds?.bottom ?? 0 };
  }

  function toggleBookmark(): void {
    if (context === undefined) return;
    const removedRow = context.source === "bookmark" && bookmarks.has(context.path);
    bookmarks.toggle(context.path);
    // why: removing a bookmark also removes its menu opener; keep focus in navigation.
    if (removedRow) (treeElement ?? panel)?.focus();
    context = undefined;
  }

  const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
  const label = (row: (typeof rows)[number]): string =>
    row.node.kind === "note" ? (showFilenames ? basename(row.node.path) : row.node.title ?? row.node.name) : row.node.name;

  const icon = (row: (typeof rows)[number]): string | undefined =>
    row.node.kind === "note" && row.node.icon !== undefined && row.node.icon !== null && row.node.icon !== ""
      ? row.node.icon
      : undefined;

  const conflictLabel = (count: number): string =>
    `${count} unresolved ${count === 1 ? "conflict" : "conflicts"}`;

  function startDrag(event: DragEvent, path: string): void {
    if (onmove === undefined || event.dataTransfer === null) return;
    draggingPath = path;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", path);
  }

  function dragOver(event: DragEvent, folder: string): void {
    event.stopPropagation();
    if (onmove === undefined) return;
    const transfer = event.dataTransfer;
    if (transfer === null) return;
    if (draggingPath === undefined || !canDrop(draggingPath, folder)) {
      dropFolder = undefined;
      transfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    transfer.dropEffect = "move";
    dropFolder = folder;
  }

  function drop(event: DragEvent, folder: string): void {
    if (onmove === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const from = draggingPath;
    draggingPath = undefined;
    dropFolder = undefined;
    if (from === undefined || !canDrop(from, folder)) return;
    const filename = from.slice(from.lastIndexOf("/") + 1);
    const to = folder === "" ? filename : `${folder}/${filename}`;
    if (from !== to) void move(from, to);
  }

  function canDrop(from: string, folder: string): boolean {
    return folder !== from && !folder.startsWith(`${from}/`) && folder !== from.slice(0, Math.max(0, from.lastIndexOf("/")));
  }

  async function move(from: string, to: string): Promise<void> {
    if (moveBusy || onmove === undefined) return;
    const node = rows.find((row) => row.node.path === from)?.node;
    if (node === undefined) return;
    moveBusy = true;
    moveError = await onmove(from, to, node.kind);
    moveBusy = false;
    if (moveError === undefined) {
      moveSubject = undefined;
      expanded = new Set([...expanded].map((path) => path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path));
      writeTreeExpansion(expansion, expanded);
      const parent = to.slice(0, Math.max(0, to.lastIndexOf("/")));
      if (parent !== "") setExpanded(parent, true);
    }
  }

  function endDrag(): void {
    draggingPath = undefined;
    dropFolder = undefined;
  }
</script>

<div class="tree-panel" tabindex="-1" bind:this={panel}>
  {#if bookmarked.length > 0}
    <section class="tree-section" aria-labelledby="bookmarks-heading">
      <h3 class="tree-heading" id="bookmarks-heading">Bookmarks</h3>
      <ul class="bookmark-list">
        {#each bookmarked as entry (entry.path)}
          <li>
            <button
              type="button"
              class="tree-row is-bookmark"
              data-current={entry.path === activeNote}
              title={entry.path}
              onclick={(event) => onopen(entry.path, event.metaKey || event.ctrlKey)}
              oncontextmenu={(event) => openContextMenu(event, entry.path)}
              onkeydown={(event) => { if (isMenuKey(event)) openContextMenu(event, entry.path); }}
            >
              <span class="tree-label">{entry.label}</span>
              {#if entry.conflicts > 0}
                <span class="tree-conflicts" aria-label={conflictLabel(entry.conflicts)}>
                  {entry.conflicts}
                </span>
              {/if}
            </button>
            <button type="button" class="icon-button row-actions" aria-label={`Note actions for ${entry.label}`} title="Note actions (Shift+F10)" aria-haspopup="menu" aria-expanded={context?.path === entry.path && context.source === "bookmark"} onclick={(event) => openContextMenu(event, entry.path)} oncontextmenu={(event) => openContextMenu(event, entry.path)} onkeydown={(event) => { if (isMenuKey(event)) openContextMenu(event, entry.path); }}><Icon name="more" /></button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="tree-section" aria-labelledby="notes-heading">
    <div class="tree-section-header" role="group" aria-label="Vault root" data-drop-target={dropFolder === ""} ondragover={(event) => dragOver(event, "")} ondrop={(event) => drop(event, "")}>
      <h3 class="tree-heading" id="notes-heading">Notes</h3>
      {#if oncreate !== undefined || onfolder !== undefined || onfilenames !== undefined}
        <div class="tree-actions" role="group" aria-label="File actions">
          {#if oncreate !== undefined}
            <button type="button" class="icon-button" aria-label="New note" title="New note" onclick={() => {
              const node = selectionMade ? rows[cursor]?.node : undefined;
              oncreate?.(node === undefined ? "" : node.kind === "folder" ? `${node.path}/` : node.path);
            }}><Icon name="note-plus" /></button>
          {/if}
          {#if onfolder !== undefined}
            <button type="button" class="icon-button" aria-label="New folder" title="New folder" onclick={onfolder}><Icon name="folder-plus" /></button>
          {/if}
          {#if onfilenames !== undefined}
            <button type="button" class="icon-button" aria-label="File settings" title="File settings" aria-haspopup="menu" aria-expanded={settings !== undefined} onclick={openSettings}><Icon name="more" /></button>
          {/if}
        </div>
      {/if}
    </div>

    {#if !catalog.ready}
      <p class="tree-empty">Loading…</p>
    {:else if rows.length === 0}
      <p class="tree-empty">This vault has no notes you can read.</p>
    {:else}
      <!--
        One tab stop for the whole tree, with `aria-activedescendant` naming the current row.
        Tab moves past the tree; arrows move within it.
      -->
      <div
        class="tree"
        role="tree"
        bind:this={treeElement}
        aria-label="Notes"
        tabindex="0"
        aria-activedescendant={rows[cursor] === undefined ? undefined : `tree-row-${cursor}`}
        {onkeydown}
        data-drop-target={dropFolder === ""}
        ondragover={(event) => dragOver(event, "")}
        ondrop={(event) => drop(event, "")}
        ondragend={endDrag}
      >
        {#each rows as row, index (row.node.path)}
          <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
               whole tree is the container above, which owns arrows and Enter. `tabindex="-1"`
               is the `aria-activedescendant` pattern: the container is the single tab stop and
               a row is focusable only programmatically, so Tab moves past the tree rather than
               through four hundred notes. -->
          <div
            class="tree-row"
            id={`tree-row-${index}`}
            role="treeitem"
            aria-label={label(row)}
            tabindex="-1"
            aria-level={row.depth + 1}
            aria-expanded={row.node.kind === "folder" ? row.expanded === true : undefined}
            aria-selected={index === cursor}
            data-kind={row.node.kind}
            data-current={row.node.kind === "note" && row.node.path === activeNote}
            data-dragging={row.node.path === draggingPath}
            data-drop-target={row.node.kind === "folder" && row.node.path === dropFolder}
            style={`--tree-depth: ${row.depth}`}
            title={row.node.path}
            onclick={(event) => {
              cursor = index;
              selectionMade = true;
              if (row.node.kind === "note") onopen(row.node.path, event.metaKey || event.ctrlKey);
              else setExpanded(row.node.path, row.expanded !== true);
            }}
            oncontextmenu={(event) => openContextMenu(event, row.node.path, row.node.kind)}
            draggable={onmove !== undefined && !moveBusy}
            ondragstart={(event) => startDrag(event, row.node.path)}
            ondragover={row.node.kind === "folder" ? (event) => dragOver(event, row.node.path) : undefined}
            ondrop={row.node.kind === "folder" ? (event) => drop(event, row.node.path) : undefined}
          >
            <!--
              A drawn mark rather than a typed one. The twisties were `▾`/`▸` and a note with
              no frontmatter icon was a `·`, which is a middle dot standing in for a document
              at whatever size and weight the platform font happened to render it. The
              chevron turns instead of being swapped, which is one element and one rule (the
              rotation is in `app.css`) rather than two glyphs that can disagree about size.
            -->
            <span class="tree-icon" aria-hidden="true">
              {#if row.node.kind === "folder"}
                <Icon name="chevron-right" variant="tree-twisty" />
                <Icon name={row.expanded === true ? "folder-open" : "folder"} variant="tree-folder" />
              {:else if icon(row) !== undefined && icon(row) !== null}
                {icon(row)}
              {:else}
                <Icon name="note" />
              {/if}
            </span>
            <span class="tree-label">{label(row)}</span>
            {#if row.node.kind === "folder"}
              <!-- Shift+F10 / ContextMenu opens this without a tab stop per folder. -->
              <button type="button" tabindex="-1" class="icon-button folder-actions row-actions" aria-label={`Folder actions for ${row.node.name}`} title="Folder actions (Shift+F10)" aria-haspopup="menu" aria-expanded={context?.path === row.node.path && context.source === "tree"} onclick={(event) => openContextMenu(event, row.node.path, "folder")}><Icon name="more" /></button>
            {/if}

            {#if row.node.kind === "note"}
              {#if row.node.conflicts > 0}
                <span class="tree-conflicts" aria-label={conflictLabel(row.node.conflicts)}>
                  {row.node.conflicts}
                </span>
              {/if}
              <button type="button" tabindex="-1" class="icon-button row-actions" aria-label={`Note actions for ${label(row)}`} title="Note actions (Shift+F10)" aria-haspopup="menu" aria-expanded={context?.path === row.node.path && context.source === "tree"} onclick={(event) => openContextMenu(event, row.node.path)}><Icon name="more" /></button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

{#if moveError !== undefined && moveSubject === undefined}<p role="alert">{moveError}</p>{/if}
{#if moveSubject !== undefined}
<NamePrompt open={true} title="Move folder" subject={`${moveSubject} — leave the destination blank for the vault root.`} label="Destination folder" initial="" busy={moveBusy} error={moveError} confirm="Move" confirming="Moving…" onsubmit={(folder) => {
  const from = moveSubject;
  if (from === undefined) return;
  const parent = folder.trim();
  if ((parent !== "" && !validFolder(parent)) || !canDrop(from, parent)) {
    moveError = "Choose a different folder outside this folder. Leave blank for the vault root.";
    return;
  }
  const name = from.slice(from.lastIndexOf("/") + 1);
  void move(from, parent === "" ? name : `${parent}/${name}`);
}} ondismiss={() => { if (!moveBusy) moveSubject = undefined; }} />
{/if}

{#if settings !== undefined}
<ContextMenu
  open={true}
  label="File settings"
  x={settings.x}
  y={settings.y}
  options={[{ label: "Show filenames", checked: showFilenames, ontoggle: () => onfilenames?.(!showFilenames) }]}
  ondismiss={() => (settings = undefined)}
/>
{:else if context?.kind === "folder"}
<ContextMenu
  open={true}
  label="Folder actions"
  x={context.x}
  y={context.y}
  onopenmain={onopenfolder === undefined ? undefined : () => {
    if (context !== undefined) onopenfolder(context.path);
    context = undefined;
  }}
  onmove={onmove === undefined ? undefined : () => {
    moveError = undefined;
    moveSubject = context?.path;
    context = undefined;
  }}
  ondismiss={() => (context = undefined)}
/>
{:else}
<ContextMenu
  open={context !== undefined}
  x={context?.x ?? 0}
  y={context?.y ?? 0}
  onrename={() => {
    if (context !== undefined) requestRename(context.path, target);
    context = undefined;
  }}
  onopennewtab={() => {
    if (context !== undefined) onopen(context.path, true);
    context = undefined;
  }}
  ondelete={() => {
    if (context !== undefined) ondelete?.(context.path);
    context = undefined;
  }}
  bookmarked={context !== undefined && bookmarks.has(context.path)}
  onbookmark={toggleBookmark}
  ondismiss={() => (context = undefined)}
/>
{/if}
