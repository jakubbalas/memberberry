/**
 * The live workspace store (`SPEC.md` §8.1).
 *
 * The pure model is already covered by property tests in `workspace.test.ts`. What is left
 * to pin here is what the store adds on top: that a no-op mutation does not cause a write,
 * that a mutation which would produce an invalid workspace is dropped rather than applied,
 * and that scroll — which fires continuously — does not persist on its own.
 */

import { describe, expect, it } from "vitest";

import { WorkspaceStore, emptyWorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { type Workspace, createWorkspace, groups, tabs } from "./workspace.js";

/** Records what the store asked to be saved. */
function recorder() {
  const saved: Workspace[] = [];
  return {
    persistence: {
      save: (workspace: Workspace): void => {
        saved.push(workspace);
      },
    },
    get saved(): readonly Workspace[] {
      return saved;
    },
  };
}

function store(overrides: Partial<ConstructorParameters<typeof WorkspaceStore>[0]> = {}) {
  const ids = sessionIds();
  return new WorkspaceStore({ initial: createWorkspace("personal", ids), ids, ...overrides });
}

describe("session ids", () => {
  it("are unique, because a counter would collide with a reloaded layout", () => {
    // The failure this prevents: a counter restarting at 1 next session collides with the
    // ids already in the stored layout, `workspaceProblems` rejects the result, and the
    // user silently loses their panes.
    const ids = sessionIds();
    const minted = new Set([
      ids.tab(),
      ids.tab(),
      ids.group(),
      ids.group(),
      ids.split(),
      ids.split(),
    ]);
    expect(minted.size).toBe(6);
    for (const id of minted) expect(id).toMatch(/^(tab|group|split)-[0-9a-f]{16}$/);
  });
});

describe("mutations", () => {
  it("open a note and report it as the active tab", () => {
    const workspace = store();
    workspace.open("One.md");
    expect(workspace.activeTab?.note).toBe("One.md");
    expect(workspace.tabs).toHaveLength(1);
  });

  it("persist every change that actually changed something", () => {
    const log = recorder();
    const workspace = store({ persistence: log.persistence });

    workspace.open("One.md");
    workspace.open("Two.md");
    expect(log.saved).toHaveLength(2);
    expect(log.saved[1]).toBe(workspace.current);
  });

  it("do not persist a mutation that was a no-op", () => {
    // Every operation returns the same workspace when it would change nothing, so this is
    // what stops a rejected click writing an identical layout on every keypress.
    const log = recorder();
    const workspace = store({ persistence: log.persistence });
    workspace.open("One.md");
    expect(log.saved).toHaveLength(1);

    workspace.close("tab-does-not-exist");
    workspace.activate("tab-does-not-exist");
    workspace.focus("group-does-not-exist");
    workspace.move("tab-does-not-exist", "group-does-not-exist");
    expect(log.saved).toHaveLength(1);
  });

  it("do not persist a scroll on its own", () => {
    // Scrolling fires continuously; a save per event would defeat the debounce it shares
    // with everything else. The next real mutation carries the offset.
    const log = recorder();
    const workspace = store({ persistence: log.persistence });
    workspace.open("One.md");
    const tab = workspace.activeTab;
    if (tab === undefined) throw new Error("expected an open tab");

    workspace.setScroll(tab.id, 320);
    expect(log.saved).toHaveLength(1);
    expect(workspace.activeTab?.scroll).toBe(320);

    workspace.setMode(tab.id, "read");
    expect(log.saved).toHaveLength(2);
    expect(log.saved[1]?.root.kind === "group" && log.saved[1]?.root.tabs[0]?.scroll).toBe(320);
  });

  it("split a pane and focus the new one", () => {
    const workspace = store();
    workspace.open("One.md");
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");

    expect(workspace.groups).toHaveLength(2);
    expect(workspace.activeTab?.note).toBe("Two.md");
  });

  it("close a pane and collapse its split", () => {
    const workspace = store();
    workspace.open("One.md");
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    workspace.closePane(workspace.focusedGroup);

    expect(workspace.groups).toHaveLength(1);
    expect(workspace.tabs.map((tab) => tab.note)).toEqual(["One.md"]);
  });
});

describe("a mutation that would produce an unusable workspace", () => {
  /** A workspace with two tabs sharing an id — invalid, and not reachable through the API. */
  function corrupted(): Workspace {
    const tab = {
      id: "duplicate",
      note: "One.md",
      mode: "edit" as const,
      scroll: 0,
      history: ["One.md"],
      historyIndex: 0,
    };
    return {
      vault: "personal",
      focusedGroup: "g",
      root: { kind: "group", id: "g", tabs: [tab, { ...tab }], activeTab: "duplicate" },
    };
  }

  it("is dropped and reported rather than applied", () => {
    // Unreachable through today's operations — that is what the property tests say — but
    // "should be unreachable" is not "cannot happen", and the alternative is a pane tree the
    // layout cannot render. Starting from an already-broken workspace is how that future
    // bug is simulated: any operation on it returns something still broken.
    const rejected: Array<{ operation: string; problems: readonly string[] }> = [];
    const log = recorder();
    const workspace = new WorkspaceStore({
      initial: corrupted(),
      persistence: log.persistence,
      onRejected: (operation, problems) => rejected.push({ operation, problems }),
    });
    const before = workspace.current;

    workspace.open("Two.md");

    expect(workspace.current).toBe(before);
    expect(log.saved).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.operation).toBe("open");
    expect(rejected[0]?.problems.join(" ")).toContain("duplicate tab id");
  });

  it("reports on the console by default, so it never looks like a dead UI", () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    try {
      new WorkspaceStore({ initial: corrupted() }).open("Two.md");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("unusable workspace");
  });
});

describe("an empty store", () => {
  it("starts with one focused pane and nothing open", () => {
    const workspace = emptyWorkspaceStore("personal");
    expect(groups(workspace.current.root)).toHaveLength(1);
    expect(tabs(workspace.current.root)).toEqual([]);
    expect(workspace.activeTab).toBeUndefined();
  });
});
