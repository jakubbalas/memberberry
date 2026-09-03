<!--
  The command palette, quick switcher and vault switcher (`SPEC.md` §8.4).

  One component owning all three, because they share a registry, a palette and a rule: exactly
  one is open at a time. Three components would each need to know about the other two.

  What lives here is *wiring* — which list fills the palette and what Enter does. The parts
  worth testing on their own are already elsewhere: `commands.ts` resolves bindings,
  `fuzzy.ts` ranks, `catalog.ts` fetches, and `Palette.svelte` handles the keyboard.
-->
<script lang="ts">
  import Palette, { type PaletteItem } from "./Palette.svelte";
  import { type VaultSummary, fetchVaults, noteHint, noteLabel } from "./catalog.js";
  import {
    type Command,
    CommandRegistry,
    readBindingOverrides,
  } from "./commands.js";
  import { fuzzyRank } from "./fuzzy.js";
  import { type Platform, detectPlatform, formatBinding } from "./hotkeys.js";
  import type { LayoutMode } from "./layout.js";
  import { splitLimitFor } from "./layout.js";
  import type { NoteCatalog } from "./note-catalog.svelte.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import { groups } from "./workspace.js";

  interface Props {
    readonly store: WorkspaceStore;
    /** The vault's readable notes, shared with the tree so the list is fetched once. */
    readonly catalog: NoteCatalog;
    readonly vault: string;
    readonly layout: LayoutMode;
    /** Where the shell listens for hotkeys. Injectable so a test need not use `window`. */
    readonly target?: EventTarget | undefined;
    readonly chrome?: Pick<Storage, "getItem" | "setItem"> | undefined;
    /**
     * Which modifier `Mod` means. Injectable, and tests must set it.
     *
     * why: the default reads `navigator.userAgent`, so a suite that leaves it alone passes on
     * a Linux runner and fails on a Mac one — the same keystroke is `Ctrl` on one and `Cmd` on
     * the other. That is a genuinely platform-dependent test, which is a flaky test.
     */
    readonly platform?: Platform | undefined;
    /** Injectable for tests; defaults to the real HTTP call. */
    readonly loadVaults?: typeof fetchVaults | undefined;
    /** Called to move to another vault. Defaults to a real navigation. */
    readonly onvault?: ((slug: string) => void) | undefined;
  }

  const {
    store,
    catalog,
    vault,
    layout,
    target,
    chrome,
    platform,
    loadVaults = fetchVaults,
    onvault,
  }: Props = $props();

  type Mode = "commands" | "notes" | "vaults";

  let mode = $state<Mode | undefined>(undefined);
  let query = $state("");
  let vaults = $state<readonly VaultSummary[]>([]);

  function openPalette(next: Mode): void {
    mode = next;
    query = "";
    // Fetched on first open rather than at mount: most sessions never open the switcher, and
    // the note index of a large vault is the biggest payload the shell can ask for. The
    // catalog is shared with the tree, so whichever asks first pays and the other is free.
    if (next === "notes") catalog.ensure();
    if (next === "vaults" && vaults.length === 0) {
      void loadVaults().then((list) => (vaults = list));
    }
  }

  function dismiss(): void {
    mode = undefined;
    query = "";
  }

  const canSplit = $derived(groups(store.current.root).length <= splitLimitFor(layout));

  /**
   * Everything the palette can run.
   *
   * Note what is *not* here: bold, italic, headings. Those belong to the editor's own keymap,
   * and a shell command that shadowed one would break typing (§8.2).
   */
  const commands: readonly Command[] = $derived([
    {
      id: "palette.commands",
      title: "Command palette",
      group: "Workspace",
      binding: "Mod+Shift+p",
      run: () => openPalette("commands"),
    },
    {
      id: "palette.notes",
      title: "Quick switcher: open a note",
      group: "Navigation",
      binding: "Mod+k",
      run: () => openPalette("notes"),
    },
    {
      id: "palette.vaults",
      title: "Switch vault",
      group: "Navigation",
      binding: "Mod+Shift+v",
      run: () => openPalette("vaults"),
    },
    {
      id: "workspace.splitRight",
      title: "Split pane right",
      group: "Workspace",
      binding: "Mod+\\",
      enabled: () => canSplit,
      run: () => store.split(store.focusedGroup, "vertical"),
    },
    {
      id: "workspace.splitDown",
      title: "Split pane down",
      group: "Workspace",
      binding: "Mod+Shift+\\",
      enabled: () => canSplit,
      run: () => store.split(store.focusedGroup, "horizontal"),
    },
    {
      id: "workspace.closeTab",
      title: "Close note",
      group: "Workspace",
      binding: "Mod+w",
      enabled: () => store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) store.close(active.id);
      },
    },
    {
      id: "workspace.closePane",
      title: "Close pane",
      group: "Workspace",
      enabled: () => groups(store.current.root).length > 1,
      run: () => store.closePane(store.focusedGroup),
    },
    {
      id: "navigation.back",
      title: "Back",
      group: "Navigation",
      enabled: () => store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) store.back(active.id);
      },
    },
    {
      id: "navigation.forward",
      title: "Forward",
      group: "Navigation",
      enabled: () => store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) store.forward(active.id);
      },
    },
    {
      id: "note.toggleMode",
      title: "Toggle reading view",
      group: "Note",
      enabled: () => store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) store.setMode(active.id, active.mode === "edit" ? "read" : "edit");
      },
    },
  ]);

  const registry = $derived(
    new CommandRegistry({
      commands,
      overrides: readBindingOverrides(
        chrome ?? (typeof localStorage === "undefined" ? undefined : localStorage),
      ),
      ...(platform === undefined ? {} : { platform }),
    }),
  );

  $effect(() => {
    const host = target ?? window;
    const onkeydown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) return;
      // While a palette is open it owns the keyboard: its own Escape and arrows must not also
      // trigger a shortcut, and re-opening the palette that is already open is not an action.
      if (mode !== undefined) return;
      if (registry.handle(event)) event.preventDefault();
    };
    host.addEventListener("keydown", onkeydown);
    return () => host.removeEventListener("keydown", onkeydown);
  });

  /** The palette's list, for whichever mode is open. */
  const items = $derived.by((): readonly PaletteItem[] => {
    if (mode === "commands") {
      return fuzzyRank(query, registry.all, { key: (entry) => entry.command.title }).map(
        ({ item, match }) => ({
          id: item.command.id,
          label: item.command.title,
          hint:
            item.binding === undefined
              ? undefined
              : formatBinding(item.binding, platform ?? detectPlatform()),
          group: item.command.group,
          positions: match.positions,
          disabled: !item.enabled,
        }),
      );
    }
    if (mode === "notes") {
      return fuzzyRank(query, catalog.notes, { key: noteLabel }).map(({ item, match }) => ({
        id: item.path,
        label: noteLabel(item),
        hint: noteHint(item),
        positions: match.positions,
      }));
    }
    if (mode === "vaults") {
      return fuzzyRank(query, vaults, { key: (entry) => entry.name }).map(({ item, match }) => ({
        id: item.slug,
        label: item.name,
        hint: item.slug === vault ? "current" : undefined,
        positions: match.positions,
        disabled: item.slug === vault,
      }));
    }
    return [];
  });

  function choose(id: string): void {
    const chosen = mode;
    dismiss();
    if (chosen === "commands") {
      registry.find(id)?.command.run();
      return;
    }
    if (chosen === "notes") {
      store.open(id);
      return;
    }
    if (chosen === "vaults") {
      // A full navigation rather than swapping the store's vault: the note index, the ACL and
      // the workspace layout are all per-vault, and the server hands them over on the way in.
      if (onvault !== undefined) onvault(id);
      else window.location.assign(`/v/${encodeURIComponent(id)}`);
    }
  }

  const titles: Record<Mode, { title: string; placeholder: string; empty: string }> = {
    commands: {
      title: "Command palette",
      placeholder: "Run a command…",
      empty: "No command matches.",
    },
    notes: {
      title: "Open a note",
      placeholder: "Search notes…",
      empty: "No note matches.",
    },
    vaults: { title: "Switch vault", placeholder: "Search vaults…", empty: "No vault matches." },
  };
</script>

<Palette
  open={mode !== undefined}
  title={mode === undefined ? "Palette" : titles[mode].title}
  placeholder={mode === undefined ? "" : titles[mode].placeholder}
  empty={mode === undefined ? undefined : titles[mode].empty}
  {query}
  {items}
  onquery={(next) => (query = next)}
  onchoose={choose}
  ondismiss={dismiss}
/>
