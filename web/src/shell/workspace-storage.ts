/**
 * Reading and writing a workspace layout (`SPEC.md` §8.1).
 *
 * The layout lives at `.memberberry/workspace/<user>/<device-id>.json` and is **not synced**
 * — a phone and a 32" monitor legitimately differ, and syncing panes between them is
 * user-hostile.
 *
 * Everything here is about not trusting the file. It is derived state under `.memberberry/`,
 * so Invariant I1 (§22.4) says deleting it must cost nothing, and a user may hand-edit it or
 * a half-written one may survive a crash. [`parseWorkspace`] therefore validates structurally
 * *and* against `workspaceProblems`, and returns a fresh workspace rather than throwing when
 * either fails: a corrupt layout file costs the user their pane arrangement, never their
 * session. AGENTS.md §4.3 — validate everything crossing the wire, in both directions.
 *
 * Validation is hand-written rather than `zod`. The shape is recursive and small, the
 * predicates are the same ones `workspace.ts` already states, and this module sits on the
 * critical bundle path where a schema library is 12KB for one type (§21.2).
 */

import {
  MIN_RATIO,
  type SplitDirection,
  type SplitNode,
  type Tab,
  type TabGroup,
  type TabMode,
  type Workspace,
  type WorkspaceIds,
  type WorkspaceNode,
  createWorkspace,
  workspaceProblems,
} from "./workspace.js";

/**
 * Bumped when a shape change would make an older file unreadable.
 *
 * A file from a future version is discarded rather than guessed at, which is the safe
 * direction for state that is cheap to rebuild and confusing to half-restore.
 */
export const WORKSPACE_FORMAT = 1;

/** What is written to disk. */
export interface StoredWorkspace {
  readonly format: number;
  readonly vault: string;
  readonly focusedGroup: string;
  readonly root: unknown;
}

/** Why a stored layout was rejected. Reported, never thrown. */
export interface WorkspaceRejection {
  readonly reason: string;
}

export type WorkspaceLoad =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly workspace: Workspace; readonly rejection: WorkspaceRejection };

/** Serializes a workspace. Stable key order, so a no-op save produces no diff. */
export function serializeWorkspace(workspace: Workspace): string {
  return JSON.stringify(
    {
      format: WORKSPACE_FORMAT,
      vault: workspace.vault,
      focusedGroup: workspace.focusedGroup,
      root: workspace.root,
    },
    null,
    2,
  );
}

/**
 * Parses a stored layout, falling back to an empty workspace.
 *
 * `vault` is the vault the caller is actually opening, and a file naming a different one is
 * rejected: the tab list would be full of notes from somewhere else, and under §6.5 a note
 * from another vault must not even be named here.
 */
export function parseWorkspace(
  text: string,
  vault: string,
  ids: WorkspaceIds,
): WorkspaceLoad {
  const fresh = createWorkspace(vault, ids);
  const reject = (reason: string): WorkspaceLoad => ({
    ok: false,
    workspace: fresh,
    rejection: { reason },
  });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return reject(`not JSON: ${error instanceof Error ? error.message : "unknown"}`);
  }
  if (!isRecord(raw)) return reject("not an object");
  if (raw["format"] !== WORKSPACE_FORMAT) {
    return reject(`unsupported format ${String(raw["format"])}, expected ${WORKSPACE_FORMAT}`);
  }
  if (raw["vault"] !== vault) {
    // Deliberately does not echo the stored vault name (§6.5).
    return reject("stored for a different vault");
  }
  const focusedGroup = raw["focusedGroup"];
  if (typeof focusedGroup !== "string") return reject("focusedGroup is not a string");

  const root = parseNode(raw["root"]);
  if (root === undefined) return reject("the pane tree is malformed");

  const workspace: Workspace = { vault, root, focusedGroup };
  const problems = workspaceProblems(workspace);
  if (problems.length > 0) {
    // A structurally valid file can still be a nonsensical workspace — a duplicated tab id,
    // an active tab that is not in its group, a ratio of 40. Running the same invariants the
    // operations maintain means there is one definition of "well-formed", not two.
    return reject(`violates ${problems.length} invariant(s): ${problems.join("; ")}`);
  }
  return { ok: true, workspace };
}

function parseNode(value: unknown): WorkspaceNode | undefined {
  if (!isRecord(value)) return undefined;
  if (value["kind"] === "group") return parseGroup(value);
  if (value["kind"] === "split") return parseSplit(value);
  return undefined;
}

function parseGroup(value: Record<string, unknown>): TabGroup | undefined {
  const id = value["id"];
  const rawTabs = value["tabs"];
  const activeTab = value["activeTab"];
  if (typeof id !== "string" || !Array.isArray(rawTabs)) return undefined;
  if (activeTab !== null && typeof activeTab !== "string") return undefined;

  const parsed: Tab[] = [];
  for (const entry of rawTabs) {
    const tab = parseTab(entry);
    if (tab === undefined) return undefined;
    parsed.push(tab);
  }
  return { kind: "group", id, tabs: parsed, activeTab };
}

function parseSplit(value: Record<string, unknown>): SplitNode | undefined {
  const id = value["id"];
  const direction = value["direction"];
  const ratio = value["ratio"];
  if (typeof id !== "string" || !isDirection(direction)) return undefined;
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return undefined;
  // Clamped rather than rejected: a ratio is a drag position, and a file holding 0.99 is
  // recoverable into something usable, unlike a missing child.
  const clamped = Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));
  const first = parseNode(value["first"]);
  const second = parseNode(value["second"]);
  if (first === undefined || second === undefined) return undefined;
  return { kind: "split", id, direction, ratio: clamped, first, second };
}

function parseTab(value: unknown): Tab | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const note = value["note"];
  const mode = value["mode"];
  const scroll = value["scroll"];
  const history = value["history"];
  const historyIndex = value["historyIndex"];
  if (typeof id !== "string" || typeof note !== "string" || !isMode(mode)) return undefined;
  if (typeof scroll !== "number" || !Number.isFinite(scroll) || scroll < 0) return undefined;
  if (!Array.isArray(history) || !history.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  if (typeof historyIndex !== "number" || !Number.isInteger(historyIndex)) return undefined;
  return { id, note, mode, scroll, history, historyIndex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirection(value: unknown): value is SplitDirection {
  return value === "horizontal" || value === "vertical";
}

function isMode(value: unknown): value is TabMode {
  return value === "edit" || value === "read";
}

/**
 * Drops tabs on notes the viewer can no longer read.
 *
 * A layout is a list of note paths, and a revocation between sessions means it may name one
 * the user has lost access to. Restoring that tab would put an unreadable path in the tab
 * bar — a title leak under §6.5, and from a file the user's own client wrote. The server
 * decides `readable`; this only applies the answer.
 *
 * Returns the pruned workspace, or a fresh one if nothing survived.
 */
export function pruneUnreadable(
  workspace: Workspace,
  readable: (note: string) => boolean,
  ids: WorkspaceIds,
): Workspace {
  const prune = (node: WorkspaceNode): WorkspaceNode | undefined => {
    if (node.kind === "group") {
      const kept = node.tabs.filter((tab) => readable(tab.note));
      if (kept.length === 0) return undefined;
      const active = kept.some((tab) => tab.id === node.activeTab)
        ? node.activeTab
        : (kept[0]?.id ?? null);
      return { ...node, tabs: kept, activeTab: active };
    }
    const first = prune(node.first);
    const second = prune(node.second);
    // A split whose side lost every tab collapses into the survivor, the same way closing
    // the last tab in a pane does. Both sides gone means the whole subtree goes.
    if (first === undefined) return second;
    if (second === undefined) return first;
    return { ...node, first, second };
  };

  const root = prune(workspace.root);
  if (root === undefined) return createWorkspace(workspace.vault, ids);
  const pruned: Workspace = { ...workspace, root };
  const focused = groupsOf(root).some((group) => group.id === workspace.focusedGroup);
  if (focused) return pruned;
  return { ...pruned, focusedGroup: groupsOf(root)[0]?.id ?? workspace.focusedGroup };
}

function groupsOf(node: WorkspaceNode): readonly TabGroup[] {
  return node.kind === "group" ? [node] : [...groupsOf(node.first), ...groupsOf(node.second)];
}
