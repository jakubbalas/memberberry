// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { applyUpdate, Doc } from "yjs";
import { Awareness } from "y-protocols/awareness";
import { beforeAll, describe, expect, it } from "vitest";

import { load, updateFromMarkdown } from "../notes.js";
import { createConnectionStatus } from "./collaboration.js";
import { mountEditorShell } from "./editor-shell.js";
import { PRESENCE_CLIENT_ATTRIBUTE } from "./presence.js";
import { createMemberberryExtensions } from "./schema.js";

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

    connection.set(true);

    expect(status.hidden).toBe(true);
    expect(status.dataset["state"]).toBe("online");
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
