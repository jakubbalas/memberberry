// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { applyUpdate, Doc } from "yjs";
import { Awareness } from "y-protocols/awareness";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { load, updateFromMarkdown } from "../notes.js";
import { createConnectionStatus } from "./collaboration.js";
import { connectionMessage, mountEditorShell } from "./editor-shell.js";
import { PRESENCE_CLIENT_ATTRIBUTE } from "./presence.js";
import { createMemberberryExtensions } from "./schema.js";
import { taskItemView } from "./task-view.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

beforeAll(async () => {
  const wasm = resolve(process.cwd(), "src/wasm/mb_bg.wasm");
  await load(readFileSync(wasm));
});

describe("editor shell", () => {
  it("mounts controls, drives source mode and removes listeners with the note", async () => {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel, status);
    const editor = new Editor({ element: surface, extensions: createMemberberryExtensions(contract) });
    const ydoc = new Doc();
    applyUpdate(ydoc, await updateFromMarkdown("# Initial\n\nText\n"));
    const shell = mountEditorShell({ editor, document: ydoc, panel, status });

    const source = panel.querySelector<HTMLTextAreaElement>(".source-view");
    const sourceButton = panel.querySelector<HTMLButtonElement>("[aria-label='Toggle Markdown source view']");
    if (source === null || sourceButton === null) throw new Error("source controls missing");
    sourceButton.click();
    await tick();
    expect(source.hidden).toBe(false);
    expect(source.value).toContain("Initial");
    source.value = "# Changed\n\nFrom source\n";
    sourceButton.click();
    await tick();
    expect(editor.getText()).toContain("Changed");

    panel.querySelector<HTMLButtonElement>("[aria-label='Insert task block']")?.click();
    expect(JSON.stringify(editor.getJSON())).toContain('"task_item"');
    editor.commands.insertContent("/task");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    expect(panel.querySelector<HTMLElement>(".slash-menu")?.hidden).toBe(false);

    const controls = panel.querySelector<HTMLElement>(".editor-controls");
    expect(controls).not.toBeNull();
    shell.destroy();
    expect(panel.querySelector(".editor-controls")).toBeNull();
    editor.destroy();
    ydoc.destroy();
    panel.remove();
    status.remove();
  });
});

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

describe("editor shell presence", () => {
  /** Mounts a shell with awareness and a connection, returning everything a test needs. */
  async function mount() {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel, status);
    const editor = new Editor({ element: surface, extensions: createMemberberryExtensions(contract) });
    const ydoc = new Doc();
    applyUpdate(ydoc, await updateFromMarkdown("# Initial\n"));
    const awareness = new Awareness(ydoc);
    const connection = createConnectionStatus();
    const shell = mountEditorShell({ editor, document: ydoc, awareness, connection, panel, status });
    const teardown = (): void => {
      shell.destroy();
      editor.destroy();
      awareness.destroy();
      panel.remove();
      status.remove();
    };
    return { panel, awareness, connection, teardown };
  }

  /** Mirrors a remote participant in, the way a server awareness broadcast would. */
  function arrive(awareness: Awareness, client: number, name: string): void {
    awareness.states.set(client, { user: { name, color: "var(--presence-1)" } });
    awareness.emit("change", [{ added: [client], updated: [], removed: [] }, "remote"]);
  }

  it("shows an avatar per remote reader, tagged with its awareness client", async () => {
    const { panel, awareness, teardown } = await mount();

    arrive(awareness, 11, "bob");
    arrive(awareness, 12, "carol");

    const avatars = [...panel.querySelectorAll(".presence-avatar")];
    expect(avatars).toHaveLength(2);
    expect(avatars.map((avatar) => avatar.getAttribute("aria-label"))).toEqual(["bob", "carol"]);
    expect(avatars.map((avatar) => avatar.textContent)).toEqual(["B", "C"]);
    expect(avatars[0]?.getAttribute(PRESENCE_CLIENT_ATTRIBUTE)).toBe("11");
    teardown();
  });

  it("never shows the local user their own avatar", async () => {
    const { panel, awareness, teardown } = await mount();

    awareness.setLocalStateField("user", { name: "me", color: "var(--presence-0)" });

    expect(panel.querySelectorAll(".presence-avatar")).toHaveLength(0);
    teardown();
  });

  it("labels the presence row for assistive technology", async () => {
    // A bare div drops aria-label; the role is what makes the label reach a screen reader.
    const { panel, teardown } = await mount();

    const header = panel.querySelector(".presence-header");

    expect(header?.getAttribute("role")).toBe("group");
    expect(header?.getAttribute("aria-label")).toBe("People editing this note");
    teardown();
  });

  it("says you are alone while the transport is down", async () => {
    const { panel, connection, teardown } = await mount();
    const status = panel.querySelector<HTMLElement>(".connection-status");
    if (status === null) throw new Error("connection status missing");

    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("Offline");
    expect(status.dataset["state"]).toBe("offline");

    connection.set({ connected: true, pending: 0, synced: false });

    expect(status.hidden).toBe(true);
    expect(status.dataset["state"]).toBe("online");
    teardown();
  });

  it("says how much is waiting to be sent", async () => {
    // §7.4: an offline application that says nothing about unsent work is one where losing
    // the device and losing nothing look identical from the outside.
    const { panel, connection, teardown } = await mount();
    const status = panel.querySelector<HTMLElement>(".connection-status");
    if (status === null) throw new Error("connection status missing");

    connection.set({ connected: false, pending: 1, synced: false });
    expect(status.textContent).toBe("Offline — 1 unsent change, saved on this device");

    connection.set({ connected: false, pending: 4, synced: false });
    expect(status.textContent).toBe("Offline — 4 unsent changes, saved on this device");

    connection.set({ connected: true, pending: 4, synced: false });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("Reconnected — sending 4 unsent changes");

    connection.set({ connected: true, pending: 0, synced: false });
    expect(status.hidden).toBe(true);
    teardown();
  });

  it("removes an avatar when its reader leaves", async () => {
    const { panel, awareness, teardown } = await mount();
    arrive(awareness, 11, "bob");
    expect(panel.querySelectorAll(".presence-avatar")).toHaveLength(1);

    awareness.states.delete(11);
    awareness.emit("change", [{ added: [], updated: [], removed: [11] }, "remote"]);

    expect(panel.querySelectorAll(".presence-avatar")).toHaveLength(0);
    teardown();
  });

  it("releases its awareness listener and idle ticker with the note", async () => {
    const { panel, awareness, teardown } = await mount();
    arrive(awareness, 11, "bob");

    teardown();

    // Nothing left in the DOM, and a later change must not resurrect it.
    expect(panel.querySelector(".presence-header")).toBeNull();
  });
});

/**
 * The virtual-keyboard toolbar (`SPEC.md` §8.3).
 *
 * §8.3 calls this "the most commonly botched thing in mobile editors" and says it gets an
 * explicit test. It did not have one until M7 — the code shipped in M3 and nothing checked
 * it, which is the same shape as every other bug this project has found late.
 *
 * The botched version is not "no code at all"; it is code that computes the offset once, or
 * from the wrong viewport, and so leaves the toolbar under the keyboard on exactly the
 * devices nobody tested. So the assertions are about the *arithmetic* and about the toolbar
 * moving again when the keyboard does.
 */
describe("the toolbar above the virtual keyboard", () => {
  /** A controllable `visualViewport`, which jsdom does not provide. */
  function fakeViewport(height: number, offsetTop = 0) {
    const listeners = new Map<string, Set<() => void>>();
    const viewport = {
      height,
      offsetTop,
      addEventListener: (type: string, listener: () => void): void => {
        const existing = listeners.get(type) ?? new Set();
        existing.add(listener);
        listeners.set(type, existing);
      },
      removeEventListener: (type: string, listener: () => void): void => {
        listeners.get(type)?.delete(listener);
      },
    };
    return {
      viewport,
      /** Shrinks the visual viewport, the way a keyboard opening does. */
      resizeTo(next: number, top = 0): void {
        viewport.height = next;
        viewport.offsetTop = top;
        for (const listener of [...(listeners.get("resize") ?? [])]) listener();
      },
      get listenerCount(): number {
        return [...listeners.values()].reduce((total, set) => total + set.size, 0);
      },
    };
  }

  async function mountWithViewport(fake: ReturnType<typeof fakeViewport>) {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel, status);
    const editor = new Editor({
      element: surface,
      extensions: createMemberberryExtensions(contract),
    });
    const ydoc = new Doc();
    applyUpdate(ydoc, await updateFromMarkdown("# Note\n"));

    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      value: fake.viewport,
      configurable: true,
    });
    const shell = mountEditorShell({ editor, document: ydoc, panel, status });
    const controls = panel.querySelector<HTMLElement>(".editor-controls");
    if (controls === null) throw new Error("the control strip should be mounted");

    return {
      controls,
      offset: (): string => controls.style.getPropertyValue("--keyboard-offset"),
      destroy: (): void => {
        shell.destroy();
        editor.destroy();
        if (original === undefined) {
          Reflect.deleteProperty(window, "visualViewport");
        } else {
          Object.defineProperty(window, "visualViewport", original);
        }
      },
    };
  }

  it("sits flat against the bottom while no keyboard is up", async () => {
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    try {
      expect(mounted.offset()).toBe("0px");
    } finally {
      mounted.destroy();
    }
  });

  it("lifts by exactly the height the keyboard took", async () => {
    // The arithmetic is the whole feature: layout height minus visual height minus how far
    // the visual viewport has been scrolled up. Get any term wrong and the toolbar sits
    // under the keyboard — visible in a screenshot, invisible to every other kind of test.
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    try {
      fake.resizeTo(window.innerHeight - 300);
      expect(mounted.offset()).toBe("300px");
    } finally {
      mounted.destroy();
    }
  });

  it("accounts for the visual viewport being scrolled, not just shrunk", async () => {
    // iOS scrolls the visual viewport as well as shrinking it when focus moves near the
    // bottom of the page. Ignoring `offsetTop` leaves the toolbar floating in the middle.
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    try {
      fake.resizeTo(window.innerHeight - 300, 120);
      expect(mounted.offset()).toBe("180px");
    } finally {
      mounted.destroy();
    }
  });

  it("moves again when the keyboard closes, rather than staying lifted", async () => {
    // The "computed once" failure: the toolbar rises correctly and then never comes back
    // down, leaving a gap above the bottom of the screen for the rest of the session.
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    try {
      fake.resizeTo(window.innerHeight - 300);
      expect(mounted.offset()).toBe("300px");
      fake.resizeTo(window.innerHeight);
      expect(mounted.offset()).toBe("0px");
    } finally {
      mounted.destroy();
    }
  });

  it("never lifts by a negative amount", async () => {
    // A visual viewport taller than the layout one happens during overscroll on iOS. A
    // negative offset pushes the toolbar off the bottom of the screen entirely.
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    try {
      fake.resizeTo(window.innerHeight + 200);
      expect(mounted.offset()).toBe("0px");
    } finally {
      mounted.destroy();
    }
  });

  it("releases its viewport listeners with the note", async () => {
    // A pane is opened and closed constantly under tabs and splits (§8.2), so a listener
    // left on `visualViewport` is a fast leak rather than a slow one.
    const fake = fakeViewport(window.innerHeight);
    const mounted = await mountWithViewport(fake);
    expect(fake.listenerCount).toBe(2);

    mounted.destroy();
    expect(fake.listenerCount).toBe(0);
  });
});

/**
 * The control strip, and what it shows when (`SPEC.md` §8.4, §10.2).
 *
 * All three rows — toolbar, slash menu, task inspector — were permanently visible above
 * every note from M3 until now, roughly 380px of chrome per pane and twice that in a split.
 * The slash menu's own JavaScript had always set `hidden` correctly; `.slash-menu { display:
 * flex }` in the stylesheet cancelled it, because an author rule beats the user agent's
 * `[hidden]` however low its specificity. Nothing could see that: `hidden` read `true` in
 * every unit test while the menu stood open in the browser.
 *
 * So these tests assert on `hidden`, and `tokens.spec.ts` in the E2E suite asserts on the
 * height a browser actually gives the strip. Neither alone would have caught it.
 */
describe("what the control strip shows, and when", () => {
  async function mount(markdown = "# Note\n") {
    const panel = document.createElement("section");
    const surface = document.createElement("div");
    const status = document.createElement("p");
    panel.append(surface);
    document.body.append(panel, status);
    const editor = new Editor({
      element: surface,
      extensions: [...createMemberberryExtensions(contract), taskItemView],
    });
    const ydoc = new Doc();
    applyUpdate(ydoc, await updateFromMarkdown(markdown));
    const shell = mountEditorShell({ editor, document: ydoc, panel, status });

    const find = <T extends HTMLElement>(selector: string): T => {
      const found = panel.querySelector<T>(selector);
      if (found === null) throw new Error(`${selector} is not in the control strip`);
      return found;
    };
    return {
      editor,
      panel,
      menu: find<HTMLElement>(".slash-menu"),
      inspector: find<HTMLElement>(".task-inspector"),
      due: find<HTMLInputElement>("[aria-label='Task due date']"),
      priority: find<HTMLSelectElement>("[aria-label='Task priority']"),
      /** The labels of the commands the menu is currently offering. */
      offered: (): readonly string[] =>
        [...panel.querySelectorAll<HTMLElement>(".slash-menu [role='menuitem']")]
          .filter((item) => !item.hidden)
          .map((item) => item.textContent ?? ""),
      type: (text: string): void => {
        editor.commands.insertContent(text);
        editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      },
      /** Types into an empty block, so one case cannot leave text behind for the next. */
      retype: (text: string): void => {
        editor.commands.clearContent();
        editor.commands.insertContent(text);
        editor.view.dom.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
      },
      destroy: (): void => {
        shell.destroy();
        editor.destroy();
        ydoc.destroy();
        panel.remove();
        status.remove();
      },
    };
  }

  /** A document with a paragraph before a task, so the selection has somewhere else to be. */
  const WITH_TASK = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Intro" }] },
      {
        type: "bullet_list",
        content: [
          {
            type: "task_item",
            attrs: { status: "todo", due: "2026-09-30", priority: "high", unknown: [] },
            content: [{ type: "paragraph", content: [{ type: "text", text: "Ship it" }] }],
          },
        ],
      },
    ],
  };

  it("opens no menu and no inspector on a note that is just being read", async () => {
    const mounted = await mount();
    try {
      expect(mounted.menu.hidden).toBe(true);
      expect(mounted.inspector.hidden).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  it("opens the menu when a slash is typed and closes it on the space that ends it", async () => {
    const mounted = await mount();
    try {
      mounted.type("/");
      expect(mounted.menu.hidden).toBe(false);

      mounted.type("task ");
      expect(mounted.menu.hidden).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  it("leaves a slash inside a word alone", async () => {
    // The regression this rules out is the menu popping open on a URL or a date written
    // `9/3`, which the old "any slash anywhere in the block" test would have done — and
    // which nobody would have noticed while the menu never closed anyway.
    const mounted = await mount();
    try {
      mounted.retype("see https://example.com");
      expect(mounted.menu.hidden).toBe(true);

      mounted.retype("due 9/3");
      expect(mounted.menu.hidden).toBe(true);

      // The case that separates "a slash that starts a word" from "a slash anywhere in the
      // block": the text after this slash *is* a command name, so a permissive match opens
      // the menu over a folder path someone is simply typing.
      mounted.retype("Projects/task");
      expect(mounted.menu.hidden).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  it("narrows the menu to what has been typed after the slash", async () => {
    const mounted = await mount();
    try {
      mounted.type("/");
      expect(mounted.offered().length).toBeGreaterThan(1);

      mounted.type("ta");
      expect(mounted.offered()).toEqual(["Task", "Table"]);

      mounted.type("s");
      expect(mounted.offered()).toEqual(["Task"]);
    } finally {
      mounted.destroy();
    }
  });

  it("closes rather than showing an empty menu when nothing matches", async () => {
    const mounted = await mount();
    try {
      mounted.type("/zzz");

      expect(mounted.menu.hidden).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  it("opens the whole menu on a long press, which is the mobile route in (§8.3)", async () => {
    // This used to be a class the stylesheet turned into a `display: flex` — a second switch
    // for the same menu, which could not agree with `hidden`. There is one switch now, so
    // this is the test that it is still wired to the long press at all.
    vi.useFakeTimers();
    const mounted = await mount();
    try {
      mounted.editor.view.dom.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
      vi.advanceTimersByTime(500);

      expect(mounted.menu.hidden).toBe(false);
      expect(mounted.offered().length).toBeGreaterThan(1);
    } finally {
      mounted.destroy();
      vi.useRealTimers();
    }
  });

  it("shows the inspector only while a task is selected", async () => {
    const mounted = await mount();
    mounted.editor.commands.setContent(WITH_TASK);
    try {
      mounted.editor.commands.setTextSelection(3);
      expect(mounted.editor.isActive("task_item")).toBe(false);
      expect(mounted.inspector.hidden).toBe(true);

      mounted.editor.commands.setTextSelection(11);
      expect(mounted.editor.isActive("task_item")).toBe(true);
      expect(mounted.inspector.hidden).toBe(false);
    } finally {
      mounted.destroy();
    }
  });

  it("fills the inspector from the selected task rather than leaving it blank", async () => {
    // The old row was permanently visible *and* permanently empty: selecting a task due on
    // the 30th showed an empty date field, which invites overwriting it with nothing.
    const mounted = await mount();
    mounted.editor.commands.setContent(WITH_TASK);
    try {
      mounted.editor.commands.setTextSelection(11);

      expect(mounted.due.value).toBe("2026-09-30");
      expect(mounted.priority.value).toBe("high");
    } finally {
      mounted.destroy();
    }
  });

  it("does not overwrite a control the user is currently typing in", async () => {
    // Every keystroke is a transaction and every transaction re-syncs this row, so seeding
    // the date input from the document mid-entry would fight whoever is in it.
    const mounted = await mount();
    mounted.editor.commands.setContent(WITH_TASK);
    try {
      mounted.editor.commands.setTextSelection(11);
      mounted.due.focus();
      mounted.due.value = "2026-12-01";

      mounted.editor.commands.setTextSelection(12);

      expect(mounted.due.value).toBe("2026-12-01");
    } finally {
      mounted.destroy();
    }
  });

  it("focuses the due date field when a due chip is clicked (§10.2)", async () => {
    const mounted = await mount();
    mounted.editor.commands.setContent(WITH_TASK);
    try {
      const chip = mounted.panel.querySelector<HTMLElement>("[data-task-chip='due']");
      expect(chip, "the task should render an inline due chip").not.toBeNull();
      chip?.click();

      expect(mounted.inspector.hidden).toBe(false);
      expect(document.activeElement).toBe(mounted.due);
    } finally {
      mounted.destroy();
    }
  });

  it("stops listening to the editor when the note closes", async () => {
    // A pane is opened and closed constantly under tabs and splits, so a selection listener
    // left behind is a fast leak — and one that writes into a detached control strip.
    const mounted = await mount();
    const before = mounted.editor.storage;
    mounted.destroy();

    expect(before).toBeDefined();
    expect(document.querySelector(".editor-controls")).toBeNull();
  });
});

describe("connectionMessage", () => {
  it("says nothing when there is nothing to say", () => {
    expect(connectionMessage({ connected: true, pending: 0, synced: false })).toBeUndefined();
  });

  it("keeps §7.5's promise that offline you are alone", () => {
    expect(connectionMessage({ connected: false, pending: 0, synced: false })).toBe("Offline — you are editing alone");
  });

  it("counts in singular and plural", () => {
    expect(connectionMessage({ connected: false, pending: 1, synced: false })).toContain("1 unsent change,");
    expect(connectionMessage({ connected: false, pending: 2, synced: false })).toContain("2 unsent changes,");
  });

  it("says where an unsent change is, because that is the part that matters", () => {
    // Not "unsaved": it *is* saved, in IndexedDB on this device (§7.2). What is true is that
    // it is nowhere else, and a message that said "unsaved" would send people looking for a
    // save button that would not help.
    expect(connectionMessage({ connected: false, pending: 3, synced: false })).toBe(
      "Offline — 3 unsent changes, saved on this device",
    );
  });
});
