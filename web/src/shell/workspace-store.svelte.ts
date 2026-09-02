/**
 * The live workspace, as reactive state (`SPEC.md` §8.1, §8.2).
 *
 * A `.svelte.ts` module rather than state inside a component: `AGENTS.md` §4.4 keeps logic
 * out of components, and this is logic — every operation is one of the pure functions in
 * `workspace.ts`, applied to a single `$state` holder. Components read `current` and call
 * these methods; none of them owns any of it.
 *
 * The store's own job is the two things the pure model deliberately does not do:
 *
 * - **Persist.** Every mutation asks the transport to save, which debounces and coalesces
 *   (§8.1). Dragging a split emits a change per frame; the network sees one request.
 * - **Refuse to break.** A mutation that would violate `workspaceProblems` is dropped rather
 *   than applied. That should be unreachable — the property tests in `workspace.test.ts`
 *   say the operations maintain the invariants — but "should be unreachable" is not the same
 *   as "cannot happen", and the alternative is a pane tree the layout cannot render.
 */

import {
  type GroupId,
  type SplitDirection,
  type Tab,
  type TabId,
  type TabMode,
  type Workspace,
  type WorkspaceIds,
  activateTab,
  activeTab,
  closeGroup,
  closeTab,
  counterIds,
  createWorkspace,
  focusGroup,
  goBack,
  goForward,
  groups,
  moveTab,
  navigateTab,
  openTab,
  setRatio,
  setTabMode,
  setTabScroll,
  splitGroup,
  tabs,
  workspaceProblems,
} from "./workspace.js";

/** What the store needs to keep a layout across sessions. Omitted, nothing is persisted. */
export interface WorkspacePersistence {
  save(workspace: Workspace): void;
}

export interface WorkspaceStoreOptions {
  readonly initial: Workspace;
  readonly ids?: WorkspaceIds;
  readonly persistence?: WorkspacePersistence;
  /**
   * Called when a mutation was dropped for producing an invalid workspace.
   *
   * Defaults to reporting on the console. A silent drop would look like an unresponsive UI,
   * which is the hardest kind of bug to trace back to its cause.
   */
  readonly onRejected?: (operation: string, problems: readonly string[]) => void;
}

/**
 * Random-enough ids for a live session.
 *
 * why: not a counter. Ids are persisted and reloaded, so a counter restarting at 1 on the
 * next visit would collide with the ids already in the stored layout the moment a tab is
 * opened — which `workspaceProblems` would then reject, silently losing the layout.
 */
export function sessionIds(): WorkspaceIds {
  const unique = (kind: string): string => {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const suffix = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${kind}-${suffix}`;
  };
  return {
    tab: () => unique("tab"),
    group: () => unique("group"),
    split: () => unique("split"),
  };
}

export class WorkspaceStore {
  #workspace: Workspace = $state() as Workspace;
  readonly #ids: WorkspaceIds;
  readonly #persistence: WorkspacePersistence | undefined;
  readonly #onRejected: (operation: string, problems: readonly string[]) => void;

  constructor(options: WorkspaceStoreOptions) {
    this.#workspace = options.initial;
    this.#ids = options.ids ?? sessionIds();
    this.#persistence = options.persistence;
    this.#onRejected =
      options.onRejected ??
      ((operation, problems) => {
        console.error(`memberberry: ${operation} produced an unusable workspace`, problems);
      });
  }

  /** The live workspace. Reading this in a component subscribes to it. */
  get current(): Workspace {
    return this.#workspace;
  }

  /** Every pane, in layout order. */
  get groups(): readonly ReturnType<typeof groups>[number][] {
    return groups(this.#workspace.root);
  }

  /** Every open tab, in layout order. */
  get tabs(): readonly Tab[] {
    return tabs(this.#workspace.root);
  }

  /** The tab a mobile layout renders, and the one keyboard commands act on (§8.3). */
  get activeTab(): Tab | undefined {
    return activeTab(this.#workspace);
  }

  get focusedGroup(): GroupId {
    return this.#workspace.focusedGroup;
  }

  // ---------------------------------------------------------------- mutations

  open(note: string, options: { mode?: TabMode; group?: GroupId; reuse?: boolean } = {}): void {
    this.#apply("open", (workspace) => openTab(workspace, { note, ...options }, this.#ids));
  }

  close(tab: TabId): void {
    this.#apply("close", (workspace) => closeTab(workspace, tab));
  }

  activate(tab: TabId): void {
    this.#apply("activate", (workspace) => activateTab(workspace, tab));
  }

  setMode(tab: TabId, mode: TabMode): void {
    this.#apply("setMode", (workspace) => setTabMode(workspace, tab, mode));
  }

  /**
   * Records a scroll offset.
   *
   * Not persisted eagerly: scrolling fires continuously, and a save per event would defeat
   * the debounce it shares with everything else. The next real mutation carries it, and so
   * does `flush` on the way out.
   */
  setScroll(tab: TabId, scroll: number): void {
    this.#apply("setScroll", (workspace) => setTabScroll(workspace, tab, scroll), {
      persist: false,
    });
  }

  navigate(tab: TabId, note: string): void {
    this.#apply("navigate", (workspace) => navigateTab(workspace, tab, note));
  }

  back(tab: TabId): void {
    this.#apply("back", (workspace) => goBack(workspace, tab));
  }

  forward(tab: TabId): void {
    this.#apply("forward", (workspace) => goForward(workspace, tab));
  }

  split(group: GroupId, direction: SplitDirection, note?: string): void {
    this.#apply("split", (workspace) =>
      splitGroup(workspace, group, direction, this.#ids, note === undefined ? {} : { note }),
    );
  }

  resize(split: string, ratio: number): void {
    this.#apply("resize", (workspace) => setRatio(workspace, split, ratio));
  }

  move(tab: TabId, toGroup: GroupId, index?: number): void {
    this.#apply("move", (workspace) => moveTab(workspace, tab, toGroup, index));
  }

  focus(group: GroupId): void {
    this.#apply("focus", (workspace) => focusGroup(workspace, group));
  }

  closePane(group: GroupId): void {
    this.#apply("closePane", (workspace) => closeGroup(workspace, group));
  }

  /**
   * Applies a pure operation, checks it, and persists.
   *
   * The identity check matters as much as the invariant check: every operation returns the
   * same workspace when it would be a no-op, so this is what stops a rejected click from
   * writing an identical layout to the server on every keypress.
   */
  #apply(
    operation: string,
    change: (workspace: Workspace) => Workspace,
    options: { persist?: boolean } = {},
  ): void {
    const next = change(this.#workspace);
    if (next === this.#workspace) return;

    const problems = workspaceProblems(next);
    if (problems.length > 0) {
      this.#onRejected(operation, problems);
      return;
    }
    this.#workspace = next;
    if (options.persist !== false) this.#persistence?.save(next);
  }
}

/** An empty store, for a session that has nothing to restore. */
export function emptyWorkspaceStore(
  vault: string,
  options: Omit<WorkspaceStoreOptions, "initial"> = {},
): WorkspaceStore {
  const ids = options.ids ?? sessionIds();
  return new WorkspaceStore({ ...options, ids, initial: createWorkspace(vault, ids) });
}

/** Ids that count, for tests that want to read them. Re-exported so tests need one import. */
export { counterIds };
