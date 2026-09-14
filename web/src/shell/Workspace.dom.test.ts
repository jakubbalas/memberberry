// @vitest-environment jsdom

/**
 * The desktop workspace shell (`SPEC.md` §8.2).
 *
 * `openNoteSurface` is injected, so no test here builds a Tiptap editor or a socket — what
 * is under test is the *layout*: that the pane tree renders, that a split produces two panes
 * and a divider, that only the active tab of each pane holds an editor, and that every
 * pointer gesture has a keyboard equivalent (§8.4).
 *
 * That last one is the reason half of these exist. Native drag-and-drop is not keyboard
 * operable at all, so "tabs are draggable" and "tabs can be moved by keyboard" are two
 * separate features that have to be tested separately, or the second silently never ships.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import Workspace from "./Workspace.svelte";
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "../editor/links.js";
import type { resolveNote } from "./open-note.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

/**
 * Records which notes have live editors.
 *
 * Counting alone is not enough: rendering the *wrong* tab still opens exactly one editor per
 * pane, so a count-only assertion passes while the pane shows a note the user did not select.
 * That gap was real — this stub grew the note list after a deliberate break slipped through.
 */
function surfaces() {
  let opened = 0;
  let destroyed = 0;
  const live = new Set<string>();
  const open = async (options: OpenNoteSurfaceOptions): Promise<NoteSurface> => {
    opened += 1;
    const note = options.bootstrap?.note ?? "(local)";
    live.add(note);
    return {
      destroy: async () => {
        destroyed += 1;
        live.delete(note);
      },
    };
  };
  return {
    open,
    get live(): number {
      return opened - destroyed;
    },
    get opened(): number {
      return opened;
    },
    /** The notes currently holding an editor, sorted so assertions are stable. */
    get notes(): readonly string[] {
      return [...live].sort();
    },
  };
}

/** A `localStorage` stand-in, so sidebar state does not leak between tests. */
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

let target: HTMLElement;

beforeEach(() => {
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

/**
 * Mounts the shell and returns a teardown, so no test leaks a mounted component.
 *
 * `open` is always injected, even when a test does not care about it. Left out, the real
 * `openNoteSurface` runs and reaches for IndexedDB, which jsdom does not have — the failure
 * surfaces as an unhandled rejection from a component effect rather than as a test failure,
 * which is the most confusing shape a broken test can take.
 */
function render(
  workspace: WorkspaceStore,
  open?: ReturnType<typeof surfaces>["open"],
  resolveLink?: typeof resolveNote,
  home = false,
) {
  const app = mount(Workspace, {
    target,
    props: {
      store: workspace,
      home,
      session: { vault: "personal", user: "alice" },
      chrome: chrome(),
      open: open ?? surfaces().open,
      ...(resolveLink === undefined ? {} : { resolveLink }),
      // The commands listen on a target rather than on the shell element, because a `div`
      // cannot hold focus. Injected here so a test drives them without touching `window`.
      target: commands,
      // Pinned so the suite does not depend on the runner's platform.
      platform: "mac" as const,
      // A wide viewport, so the sidebars start open as they do on desktop.
      mode: "desktop" as const,
    },
  });
  return () => unmount(app);
}

/** Where the shell's keyboard commands are dispatched in these tests. */
let commands: EventTarget;

const tabs = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('[role="tab"]')];
const panes = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>(".pane")];

describe("the shell", () => {
  it("keeps saved tabs on Home without mounting an editor until a note opens", async () => {
    const workspace = store(["One.md"]);
    const opened = surfaces();
    const teardown = render(workspace, opened.open, undefined, true);
    try {
      await flush();
      expect(target.querySelector("#home-heading")?.textContent).toBe("Home");
      expect(opened.live).toBe(0);
      workspace.open("One.md");
      await flush();
      expect(target.querySelector("#home-heading")).toBeNull();
      expect(opened.notes).toEqual(["One.md"]);
      expect(workspace.tabs).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  it("starts in Notes and switches tools without discarding their elements", async () => {
    const teardown = render(store());
    try {
      const tools = target.querySelector('[aria-label="Navigation views"]');
      const search = target.querySelector<HTMLInputElement>('.search-panel input[type="search"]');
      const searchView = target.querySelector<HTMLElement>('.navigation-view[aria-label="Search"]');
      expect(searchView?.hidden).toBe(true);
      tools?.querySelector<HTMLButtonElement>('[aria-label="Search"]')?.click();
      await flush();
      expect(searchView?.hidden).toBe(false);
      expect(target.querySelector<HTMLElement>('.navigation-view[aria-label="Notes"]')?.hidden).toBe(true);
      tools?.querySelector<HTMLButtonElement>('[aria-label="Notes"]')?.click();
      await flush();
      expect(searchView?.hidden).toBe(true);
      expect(target.querySelector('.search-panel input[type="search"]')).toBe(search);
    } finally {
      await teardown();
    }
  });

  it("shows the authenticated account and a logout link", () => {
    const teardown = render(store());
    try {
      const logout = target.querySelector<HTMLAnchorElement>('.account-logout');
      expect(target.querySelector('.account-user')?.textContent).toBe("alice");
      expect(logout?.getAttribute("href")).toBe("/logout");
      expect(logout?.textContent).toBe("Log out");
    } finally {
      teardown();
    }
  });

  it("renders both sidebars and a main area", () => {
    const teardown = render(store());
    try {
      expect(target.querySelector('[aria-label="Navigation"]')).not.toBeNull();
      expect(target.querySelector('[aria-label="Context"]')).not.toBeNull();
      expect(target.querySelector(".workspace-main")).not.toBeNull();
    } finally {
      teardown();
    }
  });

  it("fills both sidebars, and each panel says what it is", () => {
    // A reader should be able to tell unfinished from broken. Both sidebars now have
    // content — the note tree on the left, backlinks on the right — so the placeholder is
    // gone and what is left to check is that neither panel is silently missing.
    const teardown = render(store());
    try {
      expect([...target.querySelectorAll(".sidebar-placeholder")]).toHaveLength(0);
      expect(target.querySelector('[aria-label="Navigation"] .tree-panel')).not.toBeNull();
      expect(target.querySelector('[aria-label="Navigation"] .inbox-panel')).not.toBeNull();
      expect(target.querySelector('[aria-label="Context"] .backlinks-panel')).not.toBeNull();
      expect(target.querySelector(".topbar .theme-panel")).not.toBeNull();
      // And not left behind in the panel it used to be a card in.
      expect(target.querySelector('[aria-label="Context"] .theme-panel')).toBeNull();
    } finally {
      teardown();
    }
  });

  it("shows an empty pane rather than nothing when no note is open", () => {
    const teardown = render(store());
    try {
      expect(panes()).toHaveLength(1);
      expect(target.querySelector(".note-pane.is-empty")).not.toBeNull();
      expect(tabs()).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe("tabs", () => {
  it("are a tablist, so a screen reader reports position rather than a row of buttons", () => {
    const teardown = render(store(["One.md", "Two.md"]));
    try {
      expect(target.querySelector('[role="tablist"]')).not.toBeNull();
      expect(tabs()).toHaveLength(2);
      expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
      expect(tabs()[0]?.getAttribute("aria-selected")).toBe("false");
    } finally {
      teardown();
    }
  });

  it("show the note's own name but carry the full path for a reader who needs it", () => {
    const teardown = render(store(["Projects/Roadmap.md"]));
    try {
      expect(tabs()[0]?.querySelector(".tab-label")?.textContent).toBe("Roadmap");
      expect(tabs()[0]?.getAttribute("title")).toBe("Projects/Roadmap.md");
    } finally {
      teardown();
    }
  });

  it("opens the rename menu from a tab context click", async () => {
    const teardown = render(store(["Projects/Roadmap.md"]));
    try {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 70 });
      tabs()[0]?.dispatchEvent(event);
      await tick();
      expect(event.defaultPrevented).toBe(true);
      expect([...target.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toContain("Rename");
    } finally {
      teardown();
    }
  });

  it("opens a duplicate tab from a tab context menu", async () => {
    const workspace = store(["Projects/Roadmap.md"]);
    const teardown = render(workspace);
    try {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      tabs()[0]?.dispatchEvent(event);
      await tick();
      [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === "Open in new tab")
        ?.click();
      await tick();
      expect(workspace.tabs).toHaveLength(2);
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Projects/Roadmap.md", "Projects/Roadmap.md"]);
    } finally {
      teardown();
    }
  });

  it("activate on click", async () => {
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      tabs()[0]?.click();
      await tick();
      expect(workspace.activeTab?.note).toBe("One.md");
    } finally {
      teardown();
    }
  });

  it("close from their own button", async () => {
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      const close = tabs()[0]?.querySelector<HTMLButtonElement>(".tab-close");
      expect(close?.getAttribute("aria-label")).toBe("Close One");
      close?.click();
      await tick();
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Two.md"]);
    } finally {
      teardown();
    }
  });

  it("move focus and selection with the arrow keys", async () => {
    const workspace = store(["One.md", "Two.md", "Three.md"]);
    const teardown = render(workspace);
    try {
      expect(workspace.activeTab?.note).toBe("Three.md");
      tabs()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await tick();
      expect(workspace.activeTab?.note).toBe("Two.md");
    } finally {
      teardown();
    }
  });

  it("move the tab itself with cmd-shift-arrow, which is the drag's keyboard equivalent", async () => {
    // §8.4: no mouse-only feature ships, and native drag-and-drop is not keyboard operable
    // at all — so this is a separate feature from the drag, and needs its own test.
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      const second = tabs()[1];
      second?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      await tick();
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Two.md", "One.md"]);
    } finally {
      teardown();
    }
  });

  it("close with Delete while focused", async () => {
    const workspace = store(["One.md"]);
    const teardown = render(workspace);
    try {
      tabs()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
      await tick();
      expect(workspace.tabs).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe("splits", () => {
  it("render two panes and a divider between them", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await tick();
      expect(panes()).toHaveLength(2);
      const divider = target.querySelector('[role="separator"]');
      expect(divider?.getAttribute("aria-orientation")).toBe("vertical");
      expect(divider?.getAttribute("aria-valuenow")).toBe("50");
    } finally {
      teardown();
    }
  });

  it("resize from the keyboard, and report the new position to assistive technology", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      const divider = target.querySelector<HTMLElement>('[role="separator"]');
      divider?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await tick();
      expect(target.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("52");

      divider?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      await tick();
      expect(target.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")).toBe("12");
    } finally {
      teardown();
    }
  });

  it("open from cmd-backslash, so a split is reachable without a menu", async () => {
    const workspace = store(["One.md"]);
    const teardown = render(workspace);
    try {
      // The listener is registered by an effect, which runs after mount rather than during
      // it — dispatching synchronously beats it there.
      await tick();
      commands.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
      await tick();
      expect(panes()).toHaveLength(2);
      // Inherited from the pane that was split, which is what "split right" means.
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["One.md", "One.md"]);
    } finally {
      teardown();
    }
  });

  it("collapse when a pane loses its last tab", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await tick();
      expect(panes()).toHaveLength(2);

      const two = workspace.tabs.find((tab) => tab.note === "Two.md");
      if (two === undefined) throw new Error("expected a tab on Two.md");
      workspace.close(two.id);
      await tick();

      expect(panes()).toHaveLength(1);
      expect(target.querySelector('[role="separator"]')).toBeNull();
    } finally {
      teardown();
    }
  });
});

describe("editors", () => {
  it("exist only for the active tab of each pane", async () => {
    // The memory claim in `NotePane`: four open panes should cost four editors, not four
    // times the number of tabs. §21.2 budgets 250 MB for a whole vault on a phone.
    const workspace = store(["One.md", "Two.md", "Three.md"]);
    const live = surfaces();
    const teardown = render(workspace, live.open);
    try {
      await flush();
      expect(workspace.tabs).toHaveLength(3);
      expect(live.live).toBe(1);
      // And it is the *active* tab's note. Without this, rendering the first tab in every
      // pane satisfies the count while showing the user something they did not select.
      expect(live.notes).toEqual(["Three.md"]);
    } finally {
      teardown();
    }
  });

  it("are released when their pane closes", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const live = surfaces();
    const teardown = render(workspace, live.open);
    try {
      await flush();
      expect(live.notes).toEqual(["One.md", "Two.md"]);

      workspace.closePane(workspace.focusedGroup);
      await flush();
      expect(live.notes).toEqual(["One.md"]);
    } finally {
      teardown();
    }
  });

  it("survive a scroll, which changes the tab but not which note it shows", async () => {
    // The store is immutable, so recording a scroll offset hands the pane a *new* tab object
    // with the same id and note. An effect that reads a field off the prop re-runs for that
    // new object and tears the editor down — and since rebuilding restores the scroll, and
    // restoring scrolls, the result was a loop that mounted dozens of editors a second. Found
    // in a browser (the outline announced a note that was permanently at offset zero); this
    // is the version of it a unit suite can see.
    const workspace = store(["One.md"]);
    const live = surfaces();
    const teardown = render(workspace, live.open);
    try {
      await flush();
      expect(live.opened).toBe(1);

      const tab = workspace.activeTab;
      if (tab === undefined) throw new Error("expected an open tab");
      workspace.setScroll(tab.id, 240);
      await flush();
      workspace.setScroll(tab.id, 480);
      await flush();

      expect(live.opened).toBe(1);
      expect(live.notes).toEqual(["One.md"]);
    } finally {
      teardown();
    }
  });

  it("are rebuilt when the tab navigates, because an editor cannot be re-pointed", async () => {
    const workspace = store(["One.md"]);
    const live = surfaces();
    const teardown = render(workspace, live.open);
    try {
      await flush();
      expect(live.opened).toBe(1);

      const tab = workspace.activeTab;
      if (tab === undefined) throw new Error("expected an open tab");
      workspace.navigate(tab.id, "Two.md");
      await flush();

      expect(live.opened).toBe(2);
      expect(live.notes).toEqual(["Two.md"]);
    } finally {
      teardown();
    }
  });

  it("are all released when the shell unmounts", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const live = surfaces();
    const teardown = render(workspace, live.open);
    await flush();
    expect(live.live).toBe(2);

    teardown();
    await flush();
    expect(live.live).toBe(0);
  });
});

describe("sidebars", () => {
  it("collapse and expand, keeping the control that reopens them reachable", async () => {
    // Collapsing a sidebar must not remove the only way back. That is a keyboard trap, not
    // a styling detail, which is why the toggle lives outside the collapsible region — in
    // the top bar, which is outside *both* of them.
    const teardown = render(store());
    try {
      const toggle = target.querySelector<HTMLButtonElement>(
        '.topbar .sidebar-toggle[data-side="left"]',
      );
      const panel = target.querySelector('[aria-label="Navigation"]');
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(panel?.hasAttribute("hidden")).toBe(false);

      toggle?.click();
      await tick();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(target.querySelector('[aria-label="Navigation"]')?.hasAttribute("hidden")).toBe(true);
      // Still in the document, still focusable.
      expect(target.querySelector('.topbar .sidebar-toggle[data-side="left"]')).not.toBeNull();
    } finally {
      teardown();
    }
  });

  it("are reachable by keyboard through their own buttons", async () => {
    // §8.4 requires every action to be reachable by keyboard, not that every action has a
    // shortcut. `Cmd+B` deliberately has no binding here: it is bold, and an application
    // built around a rich text editor must not steal it. Remappable hotkeys are their own
    // milestone item.
    const teardown = render(store());
    try {
      const toggle = target.querySelector<HTMLButtonElement>(
        '.topbar .sidebar-toggle[data-side="left"]',
      );
      expect(toggle?.tagName).toBe("BUTTON");
      toggle?.focus();
      expect(document.activeElement).toBe(toggle);

      toggle?.click();
      await tick();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    } finally {
      teardown();
    }
  });

  it("start closed on a narrow viewport, because an open drawer covers the note", async () => {
    // Below the §8.3 breakpoint a sidebar overlays the content. Open on arrival, it covers
    // the note and swallows taps meant for the tab strip — which is how the E2E mobile
    // project found this, after every mobile test failed to click anything.
    const app = mount(Workspace, {
      target,
      props: {
        store: store(["One.md"]),
        session: { vault: "personal", user: "alice" },
        chrome: chrome(),
        open: surfaces().open,
        target: commands,
        platform: "mac" as const,
        mode: "mobile" as const,
      },
    });
    try {
      for (const side of ["left", "right"]) {
        expect(
          target
            .querySelector(`.topbar .sidebar-toggle[data-side="${side}"]`)
            ?.getAttribute("aria-expanded"),
        ).toBe("false");
      }
    } finally {
      unmount(app);
    }
  });

  it("remember their state across a remount", async () => {
    const preferences = chrome();
    const first = mount(Workspace, {
      target,
      props: {
        store: store(),
        session: { vault: "personal", user: "alice" },
        chrome: preferences,
        open: surfaces().open,
        target: commands,
        platform: "mac" as const,
        mode: "desktop" as const,
      },
    });
    target
      .querySelector<HTMLButtonElement>('.topbar .sidebar-toggle[data-side="left"]')
      ?.click();
    await tick();
    unmount(first);

    const second = mount(Workspace, {
      target,
      props: {
        store: store(),
        session: { vault: "personal", user: "alice" },
        chrome: preferences,
        open: surfaces().open,
        target: commands,
        platform: "mac" as const,
        mode: "desktop" as const,
      },
    });
    try {
      expect(
        target
          .querySelector('.topbar .sidebar-toggle[data-side="left"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      unmount(second);
    }
  });
});

describe("dragging", () => {
  /**
   * A `DataTransfer` stand-in.
   *
   * jsdom does not implement one, and `DragEvent` there carries `dataTransfer: null`. The
   * handlers only use `getData`, `setData`, `types`, `effectAllowed` and `dropEffect`, so a
   * small object is enough — and closer to the real thing than mocking the handlers would be.
   */
  function dataTransfer() {
    const values = new Map<string, string>();
    return {
      setData: (type: string, value: string): void => {
        values.set(type, value);
      },
      getData: (type: string): string => values.get(type) ?? "",
      get types(): string[] {
        return [...values.keys()];
      },
      effectAllowed: "none",
      dropEffect: "none",
    };
  }

  /** Fires a drag event carrying `transfer`, which jsdom will not do on its own. */
  function drag(element: Element, type: string, transfer: ReturnType<typeof dataTransfer>): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    element.dispatchEvent(event);
    return event;
  }

  it("carries the tab id in the drag payload, so another pane's strip can read it", () => {
    const teardown = render(store(["One.md", "Two.md"]));
    try {
      const transfer = dataTransfer();
      drag(tabs()[0] as Element, "dragstart", transfer);
      expect(transfer.types).toEqual(["application/x-memberberry-tab"]);
      expect(transfer.getData("application/x-memberberry-tab")).not.toBe("");
      expect(transfer.effectAllowed).toBe("move");
    } finally {
      teardown();
    }
  });

  it("accepts the drop, which the browser refuses unless dragover is prevented", async () => {
    // Without `preventDefault` on `dragover` the browser rejects the drop and the tab springs
    // back with no explanation — a bug that looks like nothing happening.
    const teardown = render(store(["One.md", "Two.md"]));
    try {
      const transfer = dataTransfer();
      drag(tabs()[1] as Element, "dragstart", transfer);
      const over = drag(tabs()[0] as Element, "dragover", transfer);
      expect(over.defaultPrevented).toBe(true);
      expect(transfer.dropEffect).toBe("move");

      await tick();
      expect(tabs()[0]?.getAttribute("data-drop-before")).toBe("true");
    } finally {
      teardown();
    }
  });

  it("ignores a drag that is not one of ours", () => {
    // A file dragged onto the tab strip must not be treated as a tab move.
    const teardown = render(store(["One.md"]));
    try {
      const foreign = dataTransfer();
      foreign.setData("text/plain", "some text");
      const over = drag(tabs()[0] as Element, "dragover", foreign);
      expect(over.defaultPrevented).toBe(false);
    } finally {
      teardown();
    }
  });

  it("reorders on drop", async () => {
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      const transfer = dataTransfer();
      drag(tabs()[1] as Element, "dragstart", transfer);
      drag(tabs()[0] as Element, "drop", transfer);
      await tick();
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Two.md", "One.md"]);
    } finally {
      teardown();
    }
  });

  it("drops onto the empty space past the last tab, which means 'put it at the end'", async () => {
    // Without a target there, releasing in the obvious blank area does nothing, which reads
    // as a broken drag rather than as a missing drop zone.
    const workspace = store(["One.md", "Two.md"]);
    const teardown = render(workspace);
    try {
      const transfer = dataTransfer();
      drag(tabs()[0] as Element, "dragstart", transfer);
      const rest = target.querySelector(".tab-strip-rest");
      expect(rest).not.toBeNull();
      drag(rest as Element, "drop", transfer);
      await tick();
      expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Two.md", "One.md"]);
    } finally {
      teardown();
    }
  });

  it("clears the drop indicator when the drag ends without a drop", async () => {
    const teardown = render(store(["One.md", "Two.md"]));
    try {
      const transfer = dataTransfer();
      drag(tabs()[1] as Element, "dragstart", transfer);
      drag(tabs()[0] as Element, "dragover", transfer);
      await tick();
      expect(tabs()[0]?.getAttribute("data-drop-before")).toBe("true");

      drag(tabs()[1] as Element, "dragend", transfer);
      await tick();
      expect(tabs()[0]?.getAttribute("data-drop-before")).toBe("false");
    } finally {
      teardown();
    }
  });
});

describe("dragging a split divider", () => {
  /** jsdom implements neither pointer capture nor layout, so both are supplied. */
  function prepare(divider: HTMLElement, split: HTMLElement): void {
    const captured = new Set<number>();
    divider.setPointerCapture = (id: number): void => {
      captured.add(id);
    };
    divider.releasePointerCapture = (id: number): void => {
      captured.delete(id);
    };
    divider.hasPointerCapture = (id: number): boolean => captured.has(id);
    split.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, x: 0, y: 0 }) as DOMRect;
  }

  function pointer(type: string, x: number, y: number): PointerEvent {
    // jsdom has no PointerEvent constructor; a MouseEvent carries the fields used here.
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(event, "pointerId", { value: 1 });
    return event as unknown as PointerEvent;
  }

  it("resizes proportionally to the split's own box", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await tick();
      const divider = target.querySelector<HTMLElement>(".pane-divider");
      const split = target.querySelector<HTMLElement>(".pane-split");
      if (divider === null || split === null) throw new Error("expected a split and a divider");
      prepare(divider, split);

      divider.dispatchEvent(pointer("pointerdown", 500, 400));
      divider.dispatchEvent(pointer("pointermove", 300, 400));
      await tick();
      // 300 of 1000 across, so 30%.
      expect(target.querySelector(".pane-divider")?.getAttribute("aria-valuenow")).toBe("30");
    } finally {
      teardown();
    }
  });

  it("ignores movement it never captured, so a stray pointer cannot resize a pane", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await tick();
      const divider = target.querySelector<HTMLElement>(".pane-divider");
      const split = target.querySelector<HTMLElement>(".pane-split");
      if (divider === null || split === null) throw new Error("expected a split and a divider");
      prepare(divider, split);

      // No `pointerdown` first: the pointer is down on something else and merely passing over.
      divider.dispatchEvent(pointer("pointermove", 200, 400));
      await tick();
      expect(target.querySelector(".pane-divider")?.getAttribute("aria-valuenow")).toBe("50");
    } finally {
      teardown();
    }
  });

  it("stops resizing once the pointer is released", async () => {
    const workspace = store(["One.md"]);
    workspace.split(workspace.focusedGroup, "vertical", "Two.md");
    const teardown = render(workspace);
    try {
      await tick();
      const divider = target.querySelector<HTMLElement>(".pane-divider");
      const split = target.querySelector<HTMLElement>(".pane-split");
      if (divider === null || split === null) throw new Error("expected a split and a divider");
      prepare(divider, split);

      divider.dispatchEvent(pointer("pointerdown", 500, 400));
      divider.dispatchEvent(pointer("pointermove", 400, 400));
      divider.dispatchEvent(pointer("pointerup", 400, 400));
      divider.dispatchEvent(pointer("pointermove", 900, 400));
      await tick();
      expect(target.querySelector(".pane-divider")?.getAttribute("aria-valuenow")).toBe("40");
    } finally {
      teardown();
    }
  });
});

describe("following a link out of a note (SPEC 8.2, 9.2)", () => {
  /**
   * Raises the event an editor raises, from inside the pane it would come from.
   *
   * `await flush()` before the first one is load-bearing: the shell attaches its listener in
   * an effect, and Svelte runs effects after the mount rather than during it. Dispatching
   * straight after `render` reaches an element nobody is listening on yet — which looks
   * exactly like a feature that was never wired up.
   */
  function follow(detail: Partial<OpenNoteDetail> = {}, from?: Element): void {
    const pane = from ?? target.querySelector(".editor-surface") ?? target.querySelector(".pane");
    if (pane === null || pane === undefined) throw new Error("no pane to raise the event from");
    pane.dispatchEvent(
      new CustomEvent<OpenNoteDetail>(OPEN_NOTE_EVENT, {
        bubbles: true,
        detail: {
          target: "Roadmap",
          anchorKind: "none",
          anchor: null,
          intent: "here",
          resolved: false,
          ...detail,
        },
      }),
    );
  }

  it("resolves the reference and navigates the pane it came from", async () => {
    // The wiring nothing else covers: `embed-view.dom.test.ts` proves the event is raised
    // and `open-note.test.ts` proves the store does the right thing with it, and between
    // those two sat a listener that could simply not be attached.
    const workspace = store(["Q3.md"]);
    const teardown = render(workspace, undefined, async () => ({
      note: "Projects/Roadmap.md",
      title: "The Plan",
    }));
    await flush();
    follow();
    await flush();
    expect(workspace.activeTab?.note).toBe("Projects/Roadmap.md");
    expect(workspace.tabs).toHaveLength(1);
    teardown();
  });

  it("resolves relative to the note the pane is showing", async () => {
    const seen: string[] = [];
    const workspace = store(["Projects/Q3.md"]);
    const teardown = render(workspace, undefined, async (_vault, _target, from) => {
      seen.push(from);
      return { note: "A.md", title: null };
    });
    await flush();
    follow();
    await flush();
    expect(seen).toEqual(["Projects/Q3.md"]);
    teardown();
  });

  it("opens a tab for Mod-click and a split for Mod-Alt-click", async () => {
    const workspace = store(["Q3.md"]);
    const teardown = render(workspace, undefined, async () => ({ note: "A.md", title: null }));
    await flush();
    follow({ intent: "tab" });
    await flush();
    expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Q3.md", "A.md"]);
    follow({ intent: "split", target: "B" });
    await flush();
    expect(panes()).toHaveLength(2);
    teardown();
  });

  it("does not resolve a path the server already resolved", async () => {
    let asked = 0;
    const workspace = store(["Q3.md"]);
    const teardown = render(workspace, undefined, async () => {
      asked += 1;
      return { note: "Elsewhere.md", title: null };
    });
    await flush();
    follow({ target: "Projects/Roadmap.md", resolved: true });
    await flush();
    expect(asked).toBe(0);
    expect(workspace.activeTab?.note).toBe("Projects/Roadmap.md");
    teardown();
  });

  it("leaves the workspace alone when the reference resolves to nothing", async () => {
    const workspace = store(["Q3.md"]);
    const teardown = render(workspace, undefined, async () => undefined);
    await flush();
    follow();
    await flush();
    expect(workspace.tabs.map((tab) => tab.note)).toEqual(["Q3.md"]);
    teardown();
  });

  it("stops listening when the shell is unmounted", async () => {
    // The order here is the test. Unmounting first and asserting nothing happened would pass
    // just as well against a listener that was never attached, which is the shape a
    // teardown test most often takes and the least useful one — so the listener is proven
    // live first, and only then taken away.
    let asked = 0;
    const workspace = store(["Q3.md"]);
    const teardown = render(workspace, undefined, async () => {
      asked += 1;
      return { note: "A.md", title: null };
    });
    await flush();
    const pane = target.querySelector(".editor-surface");
    if (pane === null) throw new Error("no pane");
    follow({}, pane);
    await flush();
    expect(asked).toBe(1);

    teardown();
    follow({}, pane);
    await flush();
    expect(asked).toBe(1);
  });
});
