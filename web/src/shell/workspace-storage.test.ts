/**
 * Loading and saving a workspace layout (`SPEC.md` §8.1).
 *
 * The file is derived state a user may hand-edit and a crash may truncate, so most of this
 * is about what happens when it is wrong. The rule under test throughout: a bad layout file
 * costs the user their pane arrangement and nothing else — never an exception, never a
 * half-restored tree, and never a note they are not allowed to see.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  WORKSPACE_FORMAT,
  parseWorkspace,
  pruneUnreadable,
  serializeWorkspace,
} from "./workspace-storage.js";
import {
  type Workspace,
  type WorkspaceIds,
  closeTab,
  counterIds,
  createWorkspace,
  focusGroup,
  groups,
  moveTab,
  navigateTab,
  openTab,
  setRatio,
  setTabScroll,
  splitGroup,
  tabs,
  workspaceProblems,
} from "./workspace.js";

/** A workspace with two panes, three tabs, some history and a dragged ratio. */
function populated(): { workspace: Workspace; ids: WorkspaceIds } {
  const ids = counterIds();
  let workspace = createWorkspace("personal", ids);
  workspace = openTab(workspace, { note: "One.md" }, ids);
  workspace = openTab(workspace, { note: "Projects/Two.md" }, ids);
  workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, {
    note: "Three.md",
    mode: "read",
  });
  const three = tabs(workspace.root).find((tab) => tab.note === "Three.md");
  if (three === undefined) throw new Error("the split should have opened Three.md");
  workspace = navigateTab(workspace, three.id, "Four.md");
  workspace = setTabScroll(workspace, three.id, 640);
  const root = workspace.root;
  if (root.kind !== "split") throw new Error("expected a split at the root");
  return { workspace: setRatio(workspace, root.id, 0.37), ids };
}

function reload(workspace: Workspace, vault = workspace.vault): ReturnType<typeof parseWorkspace> {
  return parseWorkspace(serializeWorkspace(workspace), vault, counterIds("fresh-"));
}

describe("a round trip", () => {
  it("restores the tree, the tabs, the history, the scroll and the focus exactly", () => {
    const { workspace } = populated();
    const loaded = reload(workspace);
    expect(loaded.ok).toBe(true);
    expect(loaded.workspace).toEqual(workspace);
  });

  it("is stable, so a save with no changes produces no diff", () => {
    const { workspace } = populated();
    expect(serializeWorkspace(workspace)).toBe(serializeWorkspace(workspace));
    const loaded = reload(workspace);
    expect(serializeWorkspace(loaded.workspace)).toBe(serializeWorkspace(workspace));
  });

  it("survives any sequence of operations", () => {
    // The point of a property test here rather than more examples: the shapes that break a
    // serializer are the deep asymmetric ones, and those are tedious to write and easy to
    // stop writing after the first two.
    fc.assert(
      fc.property(fc.array(fc.nat(5), { maxLength: 30 }), (script) => {
        const ids = counterIds();
        let workspace = createWorkspace("personal", ids);
        for (const [step, choice] of script.entries()) {
          const allGroups = groups(workspace.root);
          const allTabs = tabs(workspace.root);
          const group = allGroups[choice % allGroups.length];
          const tab = allTabs[choice % Math.max(1, allTabs.length)];
          if (group === undefined) continue;
          switch (choice) {
            case 0:
              workspace = openTab(workspace, { note: `Note-${step}.md`, reuse: false }, ids);
              break;
            case 1:
              workspace = splitGroup(workspace, group.id, "vertical", ids);
              break;
            case 2:
              workspace = splitGroup(workspace, group.id, "horizontal", ids);
              break;
            case 3:
              if (tab !== undefined) workspace = closeTab(workspace, tab.id);
              break;
            case 4:
              if (tab !== undefined) workspace = moveTab(workspace, tab.id, group.id, step);
              break;
            default:
              workspace = focusGroup(workspace, group.id);
          }
        }
        const loaded = reload(workspace);
        expect(loaded.ok).toBe(true);
        expect(loaded.workspace).toEqual(workspace);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("a layout file that cannot be trusted", () => {
  const fresh = (): WorkspaceIds => counterIds("fresh-");

  it.each([
    ["not JSON at all", "{ this is not json"],
    ["empty", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "42"],
    ["missing the format", JSON.stringify({ vault: "personal", focusedGroup: "g", root: {} })],
    [
      "from a future format",
      JSON.stringify({ format: WORKSPACE_FORMAT + 1, vault: "personal", focusedGroup: "g", root: {} }),
    ],
    [
      "a root that is neither a group nor a split",
      JSON.stringify({ format: WORKSPACE_FORMAT, vault: "personal", focusedGroup: "g", root: { kind: "pane" } }),
    ],
    [
      "a split missing a child",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: { kind: "split", id: "s", direction: "vertical", ratio: 0.5, first: { kind: "group", id: "g", tabs: [], activeTab: null } },
      }),
    ],
    [
      "a tab with no note",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: { kind: "group", id: "g", tabs: [{ id: "t", mode: "edit", scroll: 0, history: [], historyIndex: 0 }], activeTab: "t" },
      }),
    ],
    [
      "a focused group that does not exist",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "nowhere",
        root: { kind: "group", id: "g", tabs: [], activeTab: null },
      }),
    ],
    [
      "two tabs sharing an id",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [
            { id: "t", note: "One.md", mode: "edit", scroll: 0, history: ["One.md"], historyIndex: 0 },
            { id: "t", note: "Two.md", mode: "edit", scroll: 0, history: ["Two.md"], historyIndex: 0 },
          ],
          activeTab: "t",
        },
      }),
    ],
    [
      "an active tab that is not in its group",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [{ id: "t", note: "One.md", mode: "edit", scroll: 0, history: ["One.md"], historyIndex: 0 }],
          activeTab: "someone-else",
        },
      }),
    ],
    [
      "a tab whose history index is not a whole number",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [{ id: "t", note: "One.md", mode: "edit", scroll: 0, history: ["One.md"], historyIndex: 0.5 }],
          activeTab: "t",
        },
      }),
    ],
    [
      "a tab with a negative scroll offset",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [{ id: "t", note: "One.md", mode: "edit", scroll: -1, history: ["One.md"], historyIndex: 0 }],
          activeTab: "t",
        },
      }),
    ],
    [
      "a tab whose history holds something other than strings",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [{ id: "t", note: "One.md", mode: "edit", scroll: 0, history: [{}], historyIndex: 0 }],
          activeTab: "t",
        },
      }),
    ],
    [
      "a history that disagrees with the current note",
      JSON.stringify({
        format: WORKSPACE_FORMAT,
        vault: "personal",
        focusedGroup: "g",
        root: {
          kind: "group",
          id: "g",
          tabs: [{ id: "t", note: "One.md", mode: "edit", scroll: 0, history: ["Elsewhere.md"], historyIndex: 0 }],
          activeTab: "t",
        },
      }),
    ],
  ])("is rejected in favour of an empty workspace when it is %s", (_label, text) => {
    const loaded = parseWorkspace(text, "personal", fresh());
    expect(loaded.ok).toBe(false);
    // Not an exception, and not a partial tree: a usable empty workspace.
    expect(workspaceProblems(loaded.workspace)).toEqual([]);
    expect(tabs(loaded.workspace.root)).toEqual([]);
    if (loaded.ok) throw new Error("unreachable");
    expect(loaded.rejection.reason).not.toBe("");
  });

  it("never throws, whatever the bytes are", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(() => parseWorkspace(text, "personal", fresh())).not.toThrow();
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("clamps a ratio rather than discarding the whole layout", () => {
    // A ratio is a drag position: 0.99 is recoverable into something usable, unlike a
    // missing child, so it is the one field worth repairing instead of rejecting.
    const { workspace } = populated();
    const stored = JSON.parse(serializeWorkspace(workspace)) as { root: { ratio: number } };
    stored.root.ratio = 40;
    const loaded = parseWorkspace(JSON.stringify(stored), "personal", fresh());
    expect(loaded.ok).toBe(true);
    const root = loaded.workspace.root;
    expect(root.kind === "split" && root.ratio).toBeLessThan(1);
    expect(workspaceProblems(loaded.workspace)).toEqual([]);
  });
});

describe("a layout stored for a different vault", () => {
  it("is rejected", () => {
    const { workspace } = populated();
    const loaded = reload(workspace, "work");
    expect(loaded.ok).toBe(false);
    expect(loaded.workspace.vault).toBe("work");
    expect(tabs(loaded.workspace.root)).toEqual([]);
  });

  it("does not name the vault it was stored for", () => {
    // §6.5: a vault the caller is not opening must not be named back at them, and a
    // rejection message is exactly the kind of place that leaks.
    const { workspace } = populated();
    const loaded = reload(workspace, "work");
    if (loaded.ok) throw new Error("expected a rejection");
    expect(loaded.rejection.reason).not.toContain("personal");
  });
});

describe("pruning notes the viewer can no longer read", () => {
  it("drops their tabs and keeps the rest", () => {
    const { workspace, ids } = populated();
    const pruned = pruneUnreadable(workspace, (note) => note !== "Projects/Two.md", ids);
    expect(tabs(pruned.root).map((tab) => tab.note)).not.toContain("Projects/Two.md");
    expect(tabs(pruned.root).map((tab) => tab.note)).toContain("One.md");
    expect(workspaceProblems(pruned)).toEqual([]);
  });

  it("collapses a pane whose every tab became unreadable", () => {
    const { workspace, ids } = populated();
    expect(groups(workspace.root)).toHaveLength(2);
    // "Four.md" is the note the split pane navigated to, and its only tab.
    const pruned = pruneUnreadable(workspace, (note) => note !== "Four.md", ids);
    expect(groups(pruned.root)).toHaveLength(1);
    expect(workspaceProblems(pruned)).toEqual([]);
  });

  it("yields an empty workspace when nothing is readable any more", () => {
    const { workspace, ids } = populated();
    const pruned = pruneUnreadable(workspace, () => false, ids);
    expect(tabs(pruned.root)).toEqual([]);
    expect(groups(pruned.root)).toHaveLength(1);
    expect(workspaceProblems(pruned)).toEqual([]);
  });

  it("keeps the focus on a pane that still exists", () => {
    const { workspace, ids } = populated();
    const pruned = pruneUnreadable(workspace, (note) => note !== "Four.md", ids);
    expect(groups(pruned.root).some((group) => group.id === pruned.focusedGroup)).toBe(true);
  });

  it("leaves a fully readable workspace untouched", () => {
    const { workspace, ids } = populated();
    expect(pruneUnreadable(workspace, () => true, ids)).toEqual(workspace);
  });
});
