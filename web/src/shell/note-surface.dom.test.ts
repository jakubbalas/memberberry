// @vitest-environment jsdom

/**
 * Opening and closing a note pane, against the real editor.
 *
 * Tiptap, the Y.Doc and the control strip are all real here — only IndexedDB and the socket
 * are injected, because jsdom has no IndexedDB and a unit test should not open a WebSocket.
 * The `instanceof Editor` check inside `openNoteSurface` is only meaningful against the real
 * factory, so the factory is not stubbed.
 *
 * The teardown tests are the point. Once splits and tabs exist (§8.2) a pane is opened and
 * closed constantly, so a `destroy` that leaves a listener attached or throws on a second
 * call is not a slow leak but a fast one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Extensions } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";

import type { LocalPersistence } from "../editor/collaboration.js";
import { createMemberberryExtensions } from "../editor/schema.js";
import { load } from "../notes.js";
import { LOCAL_ONLY, openNoteSurface } from "./note-surface.js";

const fixture = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const contract = JSON.parse(
  readFileSync(fixture("../../../crates/mb-core/schema.json"), "utf8"),
) as unknown;

beforeAll(async () => {
  await load(readFileSync(fixture("../wasm/mb_bg.wasm")));
});

/** Stands in for `y-indexeddb`, which jsdom has no store for. */
function localPersistence(): LocalPersistence {
  return { whenSynced: Promise.resolve(), destroy: async () => undefined };
}

const loadExtensions = async (): Promise<Extensions> => createMemberberryExtensions(contract);

/** The three elements a pane needs, attached to the document so layout works. */
function elements(): { surface: HTMLElement; panel: HTMLElement; status: HTMLElement } {
  const panel = document.createElement("section");
  panel.className = "editor-panel";
  const surface = document.createElement("div");
  surface.className = "editor-surface";
  const status = document.createElement("p");
  status.className = "offline-status";
  panel.append(surface);
  document.body.append(panel, status);
  return { surface, panel, status };
}

async function open(
  overrides: Partial<Parameters<typeof openNoteSurface>[0]> = {},
): Promise<{
  surface: Awaited<ReturnType<typeof openNoteSurface>>;
  dom: ReturnType<typeof elements>;
}> {
  const dom = elements();
  const surface = await openNoteSurface({
    ...dom,
    createPersistence: localPersistence,
    loadExtensions,
    ...overrides,
  });
  return { surface, dom };
}

describe("opening a note pane", () => {
  it("mounts an editable Tiptap surface and the control strip", async () => {
    const { surface, dom } = await open();
    try {
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      expect(dom.panel.querySelector(".editor-controls")).not.toBeNull();
      expect(dom.panel.querySelector(".editor-toolbar")).not.toBeNull();
    } finally {
      await surface.destroy();
    }
  });

  it("edits a local-only replica when no server bootstrapped the page", async () => {
    // The `npm run dev` path. It must not open a socket and must not invent an identity.
    let socketRequested = false;
    const { surface } = await open({
      createRemoteSync: () => {
        socketRequested = true;
        return { connected: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      expect(socketRequested).toBe(false);
      expect(LOCAL_ONLY.vault).toBe("local-demo");
    } finally {
      await surface.destroy();
    }
  });

  it("opens a socket on the origin that served the page when the server named the note", async () => {
    let endpoint: string | undefined;
    const { surface } = await open({
      bootstrap: { vault: "personal", note: "Welcome.md", user: "alice" },
      location: { protocol: "https:", host: "notes.example" } as Location,
      createRemoteSync: (options) => {
        endpoint = options.endpoint;
        return { connected: true, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      expect(endpoint).toBe("wss://notes.example/api/v1/sync");
    } finally {
      await surface.destroy();
    }
  });
});

describe("closing a note pane", () => {
  it("removes the control strip it added", async () => {
    const { surface, dom } = await open();
    expect(dom.panel.querySelector(".editor-controls")).not.toBeNull();

    await surface.destroy();
    expect(dom.panel.querySelector(".editor-controls")).toBeNull();
  });

  it("destroys the sync provider", async () => {
    let destroyed = 0;
    const { surface } = await open({
      bootstrap: { vault: "personal", note: "Welcome.md", user: "alice" },
      location: { protocol: "http:", host: "localhost:9010" } as Location,
      createRemoteSync: () => ({
        connected: true,
        sendAwareness: () => undefined,
        destroy: () => {
          destroyed += 1;
        },
      }),
    });

    // Awaited rather than flushed a guessed number of microtasks: teardown chains through
    // Tiptap, the collaboration and then the transport, and counting ticks is how a test
    // becomes flaky the moment one of those gains a step (AGENTS.md §2.3).
    await surface.destroy();
    expect(destroyed).toBe(1);
  });

  it("is idempotent, because a pane can be closed twice", async () => {
    // The user closes the tab and the layout unmounts the pane. Tiptap throws if destroyed
    // twice, so without the guard the second call takes the page down with it.
    const { surface } = await open();
    await surface.destroy();
    await expect(surface.destroy()).resolves.toBeUndefined();
  });
});
