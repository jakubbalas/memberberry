<!--
  The command palette, quick switcher and vault switcher (`SPEC.md` §8.4).

  One component owning all three, because they share a registry, a palette and a rule: exactly
  one is open at a time. Three components would each need to know about the other two.

  What lives here is *wiring* — which list fills the palette and what Enter does. The parts
  worth testing on their own are already elsewhere: `commands.ts` resolves bindings,
  `fuzzy.ts` ranks, `catalog.ts` fetches, and `Palette.svelte` handles the keyboard.

  Rename (§6.6) and creating a note (§6.10) are here for the same reason the three switchers
  are: they are commands, and
  §8.4 says the palette is over *every* registered command. It is deliberately **not** a
  button on a note-tree row — the tree is one tab stop with `aria-activedescendant`, and a
  control per row would turn four hundred notes into eight hundred tab stops.
-->
<script lang="ts">
  import Palette, { type PaletteItem } from "./Palette.svelte";
  import NamePrompt from "./NamePrompt.svelte";
  import { type VaultSummary, fetchVaults, noteHint, noteLabel } from "./catalog.js";
  import {
    type Command,
    CommandRegistry,
    readBindingOverrides,
  } from "./commands.js";
  import {
    createNote as createNoteRequest,
    newNotePathFor,
    newNoteSubject,
  } from "./create.js";
  import { fuzzyRank } from "./fuzzy.js";
  import { type Platform, detectPlatform, formatBinding } from "./hotkeys.js";
  import type { LayoutMode } from "./layout.js";
  import { splitLimitFor } from "./layout.js";
  import type { NoteCatalog } from "./note-catalog.svelte.js";
  import {
    noteNameOf,
    notePathFor,
    renameNote as renameNoteRequest,
    renameTag as renameTagRequest,
    renamedMessage,
  } from "./rename.js";
  import type { PinnedNotes } from "./pins.svelte.js";
  import type { TagView } from "./tags.svelte.js";
  import type { WorkspaceStore } from "./workspace-store.svelte.js";
  import { groups } from "./workspace.js";
  import { dispatchTemplate, fetchTemplates, readTemplate, TEMPLATE_PALETTE_EVENT, type TemplateSummary } from "./templates.js";
  import { DailyView } from "./daily.svelte.js";

  interface Props {
    readonly store: WorkspaceStore;
    /** The vault's readable notes, shared with the tree so the list is fetched once. */
    readonly catalog: NoteCatalog;
    /** The tag tree, shared with the pane — a tag rename acts on whichever node it selected. */
    readonly tags: TagView;
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
    /** Opens the whole-vault graph (§9.4). Absent in a shell that has no graph to show. */
    readonly ongraph?: (() => void) | undefined;
    /** Injectable for tests; default to the real HTTP calls. */
    readonly renameNote?: typeof renameNoteRequest | undefined;
    readonly renameTag?: typeof renameTagRequest | undefined;
    readonly createNote?: typeof createNoteRequest | undefined;
    /**
     * Which notes this device keeps offline (§7.2).
     *
     * Absent in a shell with no vault behind it — a local-only replica has no pinned tier,
     * because the one document it holds is already nowhere else. Where there is a vault but
     * nowhere to keep a replica (a private window), the command is listed and **refuses**,
     * which is the palette's own convention for a command that cannot run right now.
     */
    readonly pins?: PinnedNotes | undefined;
    readonly daily?: DailyView | undefined;
    readonly user?: string | undefined;
  }

  const {
    store,
    catalog,
    tags,
    vault,
    layout,
    target,
    chrome,
    platform,
    loadVaults = fetchVaults,
    onvault,
    ongraph,
    renameNote = renameNoteRequest,
    renameTag = renameTagRequest,
    createNote = createNoteRequest,
    pins,
    daily,
    user,
  }: Props = $props();

  type Mode = "commands" | "notes" | "vaults" | "templates";

  /**
   * What the name prompt is currently asking about. `undefined` means it is closed.
   *
   * One dialog for renaming and for creating, because it is one question — "what should this
   * be called" — and two `<dialog>` elements would need a rule about which may be open.
   * `create` carries the note the new one will sit beside, which is `from`'s meaning there.
   */
  interface Prompting {
    readonly kind: "note" | "tag" | "create";
    /** The note path or tag key being renamed, or the note a new one is created beside. */
    readonly from: string;
    readonly initial: string;
  }

  // Read through a derived so the pin command's title re-resolves when the tab changes or
  // the pin does; reading `store.activeTab.note` inside the title expression would work too,
  // but this is the value the title is actually about.
  const activeNote = $derived(store.activeTab?.note);

  let mode = $state<Mode | undefined>(undefined);
  let query = $state("");
  let vaults = $state<readonly VaultSummary[]>([]);
  let renaming = $state<Prompting | undefined>(undefined);
  let renameBusy = $state(false);
  let renameError = $state<string | undefined>(undefined);
  let renameNotice = $state("");
  let templates = $state<readonly TemplateSummary[]>([]);

  async function openPeriod(period: "daily" | "weekly" | "monthly", offset = 0): Promise<void> {
    if (daily === undefined) return;
    daily.ensure();
    if (!daily.ready) {
      await daily.refresh();
    }
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + offset);
    const date = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;
    const existing = await daily.existing(period, date);
    if (existing !== undefined) {
      store.open(existing.path);
      return;
    }
    const path = await daily.pathFor(period, date);
    if (path === undefined) return;
    let result;
    try {
      result = await daily.createPeriod(period, date, user ?? "", createNote);
    } catch {
      renameNotice = `The ${period} note template is unavailable.`;
      return;
    }
    if (result === undefined) return;
    if ("ok" in result) {
      store.open(result.ok.path);
      void daily.refresh();
      void catalog.refresh();
    } else {
      renameNotice = result.refused;
    }
  }

  function openPalette(next: Mode): void {
    mode = next;
    query = "";
    // Fetched on first open rather than at mount: most sessions never open the switcher, and
    // the note index of a large vault is the biggest payload the shell can ask for. The
    // catalog is shared with the tree, so whichever asks first pays and the other is free.
    if (next === "notes") catalog.ensure();
    // The pin command is a toggle, so the command list cannot be worded without knowing what
    // is pinned. One read of a local store, on the first open of the palette.
    if (next === "commands") pins?.ensure();
    if (next === "vaults" && vaults.length === 0) {
      void loadVaults().then((list) => (vaults = list));
    }
    if (next === "templates" && templates.length === 0) {
      void fetchTemplates(vault).then((list) => (templates = list.templates)).catch(() => (templates = []));
    }
  }

  function dismiss(): void {
    mode = undefined;
    query = "";
  }

  const canSplit = $derived(groups(store.current.root).length <= splitLimitFor(layout));

  function ask(next: Prompting): void {
    dismiss();
    renameError = undefined;
    renameNotice = "";
    renaming = next;
  }

  /** Routes the one dialog's submission to whichever question it was asking. */
  function submitPrompt(typed: string): void {
    if (renaming?.kind === "create") {
      void confirmCreate(typed);
    } else {
      void confirmRename(typed);
    }
  }

  /**
   * Creates a note and opens it in the focused pane.
   *
   * Opening it is the point rather than a courtesy: somebody who has just named a note wants
   * to write in it, and a create that only refreshed the tree would leave them to find it.
   * The catalog is refreshed too, so the tree and the quick switcher agree with the vault
   * before either is next opened.
   */
  async function confirmCreate(typed: string): Promise<void> {
    const subject = renaming;
    if (subject === undefined) return;
    const path = newNotePathFor(subject.from, typed);
    if (path === undefined) {
      renameError = "That is not a usable name.";
      return;
    }
    renameBusy = true;
    renameError = undefined;
    const result = await createNote(vault, path);
    renameBusy = false;
    if ("refused" in result) {
      renameError = result.refused;
      return;
    }
    renaming = undefined;
    renameNotice = `Created ${result.ok.path}.`;
    store.open(result.ok.path);
    void catalog.refresh();
  }

  /**
   * Sends the rename, then puts the workspace back where it belongs.
   *
   * Every tab showing the renamed note is moved, not only the one it was asked from: two
   * panes over one note is an ordinary split, and leaving the other pointed at a path that
   * no longer exists would render an error beside a working editor.
   */
  async function confirmRename(typed: string): Promise<void> {
    const subject = renaming;
    if (subject === undefined) return;
    const to = subject.kind === "note" ? notePathFor(subject.from, typed) : typed.trim();
    if (to === undefined || to === "") {
      renameError = "That is not a usable name.";
      return;
    }
    renameBusy = true;
    renameError = undefined;
    const result =
      subject.kind === "note"
        ? await renameNote(vault, subject.from, to)
        : await renameTag(vault, subject.from, to);
    renameBusy = false;
    if ("refused" in result) {
      renameError = result.refused;
      return;
    }
    renaming = undefined;
    renameNotice = renamedMessage(result.ok);
    if (subject.kind === "note") {
      for (const tab of store.tabs) {
        if (tab.note === subject.from) store.navigate(tab.id, result.ok.to);
      }
      void catalog.refresh();
    } else {
      // Deselected rather than re-selected under its new key: the key is folded server-side
      // (§9.3), so guessing it here would be a second copy of that rule.
      tags.select(undefined);
    }
    void tags.refresh();
  }

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
      id: "note.create",
      title: "New note…",
      group: "Note",
      // why: no default binding. The obvious ones are taken by the browser and cannot be
      // intercepted from a page — `Mod+n` opens a window and `Mod+Shift+n` a private one —
      // so shipping either would register a shortcut that silently never fires. §8.4's
      // hotkeys are remappable, so anyone who wants one can bind a key the browser leaves
      // alone; the palette is the route that always works.
      // Always enabled, unlike the other note commands: creating one is the thing a vault
      // with nothing open most needs, so requiring an active tab would disable it exactly
      // when it matters. With no tab open the new note lands at the vault root.
      run: () => ask({ kind: "create", from: store.activeTab?.note ?? "", initial: "" }),
    },
    {
      id: "note.template",
      title: "Insert template…",
      group: "Note",
      enabled: () => store.activeTab !== undefined,
      run: () => openPalette("templates"),
    },
    {
      id: "daily.today",
      title: "Open today’s note",
      group: "Navigation",
      binding: "Mod+Shift+d",
      enabled: () => daily !== undefined,
      run: () => void openPeriod("daily"),
    },
    {
      id: "weekly.current",
      title: "Open this week’s note",
      group: "Navigation",
      enabled: () => daily !== undefined,
      run: () => void openPeriod("weekly"),
    },
    {
      id: "monthly.current",
      title: "Open this month’s note",
      group: "Navigation",
      enabled: () => daily !== undefined,
      run: () => void openPeriod("monthly"),
    },
    {
      id: "note.rename",
      title: "Rename note…",
      group: "Note",
      enabled: () => store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) {
          ask({ kind: "note", from: active.note, initial: noteNameOf(active.note) });
        }
      },
    },
    {
      id: "tag.rename",
      title: "Rename the selected tag…",
      group: "Note",
      enabled: () => tags.selected !== undefined,
      run: () => {
        const selected = tags.selected;
        if (selected !== undefined) {
          ask({ kind: "tag", from: selected, initial: selected });
        }
      },
    },
    {
      id: "graph.open",
      title: "Open the graph",
      group: "Navigation",
      binding: "Mod+Shift+g",
      // Absent rather than disabled when there is nothing to open: a local-only replica has
      // no route to answer for a vault (§9.4), and a permanently greyed-out row in the
      // palette teaches a reader that the feature is broken rather than that it is elsewhere.
      enabled: () => ongraph !== undefined,
      run: () => ongraph?.(),
    },
    {
      id: "note.pinOffline",
      // §7.2's pinned tier, worded as what it does rather than as what it is called: "pin"
      // means something else in every other notes application (pin to the top of a list).
      title:
        activeNote !== undefined && pins?.has(activeNote) === true
          ? "Stop keeping this note offline"
          : "Keep this note available offline",
      group: "Note",
      enabled: () => pins?.available === true && store.activeTab !== undefined,
      run: () => {
        const active = store.activeTab;
        if (active !== undefined) void pins?.toggle(active.note);
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

  $effect(() => {
    const onTemplatePalette = (): void => openPalette("templates");
    window.addEventListener(TEMPLATE_PALETTE_EVENT, onTemplatePalette);
    return () => window.removeEventListener(TEMPLATE_PALETTE_EVENT, onTemplatePalette);
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
    if (mode === "templates") {
      return fuzzyRank(query, templates, { key: (entry) => entry.name }).map(({ item, match }) => ({
        id: item.path,
        label: item.name,
        positions: match.positions,
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
      return;
    }
    if (chosen === "templates") {
      void readTemplate(vault, id).then(dispatchTemplate).catch((error: unknown) => {
        renameNotice = error instanceof Error ? error.message : "That template is unavailable.";
      });
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
    templates: { title: "Insert template", placeholder: "Search templates…", empty: "No template matches." },
  };

  function promptTitle(prompt: Prompting | undefined): string {
    if (prompt?.kind === "create") return "New note";
    return prompt?.kind === "tag" ? "Rename tag" : "Rename note";
  }

  /** What the prompt is acting on: the thing being renamed, or where a new note will go. */
  function promptSubject(prompt: Prompting | undefined): string {
    if (prompt === undefined) return "";
    if (prompt.kind === "create") return newNoteSubject(prompt.from);
    return prompt.kind === "tag" ? `#${prompt.from}` : prompt.from;
  }

  function promptLabel(prompt: Prompting | undefined): string {
    if (prompt?.kind === "create") return "Name";
    return prompt?.kind === "tag" ? "New tag" : "New name";
  }
</script>

<NamePrompt
  open={renaming !== undefined}
  title={promptTitle(renaming)}
  subject={promptSubject(renaming)}
  label={promptLabel(renaming)}
  initial={renaming?.initial ?? ""}
  busy={renameBusy}
  error={renameError}
  warning={renaming === undefined || renaming.kind === "create"
    ? undefined
    : "Inbound links are rewritten across the whole vault, including in notes you cannot see."}
  confirm={renaming?.kind === "create" ? "Create" : "Rename"}
  confirming={renaming?.kind === "create" ? "Creating…" : "Renaming…"}
  onsubmit={submitPrompt}
  ondismiss={() => {
    renaming = undefined;
    renameBusy = false;
    renameError = undefined;
  }}
/>

<!-- Announced rather than shown as a toast: the one thing a rename has to say is what it
     did, and a status region says it to a screen reader too. -->
<p class="rename-notice" role="status" aria-live="polite">{renameNotice}</p>

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
