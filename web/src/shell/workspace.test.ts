/**
 * The workspace state model (`SPEC.md` §8.1).
 *
 * Two halves. The unit tests below pin the behaviours a user would notice — which tab takes
 * over when one closes, what a split inherits, where a dragged tab lands. The property test
 * at the bottom applies random operation sequences and asserts `workspaceProblems` stays
 * empty, which is what actually caught the collapse rules: an empty pane left inside a split
 * is trivially reachable by a sequence nobody would think to write by hand.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  MIN_RATIO,
  type Tab,
  type TabGroup,
  type Workspace,
  activateTab,
  activeTab,
  canGoBack,
  canGoForward,
  closeGroup,
  closeTab,
  counterIds,
  createWorkspace,
  findGroup,
  findTab,
  focusGroup,
  goBack,
  goForward,
  groupOfTab,
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

/** A workspace with `notes` open in one group, and the ids used to build it. */
function withNotes(...notes: readonly string[]): { workspace: Workspace; ids: ReturnType<typeof counterIds> } {
  const ids = counterIds();
  let workspace = createWorkspace("personal", ids);
  for (const note of notes) {
    workspace = openTab(workspace, { note, reuse: false }, ids);
  }
  return { workspace, ids };
}

function noteOrder(workspace: Workspace): readonly string[] {
  return tabs(workspace.root).map((tab) => tab.note);
}

/**
 * Positional accessors that fail with a readable message.
 *
 * why: not `tabs(ws)[1]!`. `noUncheckedIndexedAccess` is on for a reason and AGENTS.md §4.3
 * rules out the assertion; more usefully, a broken test then reports "expected 2 open tabs,
 * found 1" instead of a `TypeError` on the next line.
 */
function tabAt(workspace: Workspace, index: number): Tab {
  const all = tabs(workspace.root);
  const tab = all[index];
  if (tab === undefined) {
    throw new Error(`expected a tab at ${index}, found ${all.length} open`);
  }
  return tab;
}

function groupAt(workspace: Workspace, index: number): TabGroup {
  const all = groups(workspace.root);
  const group = all[index];
  if (group === undefined) {
    throw new Error(`expected a group at ${index}, found ${all.length}`);
  }
  return group;
}

function tabById(workspace: Workspace, id: string): Tab {
  const tab = findTab(workspace.root, id);
  if (tab === undefined) throw new Error(`no tab ${id} is open`);
  return tab;
}

function tabOnNote(workspace: Workspace, note: string): Tab {
  const tab = tabs(workspace.root).find((candidate) => candidate.note === note);
  if (tab === undefined) throw new Error(`no tab is open on ${note}`);
  return tab;
}

function activeOf(workspace: Workspace): Tab {
  const tab = activeTab(workspace);
  if (tab === undefined) throw new Error("no tab is active");
  return tab;
}

describe("an empty workspace", () => {
  it("is one focused group with nothing in it", () => {
    const workspace = createWorkspace("personal", counterIds());
    expect(groups(workspace.root)).toHaveLength(1);
    expect(tabs(workspace.root)).toEqual([]);
    expect(findGroup(workspace.root, workspace.focusedGroup)).toBeDefined();
    expect(activeTab(workspace)).toBeUndefined();
    expect(workspaceProblems(workspace)).toEqual([]);
  });

  it("cannot be split, because a split of nothing is two dead panes", () => {
    const workspace = createWorkspace("personal", counterIds());
    const split = splitGroup(workspace, workspace.focusedGroup, "vertical", counterIds("b"));
    expect(split).toBe(workspace);
  });
});

describe("opening a note", () => {
  it("adds a tab, activates it, and starts its history", () => {
    const { workspace } = withNotes("One.md");
    const tab = activeTab(workspace);
    expect(tab?.note).toBe("One.md");
    expect(tab?.mode).toBe("edit");
    expect(tab?.history).toEqual(["One.md"]);
    expect(canGoBack(activeOf(workspace))).toBe(false);
  });

  it("reuses an existing tab on the same note by default", () => {
    const ids = counterIds();
    let workspace = createWorkspace("personal", ids);
    workspace = openTab(workspace, { note: "One.md" }, ids);
    const first = activeTab(workspace)?.id;
    workspace = openTab(workspace, { note: "Two.md" }, ids);
    workspace = openTab(workspace, { note: "One.md" }, ids);

    expect(noteOrder(workspace)).toEqual(["One.md", "Two.md"]);
    expect(activeTab(workspace)?.id).toBe(first);
  });

  it("opens a second tab on the same note when asked, for cmd-click", () => {
    // §8.2 gives both gestures, so both have to be expressible rather than one being policy.
    const { workspace } = withNotes("One.md", "One.md");
    expect(noteOrder(workspace)).toEqual(["One.md", "One.md"]);
  });

  it("falls back to the focused group when handed a stale group id", () => {
    // A stale id arrives from a UI event that raced a close. Losing the user's click is
    // worse than opening it one pane over.
    const ids = counterIds();
    const workspace = openTab(
      createWorkspace("personal", ids),
      { note: "One.md", group: "group-does-not-exist" },
      ids,
    );
    expect(noteOrder(workspace)).toEqual(["One.md"]);
  });
});

describe("closing a tab", () => {
  it("activates the tab to the right, not the first one", () => {
    // why: closing a run of tabs left to right should walk forward through them rather than
    // jumping back to the start each time. This is muscle memory, and getting it wrong is
    // the kind of thing nobody files a bug about and everybody notices.
    const { workspace } = withNotes("One.md", "Two.md", "Three.md");
    const two = tabAt(workspace, 1);
    const after = closeTab(activateTab(workspace, two.id), two.id);
    expect(activeTab(after)?.note).toBe("Three.md");
  });

  it("falls back to the left when the rightmost tab closes", () => {
    const { workspace } = withNotes("One.md", "Two.md");
    const two = tabAt(workspace, 1);
    const after = closeTab(workspace, two.id);
    expect(activeTab(after)?.note).toBe("One.md");
  });

  it("leaves the active tab alone when a different one closes", () => {
    const { workspace } = withNotes("One.md", "Two.md", "Three.md");
    const focused = activateTab(workspace, tabAt(workspace, 2).id);
    const after = closeTab(focused, tabAt(workspace, 0).id);
    expect(activeTab(after)?.note).toBe("Three.md");
  });

  it("collapses the split when a pane loses its last tab", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Two.md" });
    expect(groups(workspace.root)).toHaveLength(2);

    const two = tabOnNote(workspace, "Two.md");
    const after = closeTab(workspace, two.id);
    expect(after.root.kind).toBe("group");
    expect(noteOrder(after)).toEqual(["One.md"]);
    expect(findGroup(after.root, after.focusedGroup)).toBeDefined();
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("collapses a pane nested three splits deep, leaving the rest of the tree alone", () => {
    // The recursive case. A collapse two levels down has to rebuild the nodes above it and
    // nothing else — the property test reaches this shape constantly but asserts only that
    // the result is well-formed, not that the *right* pane survived.
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Two.md" });
    workspace = splitGroup(workspace, workspace.focusedGroup, "horizontal", ids, { note: "Three.md" });
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Four.md" });
    expect(groups(workspace.root)).toHaveLength(4);

    const three = tabOnNote(workspace, "Three.md");
    const after = closeTab(workspace, three.id);

    expect(groups(after.root)).toHaveLength(3);
    expect(noteOrder(after)).toEqual(["One.md", "Two.md", "Four.md"]);
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("leaves an empty root group rather than no workspace at all", () => {
    const { workspace } = withNotes("One.md");
    const after = closeTab(workspace, tabAt(workspace, 0).id);
    expect(groups(after.root)).toHaveLength(1);
    expect(tabs(after.root)).toEqual([]);
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("ignores an unknown tab id", () => {
    const { workspace } = withNotes("One.md");
    expect(closeTab(workspace, "tab-nope")).toBe(workspace);
  });
});

describe("splitting", () => {
  it("inherits the note and mode the pane was showing", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md", mode: "read" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "horizontal", ids);

    expect(groups(workspace.root)).toHaveLength(2);
    expect(noteOrder(workspace)).toEqual(["One.md", "One.md"]);
    expect(activeTab(workspace)?.mode).toBe("read");
    expect(workspaceProblems(workspace)).toEqual([]);
  });

  it("focuses the new pane and keeps the old content on the same side", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    const original = workspace.focusedGroup;
    workspace = splitGroup(workspace, original, "vertical", ids, { note: "Two.md" });

    expect(workspace.focusedGroup).not.toBe(original);
    const root = workspace.root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") throw new Error("unreachable");
    expect(root.first.kind === "group" && root.first.id).toBe(original);
    expect(activeTab(workspace)?.note).toBe("Two.md");
  });

  it("clamps a resize so a drag cannot produce an unusable pane", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids);
    const split = workspace.root;
    if (split.kind !== "split") throw new Error("expected a split");

    for (const [asked, expected] of [
      [0, MIN_RATIO],
      [1, 1 - MIN_RATIO],
      [-4, MIN_RATIO],
      [Number.NaN, 0.5],
      [0.3, 0.3],
    ] as const) {
      const resized = setRatio(workspace, split.id, asked);
      const node = resized.root;
      expect(node.kind === "split" && node.ratio).toBeCloseTo(expected);
    }
  });
});

describe("dragging a tab", () => {
  it("reorders within its own group", () => {
    const { workspace } = withNotes("One.md", "Two.md", "Three.md");
    const three = tabAt(workspace, 2);
    const after = moveTab(workspace, three.id, workspace.focusedGroup, 0);
    expect(noteOrder(after)).toEqual(["Three.md", "One.md", "Two.md"]);
    expect(activeTab(after)?.note).toBe("Three.md");
  });

  it("moves to another group, keeping the tab's history", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = openTab(workspace, { note: "Two.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Three.md" });
    const right = groupAt(workspace, 1);
    const two = tabOnNote(workspace, "Two.md");
    const travelled = navigateTab(workspace, two.id, "Elsewhere.md");

    const after = moveTab(travelled, two.id, right.id, 0);
    expect(groupOfTab(after.root, two.id)?.id).toBe(right.id);
    expect(findTab(after.root, two.id)?.history).toEqual(["Two.md", "Elsewhere.md"]);
    expect(after.focusedGroup).toBe(right.id);
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("collapses the source pane when its last tab is dragged out", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Two.md" });
    const left = groupAt(workspace, 0);
    const two = tabOnNote(workspace, "Two.md");

    const after = moveTab(workspace, two.id, left.id);
    expect(after.root.kind).toBe("group");
    expect(noteOrder(after)).toEqual(["One.md", "Two.md"]);
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("ignores a move to a group that does not exist", () => {
    const { workspace } = withNotes("One.md");
    expect(moveTab(workspace, tabAt(workspace, 0).id, "group-nope")).toBe(workspace);
  });
});

describe("a tab's navigation history", () => {
  it("pushes on navigation and walks back and forward", () => {
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    let after = navigateTab(workspace, id, "Two.md");
    after = navigateTab(after, id, "Three.md");

    expect(findTab(after.root, id)?.history).toEqual(["One.md", "Two.md", "Three.md"]);
    expect(findTab(after.root, id)?.note).toBe("Three.md");

    after = goBack(after, id);
    expect(findTab(after.root, id)?.note).toBe("Two.md");
    after = goBack(after, id);
    expect(findTab(after.root, id)?.note).toBe("One.md");
    after = goForward(after, id);
    expect(findTab(after.root, id)?.note).toBe("Two.md");
  });

  it("truncates the forward path when a new link is followed", () => {
    // Browser behaviour, and for the browser's reason: after going back and branching, the
    // old forward path is unreachable, and offering it sends the user somewhere they never
    // were.
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    let after = navigateTab(workspace, id, "Two.md");
    after = navigateTab(after, id, "Three.md");
    after = goBack(after, id);
    expect(findTab(after.root, id)?.note).toBe("Two.md");
    expect(canGoForward(tabById(after, id))).toBe(true);

    after = navigateTab(after, id, "Four.md");
    expect(findTab(after.root, id)?.history).toEqual(["One.md", "Two.md", "Four.md"]);
    expect(canGoForward(tabById(after, id))).toBe(false);
  });

  it("does nothing at either end", () => {
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    expect(goBack(workspace, id)).toBe(workspace);
    expect(goForward(workspace, id)).toBe(workspace);
  });

  it("does not push a navigation to the note already open", () => {
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    expect(navigateTab(workspace, id, "One.md")).toBe(workspace);
  });

  it("resets the scroll offset on navigation, and keeps it otherwise", () => {
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    const scrolled = setTabScroll(workspace, id, 420);
    expect(findTab(scrolled.root, id)?.scroll).toBe(420);
    expect(findTab(navigateTab(scrolled, id, "Two.md").root, id)?.scroll).toBe(0);
    // A negative offset is not representable: it comes from a layout mid-bounce on iOS.
    expect(findTab(setTabScroll(workspace, id, -30).root, id)?.scroll).toBe(0);
  });
});

describe("the mobile projection (§8.3)", () => {
  it("is the active tab of the focused group, with the rest of the tree intact", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Two.md" });
    const left = groupAt(workspace, 0);

    expect(activeTab(workspace)?.note).toBe("Two.md");
    // Focusing the other pane is what a phone's tab switcher does; nothing is destroyed.
    const switched = focusGroup(workspace, left.id);
    expect(activeTab(switched)?.note).toBe("One.md");
    expect(groups(switched.root)).toHaveLength(2);
  });
});

describe("closing a group", () => {
  it("collapses its split", () => {
    const ids = counterIds();
    let workspace = openTab(createWorkspace("personal", ids), { note: "One.md" }, ids);
    workspace = splitGroup(workspace, workspace.focusedGroup, "vertical", ids, { note: "Two.md" });
    const right = groupAt(workspace, 1);

    const after = closeGroup(workspace, right.id);
    expect(after.root.kind).toBe("group");
    expect(noteOrder(after)).toEqual(["One.md"]);
    expect(workspaceProblems(after)).toEqual([]);
  });

  it("refuses to close the last one, which cannot be drawn", () => {
    const { workspace } = withNotes("One.md");
    expect(closeGroup(workspace, workspace.focusedGroup)).toBe(workspace);
  });
});

describe("setTabMode", () => {
  it("switches between editing and reading", () => {
    const { workspace } = withNotes("One.md");
    const id = tabAt(workspace, 0).id;
    expect(findTab(setTabMode(workspace, id, "read").root, id)?.mode).toBe("read");
  });

  it("ignores an unknown tab", () => {
    const { workspace } = withNotes("One.md");
    expect(setTabMode(workspace, "tab-nope", "read")).toBe(workspace);
  });
});

// ---------------------------------------------------------------------------- properties

/** One operation to apply, as data, so a counterexample prints as a readable sequence. */
type Action =
  | { readonly op: "open"; readonly note: string; readonly reuse: boolean }
  | { readonly op: "close"; readonly at: number }
  | { readonly op: "activate"; readonly at: number }
  | { readonly op: "split"; readonly at: number; readonly direction: "horizontal" | "vertical" }
  | { readonly op: "move"; readonly tab: number; readonly group: number; readonly index: number }
  | { readonly op: "closeGroup"; readonly at: number }
  | { readonly op: "focus"; readonly at: number }
  | { readonly op: "navigate"; readonly at: number; readonly note: string }
  | { readonly op: "back"; readonly at: number }
  | { readonly op: "forward"; readonly at: number }
  | { readonly op: "ratio"; readonly at: number; readonly ratio: number }
  | { readonly op: "scroll"; readonly at: number; readonly scroll: number };

const NOTES = ["One.md", "Two.md", "Three.md", "Projects/Four.md"];

const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ op: fc.constant("open" as const), note: fc.constantFrom(...NOTES), reuse: fc.boolean() }),
  fc.record({ op: fc.constant("close" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("activate" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("split" as const), at: fc.nat(9), direction: fc.constantFrom("horizontal" as const, "vertical" as const) }),
  fc.record({ op: fc.constant("move" as const), tab: fc.nat(9), group: fc.nat(9), index: fc.nat(9) }),
  fc.record({ op: fc.constant("closeGroup" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("focus" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("navigate" as const), at: fc.nat(9), note: fc.constantFrom(...NOTES) }),
  fc.record({ op: fc.constant("back" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("forward" as const), at: fc.nat(9) }),
  fc.record({ op: fc.constant("ratio" as const), at: fc.nat(9), ratio: fc.double({ min: -2, max: 3, noNaN: false }) }),
  fc.record({ op: fc.constant("scroll" as const), at: fc.nat(9), scroll: fc.integer({ min: -100, max: 5000 }) }),
);

/** Indexes are taken modulo what exists, so a random action almost always does something. */
function apply(workspace: Workspace, step: Action, ids: ReturnType<typeof counterIds>): Workspace {
  const allTabs = tabs(workspace.root);
  const allGroups = groups(workspace.root);
  const allSplits = collectSplits(workspace.root);
  const tabAt = (at: number): string | undefined => allTabs[at % Math.max(1, allTabs.length)]?.id;
  const groupAt = (at: number): string | undefined => allGroups[at % Math.max(1, allGroups.length)]?.id;

  switch (step.op) {
    case "open":
      return openTab(workspace, { note: step.note, reuse: step.reuse }, ids);
    case "close": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : closeTab(workspace, id);
    }
    case "activate": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : activateTab(workspace, id);
    }
    case "split": {
      const id = groupAt(step.at);
      return id === undefined ? workspace : splitGroup(workspace, id, step.direction, ids);
    }
    case "move": {
      const tab = tabAt(step.tab);
      const group = groupAt(step.group);
      return tab === undefined || group === undefined ? workspace : moveTab(workspace, tab, group, step.index);
    }
    case "closeGroup": {
      const id = groupAt(step.at);
      return id === undefined ? workspace : closeGroup(workspace, id);
    }
    case "focus": {
      const id = groupAt(step.at);
      return id === undefined ? workspace : focusGroup(workspace, id);
    }
    case "navigate": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : navigateTab(workspace, id, step.note);
    }
    case "back": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : goBack(workspace, id);
    }
    case "forward": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : goForward(workspace, id);
    }
    case "ratio": {
      const id = allSplits[step.at % Math.max(1, allSplits.length)];
      return id === undefined ? workspace : setRatio(workspace, id, step.ratio);
    }
    case "scroll": {
      const id = tabAt(step.at);
      return id === undefined ? workspace : setTabScroll(workspace, id, step.scroll);
    }
  }
}

function collectSplits(node: Workspace["root"]): readonly string[] {
  return node.kind === "group" ? [] : [node.id, ...collectSplits(node.first), ...collectSplits(node.second)];
}

describe("under any sequence of operations", () => {
  it("stays well-formed", () => {
    // The invariants are stated once, in `workspaceProblems`, and this is what makes them
    // worth stating: no hand-written test would have found that closing the last tab in a
    // nested split leaves an empty pane inside its grandparent.
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (script) => {
        const ids = counterIds();
        let workspace = createWorkspace("personal", ids);
        for (const step of script) {
          workspace = apply(workspace, step, ids);
          const problems = workspaceProblems(workspace);
          if (problems.length > 0) {
            throw new Error(`${step.op} left the workspace broken: ${problems.join("; ")}`);
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it("never loses the focused group and never forgets which tab is active", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (script) => {
        const ids = counterIds();
        let workspace = createWorkspace("personal", ids);
        for (const step of script) workspace = apply(workspace, step, ids);

        expect(findGroup(workspace.root, workspace.focusedGroup)).toBeDefined();
        for (const group of groups(workspace.root)) {
          if (group.tabs.length === 0) {
            expect(group.activeTab).toBeNull();
          } else {
            expect(group.tabs.some((tab) => tab.id === group.activeTab)).toBe(true);
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("keeps every group reachable, so no pane is stranded off-screen", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (script) => {
        const ids = counterIds();
        let workspace = createWorkspace("personal", ids);
        for (const step of script) workspace = apply(workspace, step, ids);

        // A split always has two children, so the group count and the split count are tied:
        // n groups need exactly n-1 splits. A mismatch means a dangling or duplicated node.
        expect(collectSplits(workspace.root).length).toBe(groups(workspace.root).length - 1);
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
