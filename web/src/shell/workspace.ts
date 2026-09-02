/**
 * The workspace state model (`SPEC.md` §8.1).
 *
 * ```
 * Workspace(vault)
 *   └── SplitNode (horizontal | vertical, ratio)  ── recursive
 *         └── TabGroup
 *               └── Tab { note, mode, scroll, history[] }
 * ```
 *
 * One model, two layouts (§8). Desktop renders the whole tree; mobile renders only the
 * active leaf and uses the tab's own history for its back gesture (§8.3). Nothing here knows
 * that, which is the point — a layout is a way of drawing this, not a second state model.
 *
 * Every operation is **pure**: it takes a workspace and returns a new one, sharing the
 * subtrees it did not touch. That is not stylistic. Splits, tab drags and closes are the
 * operations most able to corrupt a tree in place, `INVARIANTS` below is checkable on any
 * value, and a property test can therefore apply a random sequence of operations and assert
 * the result is still well-formed — which is how the collapse-on-close rules were debugged.
 *
 * Ids are supplied by the caller through [`WorkspaceIds`] rather than generated here, so a
 * test is deterministic and a replay reproduces exactly.
 */

/** How a split divides its space. */
export type SplitDirection = "horizontal" | "vertical";

/** Whether a tab is editing or reading. */
export type TabMode = "edit" | "read";

export type TabId = string;
export type GroupId = string;
export type SplitId = string;

/**
 * One open note.
 *
 * `history` is the tab's own navigation stack — following a wikilink pushes onto it, and
 * §8.3's back gesture walks it. `historyIndex` points at the current entry, so going back
 * and then following a new link truncates the forward entries the way a browser does.
 */
export interface Tab {
  readonly id: TabId;
  readonly note: string;
  readonly mode: TabMode;
  /** Scroll offset in pixels, restored when the tab is reactivated. */
  readonly scroll: number;
  /** Visited notes, oldest first. Always non-empty; `history[historyIndex] === note`. */
  readonly history: readonly string[];
  readonly historyIndex: number;
}

export interface TabGroup {
  readonly kind: "group";
  readonly id: GroupId;
  readonly tabs: readonly Tab[];
  /** `null` only while the group is empty. */
  readonly activeTab: TabId | null;
}

export interface SplitNode {
  readonly kind: "split";
  readonly id: SplitId;
  readonly direction: SplitDirection;
  /** The first child's share of the space, clamped to [`MIN_RATIO`, 1 - `MIN_RATIO`]. */
  readonly ratio: number;
  readonly first: WorkspaceNode;
  readonly second: WorkspaceNode;
}

export type WorkspaceNode = SplitNode | TabGroup;

export interface Workspace {
  readonly vault: string;
  readonly root: WorkspaceNode;
  /** The group new tabs open into. Always names a group that exists. */
  readonly focusedGroup: GroupId;
}

/**
 * A pane narrower than this is unusable, so a drag cannot produce one.
 *
 * why: 12% rather than a pixel minimum, because this model has no idea how wide the window
 * is — the layout does. A proportional floor is the strongest guarantee available here, and
 * the layout is free to refuse a split that would be too small in absolute terms.
 */
export const MIN_RATIO = 0.12;

/** Supplies the ids for whatever an operation creates. */
export interface WorkspaceIds {
  tab(): TabId;
  group(): GroupId;
  split(): SplitId;
}

/** Ids of the form `tab-1`, `group-2`, for tests and for a single-session workspace. */
export function counterIds(prefix = ""): WorkspaceIds {
  let n = 0;
  const next = (kind: string): string => {
    n += 1;
    return `${prefix}${kind}-${n}`;
  };
  return {
    tab: () => next("tab"),
    group: () => next("group"),
    split: () => next("split"),
  };
}

/** An empty workspace: one focused group with nothing in it. */
export function createWorkspace(vault: string, ids: WorkspaceIds): Workspace {
  const group: TabGroup = { kind: "group", id: ids.group(), tabs: [], activeTab: null };
  return { vault, root: group, focusedGroup: group.id };
}

// ---------------------------------------------------------------------------- reading

/** Every group in the tree, in layout order (left-to-right, top-to-bottom). */
export function groups(node: WorkspaceNode): readonly TabGroup[] {
  return node.kind === "group" ? [node] : [...groups(node.first), ...groups(node.second)];
}

/** The group with this id, or `undefined`. */
export function findGroup(node: WorkspaceNode, id: GroupId): TabGroup | undefined {
  return groups(node).find((group) => group.id === id);
}

/** The group holding this tab, or `undefined`. */
export function groupOfTab(node: WorkspaceNode, tab: TabId): TabGroup | undefined {
  return groups(node).find((group) => group.tabs.some((candidate) => candidate.id === tab));
}

/** Every open tab, in layout order. */
export function tabs(node: WorkspaceNode): readonly Tab[] {
  return groups(node).flatMap((group) => group.tabs);
}

/** The tab with this id, or `undefined`. */
export function findTab(node: WorkspaceNode, id: TabId): Tab | undefined {
  return tabs(node).find((tab) => tab.id === id);
}

/**
 * The one tab a mobile layout renders (§8.3), or `undefined` when nothing is open.
 *
 * The whole tree still exists in state; mobile just draws one leaf of it. That is what lets
 * the same workspace open on a phone and a 32" monitor and mean the same thing.
 */
export function activeTab(workspace: Workspace): Tab | undefined {
  const group = findGroup(workspace.root, workspace.focusedGroup);
  if (group?.activeTab === null || group?.activeTab === undefined) return undefined;
  return group.tabs.find((tab) => tab.id === group.activeTab);
}

// ---------------------------------------------------------------------------- writing

/** Where [`openTab`] should put the note. */
export interface OpenTabOptions {
  readonly note: string;
  readonly mode?: TabMode;
  /** Which group to open in. Defaults to the focused one. */
  readonly group?: GroupId;
  /**
   * Reuse an existing tab on the same note in the target group instead of opening a second.
   *
   * Defaults to `true`, matching what a click on a link should do. Cmd-click asks for a new
   * tab and passes `false` — §8.2 gives both gestures, so both have to be expressible.
   */
  readonly reuse?: boolean;
}

/**
 * Opens a note, and focuses it.
 *
 * A no-op group id is not an error: it falls back to the focused group, because a stale id
 * from a UI event should not lose the user's click.
 */
export function openTab(
  workspace: Workspace,
  options: OpenTabOptions,
  ids: WorkspaceIds,
): Workspace {
  const targetId = resolveGroup(workspace, options.group);
  const target = findGroup(workspace.root, targetId);
  if (target === undefined) return workspace;

  if (options.reuse !== false) {
    const existing = target.tabs.find((tab) => tab.note === options.note);
    if (existing !== undefined) {
      return focusGroup({ ...workspace, root: replaceGroup(workspace.root, { ...target, activeTab: existing.id }) }, targetId);
    }
  }

  const tab: Tab = {
    id: ids.tab(),
    note: options.note,
    mode: options.mode ?? "edit",
    scroll: 0,
    history: [options.note],
    historyIndex: 0,
  };
  const grown: TabGroup = { ...target, tabs: [...target.tabs, tab], activeTab: tab.id };
  return focusGroup({ ...workspace, root: replaceGroup(workspace.root, grown) }, targetId);
}

/**
 * Closes a tab, collapsing whatever that empties.
 *
 * An empty group inside a split is not a state the user can see or use, so closing the last
 * tab in one dissolves the split and gives the space back to its sibling. The root may be a
 * single empty group — that is the empty workspace, and it has to be representable.
 */
export function closeTab(workspace: Workspace, tab: TabId): Workspace {
  const owner = groupOfTab(workspace.root, tab);
  if (owner === undefined) return workspace;

  const remaining = owner.tabs.filter((candidate) => candidate.id !== tab);
  const shrunk: TabGroup = {
    ...owner,
    tabs: remaining,
    activeTab: nextActive(owner, tab, remaining),
  };

  if (remaining.length > 0) {
    return { ...workspace, root: replaceGroup(workspace.root, shrunk) };
  }
  const collapsed = collapse(workspace.root, owner.id);
  // The root group survived because there is nowhere to collapse into: an empty workspace.
  const root = collapsed ?? shrunk;
  return refocus({ ...workspace, root });
}

/**
 * Which tab takes over when the active one closes.
 *
 * why: the tab to the *right*, falling back to the left — not "the first tab". Closing a run
 * of tabs left to right should walk forward through them rather than jumping back to the
 * start each time, which is what every editor does and what muscle memory expects.
 */
function nextActive(group: TabGroup, closed: TabId, remaining: readonly Tab[]): TabId | null {
  if (remaining.length === 0) return null;
  if (group.activeTab !== closed) return group.activeTab;
  const index = group.tabs.findIndex((tab) => tab.id === closed);
  return (remaining[index] ?? remaining[remaining.length - 1])?.id ?? null;
}

/** Makes a tab the active one in its group, and focuses that group. */
export function activateTab(workspace: Workspace, tab: TabId): Workspace {
  const owner = groupOfTab(workspace.root, tab);
  if (owner === undefined) return workspace;
  const root = replaceGroup(workspace.root, { ...owner, activeTab: tab });
  return focusGroup({ ...workspace, root }, owner.id);
}

/** Switches a tab between editing and reading. */
export function setTabMode(workspace: Workspace, tab: TabId, mode: TabMode): Workspace {
  return updateTab(workspace, tab, (current) => ({ ...current, mode }));
}

/** Records a tab's scroll offset, so reactivating it returns to the same place. */
export function setTabScroll(workspace: Workspace, tab: TabId, scroll: number): Workspace {
  return updateTab(workspace, tab, (current) => ({ ...current, scroll: Math.max(0, scroll) }));
}

/**
 * Navigates a tab to another note, pushing onto its history.
 *
 * Forward entries are discarded, the way a browser does: having gone back and then followed
 * a different link, the old forward path is no longer reachable and keeping it would offer
 * the user a "forward" that goes somewhere they never were.
 */
export function navigateTab(workspace: Workspace, tab: TabId, note: string): Workspace {
  return updateTab(workspace, tab, (current) => {
    if (current.note === note) return current;
    const kept = current.history.slice(0, current.historyIndex + 1);
    return { ...current, note, scroll: 0, history: [...kept, note], historyIndex: kept.length };
  });
}

/** Steps a tab back through its history. A no-op at the beginning. */
export function goBack(workspace: Workspace, tab: TabId): Workspace {
  return step(workspace, tab, -1);
}

/** Steps a tab forward through its history. A no-op at the end. */
export function goForward(workspace: Workspace, tab: TabId): Workspace {
  return step(workspace, tab, 1);
}

function step(workspace: Workspace, tab: TabId, delta: -1 | 1): Workspace {
  return updateTab(workspace, tab, (current) => {
    const index = current.historyIndex + delta;
    const note = current.history[index];
    if (note === undefined) return current;
    return { ...current, note, scroll: 0, historyIndex: index };
  });
}

/** Whether the back and forward gestures would do anything (§8.3). */
export function canGoBack(tab: Tab): boolean {
  return tab.historyIndex > 0;
}

export function canGoForward(tab: Tab): boolean {
  return tab.historyIndex < tab.history.length - 1;
}

/**
 * Splits a group in two and focuses the new side.
 *
 * The new pane always opens a note — `note` if given, otherwise a second view of whatever
 * the split group was showing, which is what "split right" does in every editor that has it.
 * §8.2's Cmd-Alt-click on a link is the first form; the split command is the second.
 *
 * **An empty group cannot be split.** A split of nothing is two dead panes, and it would
 * violate the invariant that no group inside a split is empty — the rule that lets `closeTab`
 * collapse without having to ask whether the hole it leaves was intentional.
 *
 * The existing group becomes the first child, so the content the user was already reading
 * stays where it was on screen.
 */
export function splitGroup(
  workspace: Workspace,
  group: GroupId,
  direction: SplitDirection,
  ids: WorkspaceIds,
  options: { readonly note?: string; readonly mode?: TabMode } = {},
): Workspace {
  const target = findGroup(workspace.root, group);
  if (target === undefined) return workspace;

  const inherited = target.tabs.find((tab) => tab.id === target.activeTab);
  const note = options.note ?? inherited?.note;
  if (note === undefined) return workspace;

  const tab: Tab = {
    id: ids.tab(),
    note,
    mode: options.mode ?? inherited?.mode ?? "edit",
    scroll: 0,
    history: [note],
    historyIndex: 0,
  };
  const fresh: TabGroup = { kind: "group", id: ids.group(), tabs: [tab], activeTab: tab.id };
  const split: SplitNode = {
    kind: "split",
    id: ids.split(),
    direction,
    ratio: 0.5,
    first: target,
    second: fresh,
  };
  return { ...workspace, root: substitute(workspace.root, group, split), focusedGroup: fresh.id };
}

/** Resizes a split. The ratio is clamped so a drag cannot produce an unusable pane. */
export function setRatio(workspace: Workspace, split: SplitId, ratio: number): Workspace {
  const clamped = clampRatio(ratio);
  const apply = (node: WorkspaceNode): WorkspaceNode => {
    if (node.kind === "group") return node;
    if (node.id === split) return { ...node, ratio: clamped };
    return { ...node, first: apply(node.first), second: apply(node.second) };
  };
  return { ...workspace, root: apply(workspace.root) };
}

/**
 * Moves a tab to another group, or to another position in its own (§8.2, draggable tabs).
 *
 * Moving the last tab out of a group collapses it, exactly as closing it would — the group
 * is empty either way, and leaving a hole behind after a drag looks like a bug.
 */
export function moveTab(
  workspace: Workspace,
  tab: TabId,
  toGroup: GroupId,
  index?: number,
): Workspace {
  const source = groupOfTab(workspace.root, tab);
  const moving = findTab(workspace.root, tab);
  if (source === undefined || moving === undefined) return workspace;
  if (findGroup(workspace.root, toGroup) === undefined) return workspace;

  if (source.id === toGroup) {
    const without = source.tabs.filter((candidate) => candidate.id !== tab);
    const at = clampIndex(index, without.length);
    const reordered = [...without.slice(0, at), moving, ...without.slice(at)];
    const root = replaceGroup(workspace.root, { ...source, tabs: reordered, activeTab: tab });
    return focusGroup({ ...workspace, root }, source.id);
  }

  // Remove first, which may collapse the source group, then insert into the destination —
  // looked up again afterwards, because a collapse rebuilds the nodes above it.
  const detached = closeTab(workspace, tab);
  const destination = findGroup(detached.root, toGroup);
  if (destination === undefined) return workspace;
  const at = clampIndex(index, destination.tabs.length);
  const grown: TabGroup = {
    ...destination,
    tabs: [...destination.tabs.slice(0, at), moving, ...destination.tabs.slice(at)],
    activeTab: tab,
  };
  return focusGroup({ ...detached, root: replaceGroup(detached.root, grown) }, toGroup);
}

/** Focuses a group, so the next opened tab lands there. Unknown ids are ignored. */
export function focusGroup(workspace: Workspace, group: GroupId): Workspace {
  if (findGroup(workspace.root, group) === undefined) return workspace;
  return { ...workspace, focusedGroup: group };
}

/**
 * Closes a whole group and collapses its split.
 *
 * Refuses to close the last group: a workspace with no group cannot be represented, and
 * cannot be drawn either.
 */
export function closeGroup(workspace: Workspace, group: GroupId): Workspace {
  const collapsed = collapse(workspace.root, group);
  if (collapsed === undefined) return workspace;
  return refocus({ ...workspace, root: collapsed });
}

// ---------------------------------------------------------------------------- invariants

/**
 * What must be true of any workspace, stated once.
 *
 * Used two ways: a property test applies random operation sequences and asserts this stays
 * empty, and [`parseWorkspace`] runs it over anything read off disk. That second use is why
 * it returns problems rather than throwing — a corrupted layout file should cost the user
 * their pane arrangement, not their session.
 */
export const INVARIANTS = [
  "every tab id is unique across the whole tree",
  "every group id is unique",
  "every split id is unique",
  "a group's active tab is one of its own tabs, and is null exactly when it has none",
  "the focused group exists",
  "no group inside a split is empty",
  "every split ratio is within the usable range",
  "every tab's history is non-empty and its index points at its current note",
] as const;

/** Every way `workspace` violates [`INVARIANTS`]. Empty means well-formed. */
export function workspaceProblems(workspace: Workspace): readonly string[] {
  const problems: string[] = [];
  const allGroups = groups(workspace.root);

  const duplicate = (label: string, seen: readonly string[]): void => {
    const repeated = seen.filter((id, at) => seen.indexOf(id) !== at);
    for (const id of new Set(repeated)) problems.push(`duplicate ${label} id: ${id}`);
  };
  duplicate("tab", tabs(workspace.root).map((tab) => tab.id));
  duplicate("group", allGroups.map((group) => group.id));
  duplicate("split", splitIds(workspace.root));

  for (const group of allGroups) {
    if (group.tabs.length === 0) {
      if (group.activeTab !== null) {
        problems.push(`empty group ${group.id} still names an active tab`);
      }
    } else if (!group.tabs.some((tab) => tab.id === group.activeTab)) {
      problems.push(`group ${group.id} has no active tab among its ${group.tabs.length}`);
    }
    for (const tab of group.tabs) {
      if (tab.history.length === 0) {
        problems.push(`tab ${tab.id} has no history`);
      } else if (tab.history[tab.historyIndex] !== tab.note) {
        problems.push(`tab ${tab.id} is on ${tab.note} but its history says otherwise`);
      }
      if (tab.scroll < 0) problems.push(`tab ${tab.id} has a negative scroll offset`);
    }
  }

  if (findGroup(workspace.root, workspace.focusedGroup) === undefined) {
    problems.push(`the focused group ${workspace.focusedGroup} does not exist`);
  }
  problems.push(...emptyGroupsInSplits(workspace.root));
  problems.push(...badRatios(workspace.root));
  return problems;
}

function splitIds(node: WorkspaceNode): readonly string[] {
  if (node.kind === "group") return [];
  return [node.id, ...splitIds(node.first), ...splitIds(node.second)];
}

function emptyGroupsInSplits(node: WorkspaceNode): readonly string[] {
  if (node.kind === "group") return [];
  const problems: string[] = [];
  for (const child of [node.first, node.second]) {
    if (child.kind === "group" && child.tabs.length === 0) {
      problems.push(`group ${child.id} is empty but sits inside split ${node.id}`);
    }
    problems.push(...emptyGroupsInSplits(child));
  }
  return problems;
}

function badRatios(node: WorkspaceNode): readonly string[] {
  if (node.kind === "group") return [];
  const problems: string[] = [];
  if (!(node.ratio >= MIN_RATIO && node.ratio <= 1 - MIN_RATIO)) {
    problems.push(`split ${node.id} has an unusable ratio of ${node.ratio}`);
  }
  return [...problems, ...badRatios(node.first), ...badRatios(node.second)];
}

// ---------------------------------------------------------------------------- internals

function resolveGroup(workspace: Workspace, requested: GroupId | undefined): GroupId {
  if (requested !== undefined && findGroup(workspace.root, requested) !== undefined) {
    return requested;
  }
  return workspace.focusedGroup;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
}

function clampIndex(index: number | undefined, length: number): number {
  if (index === undefined || !Number.isFinite(index)) return length;
  return Math.min(length, Math.max(0, Math.trunc(index)));
}

/** Replaces a group in the tree by id, keeping every other node identical. */
function replaceGroup(node: WorkspaceNode, group: TabGroup): WorkspaceNode {
  if (node.kind === "group") return node.id === group.id ? group : node;
  return { ...node, first: replaceGroup(node.first, group), second: replaceGroup(node.second, group) };
}

/** Replaces a group with an arbitrary node — how a split is introduced. */
function substitute(node: WorkspaceNode, group: GroupId, replacement: WorkspaceNode): WorkspaceNode {
  if (node.kind === "group") return node.id === group ? replacement : node;
  return {
    ...node,
    first: substitute(node.first, group, replacement),
    second: substitute(node.second, group, replacement),
  };
}

/**
 * Removes a group, replacing its parent split with the surviving sibling.
 *
 * `undefined` means the group is the root and there is nothing to collapse into — the caller
 * decides what an empty workspace looks like rather than having this invent one.
 */
function collapse(node: WorkspaceNode, group: GroupId): WorkspaceNode | undefined {
  if (node.kind === "group") return node.id === group ? undefined : node;
  if (node.first.kind === "group" && node.first.id === group) return node.second;
  if (node.second.kind === "group" && node.second.id === group) return node.first;
  const first = collapse(node.first, group);
  if (first !== undefined && first !== node.first) return { ...node, first };
  const second = collapse(node.second, group);
  if (second !== undefined && second !== node.second) return { ...node, second };
  return node;
}

/** Keeps `focusedGroup` pointing at a group that still exists, after a collapse. */
function refocus(workspace: Workspace): Workspace {
  if (findGroup(workspace.root, workspace.focusedGroup) !== undefined) return workspace;
  const surviving = groups(workspace.root)[0];
  // `groups` on any node yields at least one group, so this cannot be undefined — but the
  // fallback keeps the type honest rather than asserting it away.
  return { ...workspace, focusedGroup: surviving?.id ?? workspace.focusedGroup };
}

function updateTab(
  workspace: Workspace,
  tab: TabId,
  change: (current: Tab) => Tab,
): Workspace {
  const owner = groupOfTab(workspace.root, tab);
  const current = owner?.tabs.find((candidate) => candidate.id === tab);
  if (owner === undefined || current === undefined) return workspace;
  const updated = change(current);
  if (updated === current) return workspace;
  const root = replaceGroup(workspace.root, {
    ...owner,
    tabs: owner.tabs.map((candidate) => (candidate.id === tab ? updated : candidate)),
  });
  return { ...workspace, root };
}
