// @vitest-environment jsdom

/**
 * The mobile layout (`SPEC.md` §8.3).
 *
 * The claim that matters is that this is *the same state model*, drawn differently — so most
 * of these are about what mobile does **not** do: it does not fork the workspace, it does not
 * lose the panes a wider device made, and it does not hold editors for what it is not showing.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import Workspace from "./Workspace.svelte";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

/** Records which notes hold a live editor. */
function surfaces() {
  const live = new Set<string>();
  const open = async (options: OpenNoteSurfaceOptions): Promise<NoteSurface> => {
    const note = options.bootstrap?.note ?? "(local)";
    live.add(note);
    return {
      destroy: async () => {
        live.delete(note);
      },
    };
  };
  return {
    open,
    get notes(): readonly string[] {
      return [...live].sort();
    },
  };
}

function chrome() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
}

function store(notes: readonly string[] = []): WorkspaceStore {
  const ids = sessionIds();
  const workspace = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  for (const note of notes) workspace.open(note);
  return workspace;
}

/**
 * jsdom implements `<dialog>` as an element but not as a dialog: `showModal`, `close` and the
 * `open` property it maintains are all missing.
 *
 * Polyfilled here rather than worked around in the component. `<dialog>` is what buys focus
 * trapping, Escape and an inert page behind the sheet, and every browser this application
 * targets has it — degrading the component to keep a test runner happy would trade a real
 * accessibility guarantee for a fake green.
 */
function teachJsdomAboutDialogs(): void {
  const proto = globalThis.HTMLDialogElement?.prototype as
    | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
    | undefined;
  if (proto === undefined || typeof proto.showModal === "function") return;
  proto.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  proto.close = function close(this: HTMLDialogElement): void {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}

let target: HTMLElement;
let commands: EventTarget;

beforeEach(() => {
  teachJsdomAboutDialogs();
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
  commands = new EventTarget();
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
};

function render(
  workspace: WorkspaceStore,
  mode: "mobile" | "tablet" | "desktop" = "mobile",
  open?: ReturnType<typeof surfaces>["open"],
) {
  const app = mount(Workspace, {
    target,
    props: {
      store: workspace,
      session: { vault: "personal", user: "alice" },
      chrome: chrome(),
      open: open ?? surfaces().open,
      target: commands,
      mode,
    },
  });
  return () => unmount(app);
}

const panes = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>(".pane")];
const sheet = (): HTMLDialogElement | null => target.querySelector("dialog.tab-sheet");

describe("the mobile layout", () => {
  it("renders one document and no tab strip", async () => {
    const teardown = render(store(["One.md", "Two.md"]));
    try {
      await flush();
      expect(target.querySelector(".mobile-main")).not.toBeNull();
      // §8.3: a single active document. The desktop tab strip is not part of it.
      expect(target.querySelector('[role="tablist"]')).toBeNull();
      expect(panes()).toHaveLength(0);
    } finally {
      teardown();
    }
  });

  it("keeps the whole pane tree in state while rendering only the active leaf", async () => {
    // The load-bearing claim of §8: one state model, two layouts. A layout made on a laptop
    // must survive being opened on a phone, not be flattened by it.
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const live = surfaces();
    const teardown = render(workspace, "mobile", live.open);
    try {
      await flush();
      expect(workspace.groups).toHaveLength(2);
      expect(workspace.tabs).toHaveLength(2);
      // …and only the focused leaf holds an editor.
      expect(live.notes).toEqual(["Two.md"]);
    } finally {
      teardown();
    }
  });

  it("refuses to split, because a second pane would be invisible", async () => {
    // An invisible pane still holds an editor, a Y.Doc and a socket — a memory cost with
    // nothing to show for it (§21.2).
    const workspace = store(["One.md"]);
    const teardown = render(workspace);
    try {
      await tick();
      commands.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
      await tick();
      expect(workspace.groups).toHaveLength(1);
    } finally {
      teardown();
    }
  });
});

describe("the mobile navigation bar", () => {
  it("walks the active tab's history, and disables what cannot be done", async () => {
    const workspace = store(["One.md"]);
    const teardown = render(workspace);
    try {
      await flush();
      const back = target.querySelector<HTMLButtonElement>('[aria-label="Back"]');
      const forward = target.querySelector<HTMLButtonElement>('[aria-label="Forward"]');
      expect(back?.disabled).toBe(true);
      expect(forward?.disabled).toBe(true);

      const tab = workspace.activeTab;
      if (tab === undefined) throw new Error("expected an open tab");
      workspace.navigate(tab.id, "Two.md");
      await tick();
      expect(target.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.disabled).toBe(false);

      target.querySelector<HTMLButtonElement>('[aria-label="Back"]')?.click();
      await tick();
      expect(workspace.activeTab?.note).toBe("One.md");
      expect(target.querySelector<HTMLButtonElement>('[aria-label="Forward"]')?.disabled).toBe(
        false,
      );

      target.querySelector<HTMLButtonElement>('[aria-label="Forward"]')?.click();
      await tick();
      expect(workspace.activeTab?.note).toBe("Two.md");
    } finally {
      teardown();
    }
  });

  it("shows how many notes are open and which one is showing", async () => {
    const teardown = render(store(["One.md", "Projects/Two.md"]));
    try {
      await flush();
      expect(target.querySelector(".mobile-bar-count")?.textContent).toBe("2");
      expect(target.querySelector(".mobile-bar-note")?.textContent).toBe("Two.md");
    } finally {
      teardown();
    }
  });
});

describe("the tab switcher sheet", () => {
  it("lists every open tab, including ones in panes this layout is not showing", async () => {
    // On mobile the sheet is the *only* route to a tab in another pane — there is no strip
    // to click and no second pane on screen.
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();

      const names = [...target.querySelectorAll(".tab-sheet-name")].map((n) => n.textContent);
      expect(names).toEqual(["One", "Two"]);
    } finally {
      teardown();
    }
  });

  it("is a real dialog, so focus, Escape and the backdrop are the browser's job", async () => {
    const teardown = render(store(["One.md"]));
    try {
      await flush();
      expect(sheet()?.open).toBe(false);

      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();
      expect(sheet()?.open).toBe(true);
      expect(sheet()?.getAttribute("aria-label")).toBe("Open notes");
    } finally {
      teardown();
    }
  });

  it("activates a tab and closes itself", async () => {
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();

      const first = target.querySelector<HTMLButtonElement>(".tab-sheet-open");
      first?.click();
      await tick();

      expect(workspace.activeTab?.note).toBe("One.md");
      expect(sheet()?.open).toBe(false);
    } finally {
      teardown();
    }
  });

  it("closes a tab without closing the sheet", async () => {
    // Closing several in a row is the point of the sheet; dismissing after each one would
    // make it useless for exactly the task it exists for.
    const workspace = store(["One.md", "Two.md", "Three.md"]);
    const teardown = render(workspace);
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();

      target.querySelector<HTMLButtonElement>(".tab-sheet-close")?.click();
      await tick();
      expect(workspace.tabs).toHaveLength(2);
      expect(sheet()?.open).toBe(true);
    } finally {
      teardown();
    }
  });

  it("marks which tab is showing", async () => {
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();

      const current = target.querySelectorAll('[aria-current="true"]');
      expect(current).toHaveLength(1);
      expect(current[0]?.textContent).toContain("Two");
    } finally {
      teardown();
    }
  });

  it("says so when nothing is open, rather than showing an empty box", async () => {
    const teardown = render(store());
    try {
      await flush();
      target.querySelector<HTMLButtonElement>(".mobile-bar-tabs")?.click();
      await tick();
      expect(target.querySelector(".tab-sheet-empty")?.textContent).toContain("Nothing is open");
    } finally {
      teardown();
    }
  });
});

describe("the tablet layout", () => {
  it("renders the whole tree like a desktop", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace, "tablet");
    try {
      await flush();
      expect(panes()).toHaveLength(2);
      expect(target.querySelector(".mobile-main")).toBeNull();
    } finally {
      teardown();
    }
  });

  it("allows one split and no more, as §8.3 requires", async () => {
    const workspace = store(["One.md"]);
    const teardown = render(workspace, "tablet");
    try {
      await tick();
      commands.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
      await tick();
      expect(workspace.groups).toHaveLength(2);

      commands.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
      await tick();
      expect(workspace.groups, "a tablet gets at most one split").toHaveLength(2);
    } finally {
      teardown();
    }
  });

  it("keeps panes a wider device made, rather than closing them", async () => {
    // The limit is on *adding* panes. Silently closing one because the window narrowed would
    // discard a layout the user built, and there is nowhere to put the tab it was showing.
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    workspace.split(workspace.focusedGroup, "horizontal", "Three.md");
    const teardown = render(workspace, "tablet");
    try {
      await flush();
      expect(workspace.groups).toHaveLength(3);
      expect(panes()).toHaveLength(3);
    } finally {
      teardown();
    }
  });
});
