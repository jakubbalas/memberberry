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

import { Editor, type Extensions } from "@tiptap/core";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Doc, XmlElement, XmlText, applyUpdate, encodeStateAsUpdate } from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";

import { persistenceName, type LocalPersistence } from "../editor/collaboration.js";
import { createSyncProvider, decodeBinaryFrame, encodeBinaryFrame, type ConnectionState } from "../editor/sync.js";
import { stubReplica } from "../offline/testing.js";
import { openOfflineStore } from "../offline/db.js";
import { createReplica, dropBodyWith } from "../offline/replica.js";
import { createMemberberryExtensions } from "../editor/schema.js";
import { SCHEMA_VERSION } from "../editor/schema-revision.js";
import { load, markdownFromUpdate, updateFromMarkdown } from "../notes.js";
import { LOCAL_ONLY, openNoteSurface } from "./note-surface.js";

const fixture = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const contract = JSON.parse(
  readFileSync(fixture("../../../crates/mb-core/schema.json"), "utf8"),
) as unknown;

beforeAll(async () => {
  // jsdom has no Range layout; focusing the real editor still asks this browser boundary.
  Range.prototype.getClientRects = () => document.createElement("span").getClientRects();
  Range.prototype.getBoundingClientRect = () => new DOMRect();
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
    // Explicit rather than inherited: jsdom has no IndexedDB, so the default would be
    // `undefined` anyway, and a test that relied on that would silently start using a real
    // store the day the environment grew one.
    replica: async () => undefined,
    ...overrides,
  });
  return { surface, dom };
}

/** A replica holding exactly the notes named, for the §7.2 tests below. */
function replicaHolding(...resident: string[]) {
  const opened: string[] = [];
  return {
    opened,
    handle: async () =>
      stubReplica({
        isResident: async (_vault: string, note: string) => resident.includes(note),
        metadata: async (_vault: string, note: string) => ({
          path: note,
          title: "Roadmap",
          conflicts: 0,
        }),
        opened: async (_vault: string, note: string) => {
          opened.push(note);
        },
      }),
  };
}

describe("opening a note pane", () => {
  it("keeps the editor covered until its control strip is mounted", async () => {
    let releaseExtensions: ((extensions: Extensions) => void) | undefined;
    const extensions = new Promise<Extensions>((resolve) => {
      releaseExtensions = resolve;
    });
    const dom = elements();
    const opening = openNoteSurface({
      ...dom,
      createPersistence: localPersistence,
      loadExtensions: () => extensions,
      replica: async () => undefined,
    });

    expect(dom.panel.dataset["editor"]).toBe("loading");
    expect(dom.panel.querySelector(".editor-controls")).toBeNull();

    releaseExtensions?.(await loadExtensions());
    const surface = await opening;
    try {
      expect(dom.panel.dataset["editor"]).toBeUndefined();
      expect(dom.panel.querySelector(".editor-controls")).not.toBeNull();
    } finally {
      await surface.destroy();
    }
  });

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
        return { connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
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
        return { connected: true, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      expect(endpoint).toBe("wss://notes.example/api/v1/sync");
    } finally {
      await surface.destroy();
    }
  });
});

describe("source task actions", () => {
  const markdown = "# Tasks\n\n- [ ] First\n- [ ] Middle\n- [ ] Last\n";

  async function taskPane(resident = false, initial?: Uint8Array) {
    const update = initial ?? await updateFromMarkdown(markdown);
    let doc: Doc | undefined;
    let report: ((state: ConnectionState) => void) | undefined;
    let revoked = false;
    const pane = await open({
      bootstrap: { vault: "personal", note: "Tasks.md", user: "alice" },
      replica: async () => stubReplica({
        isResident: async () => resident,
        session: () => ({
          get revoked() { return revoked; },
          opened: async () => undefined, measured: async () => undefined, close: () => undefined,
        }),
      }),
      createPersistence: (_name, document) => {
        doc = document;
        if (resident) applyUpdate(document, update);
        return localPersistence();
      },
      createRemoteSync: (_options, _doc, _awareness, changed) => {
        report = changed;
        return { connected: true, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    const editor = (pane.dom.surface.querySelector(".tiptap") as HTMLElement & { editor?: Editor })?.editor;
    if (doc === undefined || !(editor instanceof Editor)) throw new Error("missing task editor/document");
    const document = doc;
    return { ...pane, editor, document,
      body: () => applyUpdate(document, update),
      synced: () => report?.({ connected: true, pending: 0, synced: true }),
      revoke: (value = true) => { revoked = value; },
      states: () => [...pane.dom.surface.querySelectorAll(".task-checkbox")].map((box) => box.getAttribute("aria-checked")),
    };
  }

  it.each([0, 1, 2])("edits only source ordinal %s, not all later tasks", async (ordinal) => {
    const pane = await taskPane(true);
    try {
      expect(pane.surface.editTask?.(ordinal, { kind: "toggle" })).toBe(true);
      expect(pane.states()).toEqual([0, 1, 2].map((index) => String(index === ordinal)));
    } finally { await pane.surface.destroy(); }
  });

  it.each(["todo", "cancelled"] as const)("completes a %s task without reopening it on a fresh completion intent", async (status) => {
    const initial = await updateFromMarkdown(status === "todo" ? markdown
      : "# Tasks\n\n- [-] First ❌ 2026-09-01\n- [ ] Middle\n- [ ] Last\n");
    const pane = await taskPane(true, initial);
    try {
      expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(pane.states()).toEqual(["true", "false", "false"]);
      const completed = await markdownFromUpdate(encodeStateAsUpdate(pane.document));
      expect(completed).toMatch(/- \[x\] First.*✅ \d{4}-\d{2}-\d{2}/);
      if (status === "cancelled") expect(completed).toContain("❌ 2026-09-01");
      const transaction = vi.fn();
      pane.editor.on("transaction", transaction);
      try {
        expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
        expect(pane.states()).toEqual(["true", "false", "false"]);
        expect(transaction).not.toHaveBeenCalled();
        expect(await markdownFromUpdate(encodeStateAsUpdate(pane.document))).toBe(completed);
      } finally { pane.editor.off("transaction", transaction); }
    } finally { await pane.surface.destroy(); }
  });

  it("keeps a remounted completed task unchanged and unfocused when a cached inbox row completes it again", async () => {
    const first = await taskPane(true);
    let saved: Uint8Array;
    try {
      expect(first.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      saved = encodeStateAsUpdate(first.document);
    } finally { await first.surface.destroy(); }
    const reopened = await taskPane(true, saved);
    const transaction = vi.fn();
    const focus = vi.spyOn(reopened.editor.view, "focus");
    reopened.editor.on("transaction", transaction);
    try {
      const before = encodeStateAsUpdate(reopened.document);
      const selection = reopened.editor.state.selection;
      expect(reopened.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(reopened.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
      expect(reopened.editor.state.selection).toBe(selection);
      expect(transaction).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(encodeStateAsUpdate(reopened.document)).toEqual(before);
    } finally {
      reopened.editor.off("transaction", transaction);
      focus.mockRestore();
      await reopened.surface.destroy();
    }
  });

  it.each([false, true])("defers completion until first sync and never reopens the source (already done: %s)", async (done) => {
    const initial = await updateFromMarkdown(done
      ? "# Tasks\n\n- [x] First ✅ 2026-09-01\n- [ ] Middle\n- [ ] Last\n" : markdown);
    const pane = await taskPane(false, initial);
    try {
      expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      pane.body();
      await Promise.resolve();
      expect(pane.states()).toEqual([String(done), "false", "false"]);
      pane.synced();
      await Promise.resolve();
      expect(pane.states()).toEqual(["true", "false", "false"]);
      const completed = await markdownFromUpdate(encodeStateAsUpdate(pane.document));
      expect(completed).toMatch(/- \[x\] First.*✅/);
      if (done) expect(completed).toContain("✅ 2026-09-01");
    } finally { await pane.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("refuses completion of an already done %s source instead of reporting success", async (denial) => {
    const pane = await taskPane(true, await updateFromMarkdown("# Tasks\n\n- [x] First ✅ 2026-09-01\n"));
    const action = { kind: "complete" } as const;
    try {
      if (denial === "revoked") pane.revoke();
      else pane.editor.setEditable(false);
      const before = encodeStateAsUpdate(pane.document);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(encodeStateAsUpdate(pane.document)).toEqual(before);
      pane.revoke(false);
      pane.editor.setEditable(true);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(encodeStateAsUpdate(pane.document)).toEqual(before);
    } finally { await pane.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("terminally rejects deferred completion if the source becomes %s before sync", async (denial) => {
    const pane = await taskPane();
    const action = { kind: "complete" } as const;
    try {
      expect(pane.surface.editTask?.(0, action)).toBe(true);
      pane.body();
      pane.synced();
      if (denial === "revoked") pane.revoke();
      else pane.editor.setEditable(false);
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false"]);
      pane.revoke(false);
      pane.editor.setEditable(true);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(pane.surface.editTask?.(0, { kind: "complete" })).toBe(true);
      expect(pane.states()).toEqual(["true", "false", "false"]);
    } finally { await pane.surface.destroy(); }
  });

  it("queues an unopened source action until its authorized body arrives and applies it once", async () => {
    const pane = await taskPane();
    try {
      expect(pane.surface.editTask?.(1, { kind: "toggle" })).toBe(true);
      pane.body();
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false"]);
      pane.synced();
      await vi.waitFor(() => expect(pane.states()).toEqual(["false", "true", "false"]));
      pane.synced();
      pane.editor.commands.insertContent("Typed after sync ");
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "true", "false"]);
      expect(await markdownFromUpdate(encodeStateAsUpdate(pane.document))).toMatch(/- \[x\] .*Middle.*✅/);
    } finally { await pane.surface.destroy(); }
  });

  it("keeps distinct pending edits in order but accepts the same action only once", async () => {
    const pane = await taskPane();
    const action = { kind: "toggle" } as const;
    try {
      pane.surface.editTask?.(0, action);
      pane.surface.editTask?.(0, action);
      pane.surface.editTask?.(1, { kind: "due", value: "2026-10-10" });
      pane.body();
      pane.synced();
      await vi.waitFor(() => expect(pane.states()).toEqual(["true", "false", "false"]));
      const body = await markdownFromUpdate(encodeStateAsUpdate(pane.document));
      expect(body).toContain("Middle 📅 2026-10-10");
      pane.surface.editTask?.(0, action);
      expect(pane.states()).toEqual(["true", "false", "false"]);
      pane.surface.editTask?.(0, { kind: "toggle" });
      expect(pane.states()).toEqual(["false", "false", "false"]);
    } finally { await pane.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("drops deferred edits when the source becomes %s", async (denial) => {
    const pane = await taskPane();
    try {
      pane.surface.editTask?.(0, { kind: "toggle" });
      if (denial === "revoked") pane.revoke();
      else pane.editor.setEditable(false);
      pane.body();
      pane.synced();
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false"]);
      expect(pane.surface.editTask?.(1, { kind: "toggle" })).toBe(false);
      pane.revoke(false);
      pane.editor.setEditable(true);
      pane.synced();
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false"]);
    } finally { await pane.surface.destroy(); }
  });

  it("drops stale ordinals rather than applying them when a later task appears", async () => {
    const pane = await taskPane(true);
    try {
      expect(pane.surface.editTask?.(3, { kind: "toggle" })).toBe(false);
      pane.editor.commands.insertContentAt(pane.editor.state.doc.content.size, {
        type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Later task" }] }] }],
      });
      pane.synced();
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false", "false"]);
    } finally { await pane.surface.destroy(); }
  });

  it("does not resurrect a stale rejected ordinal after remounting with a new task", async () => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane(true);
    expect(first.surface.editTask?.(3, action)).toBe(false);
    first.editor.commands.insertContentAt(first.editor.state.doc.content.size, {
      type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Later task" }] }] }],
    });
    const saved = encodeStateAsUpdate(first.document);
    await first.surface.destroy();
    const reopened = await taskPane(true, saved);
    try {
      expect(reopened.surface.editTask?.(3, action)).toBe(false);
      expect(reopened.states()).toEqual(["false", "false", "false", "false"]);
      expect(reopened.surface.editTask?.(3, { kind: "toggle" })).toBe(true);
      expect(reopened.states()).toEqual(["false", "false", "false", "true"]);
    } finally { await reopened.surface.destroy(); }
  });

  it("does not resurrect an ordinal rejected after deferred sync when a later task appears", async () => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane();
    let saved: Uint8Array;
    try {
      expect(first.surface.editTask?.(3, action)).toBe(true);
      first.body();
      first.synced();
      await Promise.resolve();
      expect(first.surface.editTask?.(3, action)).toBe(false);
      first.editor.commands.insertContentAt(first.editor.state.doc.content.size, {
        type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Later task" }] }] }],
      });
      expect(first.surface.editTask?.(3, action)).toBe(false);
      expect(first.states()).toEqual(["false", "false", "false", "false"]);
      saved = encodeStateAsUpdate(first.document);
    } finally { await first.surface.destroy(); }
    const reopened = await taskPane(true, saved);
    try {
      expect(reopened.surface.editTask?.(3, action)).toBe(false);
      expect(reopened.states()).toEqual(["false", "false", "false", "false"]);
      expect(reopened.surface.editTask?.(3, { kind: "toggle" })).toBe(true);
      expect(reopened.states()).toEqual(["false", "false", "false", "true"]);
    } finally { await reopened.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("does not resurrect a denied deferred action after remounting an editable source (%s)", async (denial) => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane();
    first.surface.editTask?.(0, action);
    if (denial === "revoked") first.revoke();
    else first.editor.setEditable(false);
    first.body();
    first.synced();
    await Promise.resolve();
    expect(first.surface.editTask?.(0, action)).toBe(false);
    await first.surface.destroy();
    const reopened = await taskPane(true);
    try {
      expect(reopened.surface.editTask?.(0, action)).toBe(false);
      expect(reopened.states()).toEqual(["false", "false", "false"]);
      expect(reopened.surface.editTask?.(0, { kind: "toggle" })).toBe(true);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
    } finally { await reopened.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("records %s denial at teardown even without a body or connection update", async (denial) => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane();
    expect(first.surface.editTask?.(0, action)).toBe(true);
    if (denial === "revoked") first.revoke();
    else first.editor.setEditable(false);
    await first.surface.destroy();
    const reopened = await taskPane(true);
    try {
      expect(reopened.surface.editTask?.(0, action)).toBe(false);
      expect(reopened.states()).toEqual(["false", "false", "false"]);
      expect(reopened.surface.editTask?.(0, { kind: "toggle" })).toBe(true);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
    } finally { await reopened.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("does not replay an immediate %s rejection after remounting", async (denial) => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane(true);
    try {
      if (denial === "revoked") first.revoke();
      else first.editor.setEditable(false);
      expect(first.surface.editTask?.(0, action)).toBe(false);
    } finally { await first.surface.destroy(); }
    const reopened = await taskPane(true);
    try {
      expect(reopened.surface.editTask?.(0, action)).toBe(false);
      expect(reopened.states()).toEqual(["false", "false", "false"]);
      expect(reopened.surface.editTask?.(0, { kind: "toggle" })).toBe(true);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
    } finally { await reopened.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("rechecks %s permission before a scheduled edit applies", async (denial) => {
    const pane = await taskPane();
    const action = { kind: "toggle" } as const;
    try {
      expect(pane.surface.editTask?.(0, action)).toBe(true);
      pane.body();
      pane.synced();
      if (denial === "revoked") pane.revoke();
      else pane.editor.setEditable(false);
      await Promise.resolve();
      expect(pane.states()).toEqual(["false", "false", "false"]);
      pane.revoke(false);
      pane.editor.setEditable(true);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(pane.surface.editTask?.(0, { kind: "toggle" })).toBe(true);
      expect(pane.states()).toEqual(["true", "false", "false"]);
    } finally { await pane.surface.destroy(); }
  });

  it.each(["read-only", "revoked"] as const)("rechecks %s permission after selecting the task but before editing it", async (denial) => {
    const pane = await taskPane(true);
    const action = { kind: "toggle" } as const;
    const deny = (): void => {
      if (denial === "revoked") pane.revoke();
      else pane.editor.setEditable(false);
    };
    try {
      pane.editor.on("selectionUpdate", deny);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      pane.editor.off("selectionUpdate", deny);
      expect(pane.states()).toEqual(["false", "false", "false"]);
      pane.revoke(false);
      pane.editor.setEditable(true);
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(pane.surface.editTask?.(0, { kind: "toggle" })).toBe(true);
      expect(pane.states()).toEqual(["true", "false", "false"]);
    } finally {
      pane.editor.off("selectionUpdate", deny);
      await pane.surface.destroy();
    }
  });

  it("returns a terminal command failure rather than acceptance after deferred sync", async () => {
    const pane = await taskPane();
    const action = { kind: "due", value: "not a date" } as const;
    try {
      expect(pane.surface.editTask?.(0, action)).toBe(true);
      pane.body();
      pane.synced();
      await Promise.resolve();
      expect(pane.surface.editTask?.(0, action)).toBe(false);
      expect(await markdownFromUpdate(encodeStateAsUpdate(pane.document))).not.toContain("📅");
      expect(pane.surface.editTask?.(0, { kind: "due", value: "2026-10-10" })).toBe(true);
      expect(await markdownFromUpdate(encodeStateAsUpdate(pane.document))).toContain("First 📅 2026-10-10");
    } finally { await pane.surface.destroy(); }
  });

  it("does not replay a completed intent when the source is remounted after a temporary view", async () => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane(true);
    first.surface.editTask?.(0, action);
    const saved = encodeStateAsUpdate(first.document);
    await first.surface.destroy();
    const reopened = await taskPane(true, saved);
    try {
      reopened.surface.editTask?.(0, action);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
      reopened.surface.editTask?.(0, { kind: "toggle" });
      expect(reopened.states()).toEqual(["false", "false", "false"]);
    } finally { await reopened.surface.destroy(); }
  });

  it("applies a shared intent once across two source panes that finish loading separately", async () => {
    const initial = await updateFromMarkdown(markdown);
    const first = await taskPane(false, initial);
    const second = await taskPane(false, initial);
    const action = { kind: "toggle" } as const;
    try {
      first.surface.editTask?.(1, action);
      second.surface.editTask?.(1, action);
      first.body();
      first.synced();
      await vi.waitFor(() => expect(first.states()).toEqual(["false", "true", "false"]));
      // The other pane receives the same authorized body, including the first pane's edit.
      applyUpdate(second.document, encodeStateAsUpdate(first.document));
      second.synced();
      await Promise.resolve();
      expect(second.states()).toEqual(["false", "true", "false"]);
    } finally { await first.surface.destroy(); await second.surface.destroy(); }
  });

  it("shares a deferred rejection with a second pane even when that pane loads a matching task", async () => {
    const first = await taskPane();
    const second = await taskPane(false, await updateFromMarkdown(`${markdown}- [ ] Later task\n`));
    const action = { kind: "toggle" } as const;
    try {
      expect(first.surface.editTask?.(3, action)).toBe(true);
      expect(second.surface.editTask?.(3, action)).toBe(true);
      first.body();
      first.synced();
      await Promise.resolve();
      second.body();
      second.synced();
      await Promise.resolve();
      expect(second.states()).toEqual(["false", "false", "false", "false"]);
      expect(second.surface.editTask?.(3, action)).toBe(false);
      expect(second.surface.editTask?.(3, { kind: "toggle" })).toBe(true);
      expect(second.states()).toEqual(["false", "false", "false", "true"]);
    } finally { await first.surface.destroy(); await second.surface.destroy(); }
  });

  it("does not consume a deferred intent if its pane closes before applying it", async () => {
    const action = { kind: "toggle" } as const;
    const first = await taskPane();
    first.surface.editTask?.(0, action);
    await first.surface.destroy();
    const reopened = await taskPane(true);
    try {
      reopened.surface.editTask?.(0, action);
      expect(reopened.states()).toEqual(["true", "false", "false"]);
    } finally { await reopened.surface.destroy(); }
  });

  it("cancels scheduled edits synchronously when its pane closes", async () => {
    const pane = await taskPane();
    pane.surface.editTask?.(0, { kind: "toggle" });
    pane.body();
    pane.synced();
    const closing = pane.surface.destroy();
    await closing;
    expect(await markdownFromUpdate(encodeStateAsUpdate(pane.document))).not.toContain("[x]");
    expect(pane.surface.editTask?.(0, { kind: "toggle" })).toBe(false);
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
        pending: 0,
        synced: false,
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

describe("a note whose body was never replicated (SPEC §7.2)", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  /** A transport whose connection state a test drives, the way a server would. */
  function transport() {
    let report: ((state: ConnectionState) => void) | undefined;
    return {
      /** Simulates the server answering `subscribe` with the note's state. */
      deliverBody(): void {
        report?.({ connected: true, pending: 0, synced: true });
      },
      create: ((_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return {
          connected: false,
          pending: 0,
          synced: false,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    };
  }

  it("covers the editor and says the body is elsewhere", async () => {
    // An editor that could be typed into here would merge those words with the body that
    // arrives on reconnect, and the note would look destroyed.
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      expect(dom.panel.dataset["body"]).toBe("waiting");
      const notice = dom.panel.querySelector(".note-not-downloaded");
      expect(notice).not.toBeNull();
      // jsdom applies no stylesheet, so *that* the editor is hidden is a browser assertion
      // (`e2e/offline.spec.ts`). What is checkable here is the attribute the CSS keys on.
      expect(notice?.textContent).toContain("has not been downloaded");
      // Nothing is recorded as resident: the body has not arrived.
      expect(replica.opened).toEqual([]);
    } finally {
      await surface.destroy();
    }
  });

  it("uncovers it when the server sends the body, and remembers it is here", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      server.deliverBody();
      await Promise.resolve();

      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.panel.dataset["body"]).toBeUndefined();
      expect(replica.opened).toEqual(["Projects/Roadmap.md"]);
    } finally {
      await surface.destroy();
    }
  });

  it("shows the replicated title, which is the whole point of the metadata tier", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      // Rendered when the store answers rather than awaited, so a slow store cannot delay
      // the editor behind it.
      await vi.waitFor(() =>
        expect(dom.panel.querySelector(".note-not-downloaded h2")?.textContent).toBe("Roadmap"),
      );
    } finally {
      await surface.destroy();
    }
  });

  it("does not cover a note this device already holds", async () => {
    // Offline-first: a resident note opens immediately, with no server involved at all.
    const replica = replicaHolding("Projects/Roadmap.md");
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    try {
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      // ...and the open moves it to the front of §7.2's LRU.
      expect(replica.opened).toEqual(["Projects/Roadmap.md"]);
    } finally {
      await surface.destroy();
    }
  });

  it("never applies to a local-only replica", async () => {
    // The `npm run dev` path has no server, so "downloaded" means nothing there — the
    // document *is* the local one, and there is no transport to wait on.
    const replica = replicaHolding();
    const { surface, dom } = await open({ replica: replica.handle });
    try {
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
      expect(dom.surface.querySelector(".tiptap")).not.toBeNull();
      expect(replica.opened).toEqual([]);
    } finally {
      await surface.destroy();
    }
  });

  it("does not flash the notice on a first open that is about to succeed", async () => {
    // Every first open is a note this device does not hold yet, so without the delay each
    // one would say "not downloaded" for the length of a round trip. The editor is covered
    // regardless — that part is not cosmetic.
    const replica = replicaHolding();
    const server = transport();
    let pending: Array<() => void> = [];
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      setTimer: (run) => {
        pending.push(run);
        return () => {
          pending = pending.filter((queued) => queued !== run);
        };
      },
    });
    try {
      expect(dom.panel.dataset["body"]).toBe("waiting");
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();

      server.deliverBody();
      await Promise.resolve();

      expect(dom.panel.dataset["body"]).toBeUndefined();
      // ...and the timer was cancelled, so it cannot append the notice a second later over
      // a note that is now open. Nothing is left to fire.
      expect(pending).toEqual([]);
      expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
    } finally {
      await surface.destroy();
    }
  });

  it("leaves nothing behind when the pane closes while still waiting", async () => {
    const replica = replicaHolding();
    const server = transport();
    const { surface, dom } = await open({
      bootstrap,
      location,
      replica: replica.handle,
      createRemoteSync: server.create,
      // Immediately, rather than after §7.2's grace period: what the delay is for is the
      // *first* open of a note online, and it has its own test below.
      setTimer: (run) => {
        run();
        return () => undefined;
      },
    });
    await surface.destroy();

    expect(dom.panel.querySelector(".note-not-downloaded")).toBeNull();
    expect(dom.panel.dataset["body"]).toBeUndefined();
  });
});

describe("keeping §7.2's bookkeeping", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  it.each(["before body", "while applying body", "before subscription"] as const)(
    "protects first residency until server echo when sync arrives %s",
    async (arrival) => {
      const store = await openOfflineStore(new IDBFactory());
      const dropped: string[] = [];
      const replica = createReplica({
        store,
        now: () => 1_000,
        caps: { notes: 1, bytes: 1_000_000 },
        dropBody: async (_vault, note) => { dropped.push(note); },
      });
      class Socket extends EventTarget {
        readyState: number = WebSocket.CONNECTING;
        binaryType: BinaryType = "arraybuffer";
        readonly sent: Uint8Array[] = [];
        send(data: string | Uint8Array): void {
          if (typeof data !== "string") this.sent.push(data);
        }
        close(): void { this.readyState = WebSocket.CLOSED; }
        receive(tag: number, update: Uint8Array): void {
          this.dispatchEvent(new MessageEvent("message", {
            data: encodeBinaryFrame(tag, bootstrap.vault, bootstrap.note, update).buffer,
          }));
        }
      }
      const socket = new Socket();
      const server = new Doc();
      applyUpdate(server, await updateFromMarkdown("# Roadmap\n\nDownloaded body.\n"));
      const connect = (): void => {
        socket.readyState = WebSocket.OPEN;
        socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "admitted", vault: bootstrap.vault, note: bootstrap.note, schema_version: SCHEMA_VERSION }) }));
        socket.receive(0x01, encodeStateAsUpdate(server));
      };
      await store.putResident({ vault: bootstrap.vault, note: "Pinned.md", openedAt: 2_000, bytes: 0, dirty: false });
      await replica.setPinned(bootstrap.vault, "Pinned.md", true);
      const pane = await open({
        bootstrap,
        location,
        replica: async () => replica,
        createRemoteSync: (options, document, awareness, onConnectionChange, onServerState) => {
          const provider = createSyncProvider({
            ...options, document, awareness, onConnectionChange, onServerState,
            connect: () => socket as unknown as WebSocket,
            network: new EventTarget(),
          });
          // A real local Yjs update before the first body, like editor normalization.
          // The real transport retains it until echo, including across the sync frame.
          if (arrival === "while applying body") {
            const fragment = document.getXmlFragment("prosemirror");
            const normalize = (): void => {
              if (socket.readyState !== WebSocket.OPEN) return;
              fragment.unobserve(normalize);
              document.getMap("normalization").set("revision", 1);
            };
            fragment.observe(normalize);
          } else {
            document.getMap("normalization").set("revision", 1);
          }
          if (arrival === "before subscription") connect();
          return provider;
        },
      });
      try {
        if (arrival !== "before subscription") {
          expect(pane.dom.panel.dataset["body"]).toBe("waiting");
          expect(await replica.isResident(bootstrap.vault, bootstrap.note)).toBe(false);
          connect();
        }
        await vi.waitFor(async () => expect(await replica.base(bootstrap.vault, bootstrap.note)).toBeDefined());
        expect(pane.dom.panel.dataset["body"]).toBeUndefined();
        expect(socket.sent.length).toBeGreaterThan(0);
        // Force a real LRU decision, not a spy assertion about a requested dirty patch.
        await replica.evict(bootstrap.vault);
        expect(dropped).toEqual([]);
        expect((await store.getResident(bootstrap.vault, bootstrap.note))?.dirty).toBe(true);

        for (let bytes = socket.sent.shift(); bytes !== undefined; bytes = socket.sent.shift()) {
          const frame = decodeBinaryFrame(bytes);
          if (frame === null) throw new Error("invalid outgoing update");
          applyUpdate(server, frame.payload);
          socket.receive(0x02, frame.payload);
        }
        await vi.waitFor(async () => expect((await store.getResident(bootstrap.vault, bootstrap.note))?.dirty).toBe(false));
        expect(await replica.evict(bootstrap.vault)).toEqual([bootstrap.note]);
      } finally {
        await pane.surface.destroy();
        server.destroy();
        store.close();
      }
    },
  );

  it.each([
    { answer: "denied", disconnect: true },
    { answer: "removed", disconnect: true },
    { answer: "denied", disconnect: false },
  ] as const)(
    "does not replay a buffered first sync after a newer permission reconciliation ($answer, disconnect: $disconnect)",
    async ({ answer, disconnect }) => {
      const factory = new IDBFactory();
      vi.stubGlobal("indexedDB", factory);
      vi.stubGlobal("IDBKeyRange", IDBKeyRange);
      const store = await openOfflineStore(factory);
      const replica = createReplica({ store, dropBody: dropBodyWith(factory) });
      class Socket extends EventTarget {
        readyState: number = WebSocket.CONNECTING;
        binaryType: BinaryType = "arraybuffer";
        send(): void {}
        close(): void { this.readyState = WebSocket.CLOSED; }
      }
      const socket = new Socket();
      const network = new EventTarget();
      let releaseExtensions: ((extensions: Extensions) => void) | undefined;
      const extensions = new Promise<Extensions>((resolve) => { releaseExtensions = resolve; });
      let transportReady: (() => void) | undefined;
      const connected = new Promise<void>((resolve) => { transportReady = resolve; });
      const persistenceDestroyed: string[] = [];
      let connections = 0;
      const dom = elements();
      const opening = openNoteSurface({
        ...dom, bootstrap, location, replica: async () => replica,
        createPersistence: (name, document) => {
          const persistence = new IndexeddbPersistence(name, document);
          return {
            whenSynced: persistence.whenSynced,
            destroy: async () => { await persistence.destroy(); persistenceDestroyed.push(name); },
          };
        },
        loadExtensions: () => extensions,
        createRemoteSync: (options, document, awareness, onConnectionChange, onServerState) => {
          const provider = createSyncProvider({
            ...options, document, awareness, onConnectionChange, onServerState, network,
            connect: () => { connections += 1; return socket as unknown as WebSocket; },
          });
          transportReady?.();
          return provider;
        },
      });
      await connected;
      expect(await replica.isResident(bootstrap.vault, bootstrap.note)).toBe(false);
      socket.readyState = WebSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "admitted", vault: bootstrap.vault, note: bootstrap.note, schema_version: SCHEMA_VERSION }) }));
      const restricted = await updateFromMarkdown("# Secret\n\nRestricted content.\n");
      socket.dispatchEvent(new MessageEvent("message", {
        data: encodeBinaryFrame(0x01, bootstrap.vault, bootstrap.note, restricted).buffer,
      }));
      // The transport has latched synced and buffered the body, but no pane subscriber
      // exists yet. An authoritative catalog answer revokes it before editor startup.
      await replica.reconcile(bootstrap.vault, answer === "denied"
        ? { kind: "denied" }
        : { kind: "ok", notes: [] });
      if (disconnect) {
        socket.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ type: "error", code: "not_found" }),
        }));
      }
      releaseExtensions?.(await loadExtensions());
      const surface = await opening;
      try {
        expect(dom.panel.dataset["body"]).toBe("waiting");
        await surface.destroy();
        network.dispatchEvent(new Event("online"));
        socket.dispatchEvent(new MessageEvent("message", {
          data: encodeBinaryFrame(0x01, bootstrap.vault, bootstrap.note, restricted).buffer,
        }));
        expect(await store.getResident(bootstrap.vault, bootstrap.note)).toBeUndefined();
        expect(await replica.base(bootstrap.vault, bootstrap.note)).toBeUndefined();
        const name = persistenceName(bootstrap.vault, bootstrap.note);
        expect(persistenceDestroyed).toEqual([name]);
        expect((await factory.databases()).map((database) => database.name)).not.toContain(name);
        expect(socket.readyState).toBe(WebSocket.CLOSED);
        expect(connections).toBe(1);
      } finally {
        await surface.destroy();
        store.close();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each(["failed", "closed"] as const)("releases a nonresident session after startup is %s", async (outcome) => {
    const store = await openOfflineStore(new IDBFactory());
    const dropped: string[] = [];
    const replica = createReplica({ store, dropBody: async (_vault, note) => { dropped.push(note); } });
    const opening = open({
      bootstrap, location, replica: async () => replica,
      loadExtensions: outcome === "closed" ? loadExtensions : async () => { throw new Error("extensions unavailable"); },
      createRemoteSync: () => ({
        connected: false, pending: 0, synced: false,
        sendAwareness: () => undefined, destroy: () => undefined,
      }),
    });
    try {
      if (outcome === "failed") await expect(opening).rejects.toThrow("extensions unavailable");
      else await (await opening).surface.destroy();
      await replica.reconcile(bootstrap.vault, { kind: "denied" });
      // No downloaded body and no live opening: a leaked session would still be purged.
      expect(dropped).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves restored unsent residency at zero pending until reconciliation", async () => {
    const store = await openOfflineStore(new IDBFactory());
    const replica = createReplica({ store, caps: { notes: 0, bytes: 0 }, dropBody: async () => undefined });
    await store.putResident({ vault: bootstrap.vault, note: bootstrap.note, openedAt: 1, bytes: 10, dirty: true });
    let report: ((state: ConnectionState) => void) | undefined;
    const pane = await open({
      bootstrap, location, replica: async () => replica,
      createRemoteSync: (_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return { connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      report?.({ connected: true, pending: 0, synced: false });
      expect(await replica.evict(bootstrap.vault)).toEqual([]);
      expect((await store.getResident(bootstrap.vault, bootstrap.note))?.dirty).toBe(true);
      report?.({ connected: true, pending: 1, synced: true });
      expect(await replica.evict(bootstrap.vault)).toEqual([]);
    } finally {
      await pane.surface.destroy();
      store.close();
    }
  });

  it("does not recreate denied residency when the synced transport disconnects", async () => {
    const store = await openOfflineStore(new IDBFactory());
    const dropped: string[] = [];
    const replica = createReplica({ store, dropBody: async (_vault, note) => { dropped.push(note); } });
    let report: ((state: ConnectionState) => void) | undefined;
    const pane = await open({
      bootstrap, location, replica: async () => replica,
      createRemoteSync: (_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return { connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      report?.({ connected: true, pending: 1, synced: true });
      await vi.waitFor(async () => expect(await replica.isResident(bootstrap.vault, bootstrap.note)).toBe(true));
      await replica.reconcile(bootstrap.vault, { kind: "denied" });
      // synced is latched: denial disconnects the socket without undoing its first sync.
      report?.({ connected: false, pending: 1, synced: true });
      await pane.surface.destroy();
      expect(dropped).toEqual([bootstrap.note]);
      expect(await store.getResident(bootstrap.vault, bootstrap.note)).toBeUndefined();
    } finally {
      await pane.surface.destroy();
      store.close();
    }
  });

  /** A replica that records every call the pane makes about residency. */
  function accounting() {
    const patches: Array<{ note: string; bytes?: number; dirty?: boolean }> = [];
    const evicted: string[] = [];
    return {
      patches,
      evicted,
      handle: async () =>
        stubReplica({
          isResident: async () => true,
          measured: async (_vault, note, patch) => {
            patches.push({ note, ...patch });
          },
          evict: async (vault) => {
            evicted.push(vault);
            return [];
          },
        }),
    };
  }

  it("sweeps the cap once, when a note opens", async () => {
    // The moment a new body has just been added, and the only moment that needs a sweep.
    const store = accounting();
    const { surface } = await open({ bootstrap, location, replica: store.handle });
    try {
      await vi.waitFor(() => expect(store.evicted).toEqual(["personal"]));
    } finally {
      await surface.destroy();
    }
  });

  it("does not mark a restored replica clean before the server has reconciled it", async () => {
    const store = accounting();
    let report: ((state: ConnectionState) => void) | undefined;
    const { surface } = await open({
      bootstrap,
      location,
      replica: store.handle,
      createRemoteSync: (_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return { connected: false, pending: 0, synced: false, sendAwareness: () => undefined, destroy: () => undefined };
      },
    });
    try {
      // The transport counter starts at zero even when IndexedDB holds offline edits.
      // Clearing the durable dirty flag now lets the opening LRU sweep delete those edits.
      report?.({ connected: true, pending: 0, synced: false });
      expect(store.patches.some((patch) => patch.dirty === false)).toBe(false);
      report?.({ connected: true, pending: 1, synced: true });
      await vi.waitFor(() => expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: true }));
      report?.({ connected: true, pending: 0, synced: true });
      await vi.waitFor(() => expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: false }));
    } finally {
      await surface.destroy();
    }
  });

  it("records unsent changes the moment there are any", async () => {
    // Not on teardown: a tab is usually closed by being closed, so a flag written only then
    // would be missing from exactly the session that produced it.
    const store = accounting();
    let report: ((state: ConnectionState) => void) | undefined;
    const { surface } = await open({
      bootstrap,
      location,
      replica: store.handle,
      createRemoteSync: ((_options, _document, _awareness, onConnectionChange) => {
        report = onConnectionChange;
        return {
          connected: false,
          pending: 0,
          synced: false,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    });
    try {
      report?.({ connected: false, pending: 2, synced: true });
      await vi.waitFor(() => expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: true }));

      report?.({ connected: true, pending: 0, synced: true });
      await vi.waitFor(() =>
        expect(store.patches).toContainEqual({ note: bootstrap.note, dirty: false }),
      );
    } finally {
      await surface.destroy();
    }
  });

  it("measures the document when the pane closes", async () => {
    // Seeded through the persistence stub, which is what a restored local replica is: an
    // empty document weighs two bytes whatever happens, so a note with something in it is
    // the only way to tell a measurement from a constant.
    const seed = new Doc();
    seed.getText("body").insert(0, "a".repeat(500));
    const update = encodeStateAsUpdate(seed);

    const store = accounting();
    const { surface } = await open({
      bootstrap,
      location,
      replica: store.handle,
      createPersistence: (_name, document) => {
        applyUpdate(document, update);
        return { whenSynced: Promise.resolve(), destroy: async () => undefined };
      },
    });
    await surface.destroy();

    const measured = store.patches.find((patch) => patch.bytes !== undefined);
    expect(measured?.note).toBe(bootstrap.note);
    expect(measured?.bytes).toBeGreaterThan(500);
  });
});

describe("reconciling §3.5's conflicts", () => {
  const bootstrap = { vault: "personal", note: "Projects/Roadmap.md", user: "alice" } as const;
  const location = { protocol: "http:", host: "localhost:9010" } as Location;

  /** A replica holding one merge base, recording every one written back. */
  function withBase(stored: string | undefined) {
    const written: string[] = [];
    const state = { asked: false };
    return {
      written,
      state,
      handle: async () =>
        stubReplica({
          isResident: async () => true,
          base: async () => {
            state.asked = true;
            return stored;
          },
          measured: async (_vault, _note, patch) => {
            if (patch.base !== undefined) written.push(patch.base);
          },
        }),
    };
  }

  /**
   * Opens a pane whose transport this test drives.
   *
   * `raise` applies the server's state to the document before announcing it, which is what
   * the real transport does and what the announcement means — the CRDT has already merged,
   * and `mine` is the only copy of what was there before. A fake that skipped the apply would
   * be testing a sequence that cannot happen.
   *
   * The transport is the only injected part: the real WASM bridge and the real editor are
   * mounted, because what is being checked is that the three are wired to each other.
   */
  async function openWithTransport(replica: () => Promise<ReturnType<typeof stubReplica>>) {
    let announce: ((state: { mine?: Uint8Array; theirs: Uint8Array }) => void) | undefined;
    let document: Doc | undefined;
    const opened = await open({
      bootstrap,
      location,
      replica,
      createRemoteSync: ((_options, remote, _awareness, _onConnectionChange, onServerState) => {
        document = remote;
        announce = onServerState;
        return {
          connected: true,
          pending: 0,
          synced: true,
          sendAwareness: () => undefined,
          destroy: () => undefined,
        };
      }) as NonNullable<Parameters<typeof openNoteSurface>[0]["createRemoteSync"]>,
    });
    return {
      ...opened,
      ready: (): boolean => announce !== undefined,
      raise: (state: { mine?: Uint8Array; theirs: Uint8Array }): void => {
        if (document !== undefined) applyUpdate(document, state.theirs);
        announce?.(state);
      },
    };
  }

  /** A note's state, as the server would send it or as this device would have captured it. */
  async function stateOf(markdown: string): Promise<Uint8Array> {
    return updateFromMarkdown(markdown);
  }

  it.each([false, true])("does not mark a saved prefix as a conflict after a local-only offline edit (reload: %s)", async (reload) => {
    // Real transport, Yjs/editor and WASM merge; only the network and IndexedDB are fake.
    // The merge base predates an acknowledged online edit, exactly as in autosave.spec.ts.
    class Socket extends EventTarget {
      readyState: number = WebSocket.CONNECTING;
      binaryType: BinaryType = "arraybuffer";
      readonly sent: Uint8Array[] = [];
      send(data: string | Uint8Array): void {
        if (typeof data !== "string") this.sent.push(data);
      }
      close(): void { this.readyState = WebSocket.CLOSED; }
      receive(tag: number, update: Uint8Array): void {
        this.dispatchEvent(new MessageEvent("message", {
          data: encodeBinaryFrame(tag, bootstrap.vault, bootstrap.note, update).buffer,
        }));
      }
    }
    const initial = "# Roadmap\n\nCafé 🧠.\n";
    const expected = "# Roadmap\n\nCafé 🧠. Saved online. Added offline.\n";
    let persisted = await stateOf(initial);
    const server = new Doc();
    applyUpdate(server, persisted);
    const store = withBase(initial);
    const network = new EventTarget();
    let local: Doc | undefined;
    let socket = new Socket();
    const mount = async () => open({
      bootstrap,
      location,
      replica: store.handle,
      createPersistence: (_name, document) => {
        local = document;
        applyUpdate(document, persisted);
        return localPersistence();
      },
      createRemoteSync: (options, document, awareness, onConnectionChange, onServerState) =>
        createSyncProvider({
          ...options,
          document,
          awareness,
          onConnectionChange,
          onServerState,
          network,
          connect: () => {
            socket = new Socket();
            return socket as unknown as WebSocket;
          },
        }),
    });
    const connect = (): void => {
      socket.readyState = WebSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "admitted", vault: bootstrap.vault, note: bootstrap.note, schema_version: SCHEMA_VERSION }) }));
      socket.receive(0x01, encodeStateAsUpdate(server));
    };
    const accept = (): void => {
      for (let bytes = socket.sent.shift(); bytes !== undefined; bytes = socket.sent.shift()) {
        const frame = decodeBinaryFrame(bytes);
        if (frame !== null) {
          applyUpdate(server, frame.payload);
          socket.receive(0x02, frame.payload);
        }
      }
    };
    const append = (suffix: string): void => {
      const paragraph = local?.getXmlFragment("prosemirror").get(1);
      if (!(paragraph instanceof XmlElement)) throw new Error("missing paragraph");
      const text = paragraph.get(0);
      if (!(text instanceof XmlText)) throw new Error("missing paragraph text");
      text.insert(text.length, suffix);
    };
    let pane = await mount();
    try {
      connect();
      accept();
      await vi.waitFor(() => expect(store.written.at(-1)).toBe(initial));
      append(" Saved online.");
      accept();
      network.dispatchEvent(new Event("offline"));
      append(" Added offline.");
      if (reload) {
        if (local === undefined) throw new Error("missing local document");
        persisted = encodeStateAsUpdate(local);
        await pane.surface.destroy();
        pane = await mount();
      } else {
        network.dispatchEvent(new Event("online"));
      }
      connect();
      accept();

      expect(pane.dom.panel.querySelector(".conflict-action")).toBeNull();
      await vi.waitFor(() => expect(store.written.at(-1)).toBe(expected));
      expect(await markdownFromUpdate(encodeStateAsUpdate(server))).toBe(expected);
    } finally {
      await pane.surface.destroy();
      server.destroy();
    }
  });

  it("marks a collision against the stored base and shows the count", async () => {
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({
        mine: await stateOf("Five levels.\n"),
        theirs: await stateOf("Four levels.\n"),
      });

      await vi.waitFor(() => {
        const count = pane.dom.panel.querySelector<HTMLElement>(".conflict-count");
        expect(count?.textContent).toBe("1 unresolved conflict — choose a version below");
        expect(count?.hidden).toBe(false);
      });
      const actions = pane.dom.panel.querySelectorAll(".conflict-action");
      expect([...actions].map((button) => button.textContent)).toEqual([
        "Keep mine",
        "Keep theirs",
        "Keep both",
      ]);
      expect(store.written.at(-1)).toContain("Five levels.");
      expect(store.written.at(-1)).toContain("[!conflict]");
    } finally {
      await pane.surface.destroy();
    }
  });

  it("marks nothing when only the other side changed the note", async () => {
    // The ordinary reconnection. Without the base this is indistinguishable from a collision,
    // and every note in a shared vault would grow a callout on every reconnect.
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({
        mine: await stateOf("Three levels.\n"),
        theirs: await stateOf("Four levels.\n"),
      });

      await vi.waitFor(() => expect(store.written).toEqual(["Four levels.\n"]));
      expect(pane.dom.panel.querySelector(".conflict-action")).toBeNull();
      expect(pane.dom.panel.querySelector<HTMLElement>(".conflict-count")?.hidden).toBe(true);
    } finally {
      await pane.surface.destroy();
    }
  });

  it("records what both sides hold even when there was nothing to reconcile", async () => {
    // §3.5's base is written on every arrival, not only a divergent one: a note that
    // reconnected cleanly is a note both sides now agree about, and that agreement is what
    // makes the *next* offline edit detectable.
    const store = withBase(undefined);
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({ theirs: await stateOf("Four levels.\n") });

      await vi.waitFor(() => expect(store.written).toEqual(["Four levels.\n"]));
    } finally {
      await pane.surface.destroy();
    }
  });

  it("records a base for a note this device did not hold until now", async () => {
    // The first sync of a note is the one with no resident record yet, and `measured` writes
    // nothing without one — so this used to drop the very first base of every note, leaving
    // the first offline edit after opening it with nothing to compare against.
    const written: string[] = [];
    let resident = false;
    const pane = await openWithTransport(async () =>
      stubReplica({
        isResident: async () => resident,
        base: async () => undefined,
        opened: async () => {
          resident = true;
        },
        measured: async (_vault, _note, patch) => {
          if (patch.base !== undefined && resident) written.push(patch.base);
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(pane.ready()).toBe(true));
      pane.raise({ theirs: await stateOf("Four levels.\n") });

      await vi.waitFor(() => expect(written).toEqual(["Four levels.\n"]));
    } finally {
      await pane.surface.destroy();
    }
  });

  it("compares the second arrival against the first one's result", async () => {
    // Held in memory as well as stored: two reconnections in one session must not both
    // compare against the version from before the first.
    const store = withBase("One.\n");
    const pane = await openWithTransport(store.handle);
    try {
      await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
      pane.raise({ theirs: await stateOf("Two.\n") });
      await vi.waitFor(() => expect(store.written).toEqual(["Two.\n"]));

      // Only they changed it again, measured against "Two." — against "One." this would read
      // as a collision and mark a callout.
      pane.raise({ mine: await stateOf("Two.\n"), theirs: await stateOf("Three.\n") });

      await vi.waitFor(() => expect(store.written).toEqual(["Two.\n", "Three.\n"]));
      expect(pane.dom.panel.querySelector(".conflict-action")).toBeNull();
    } finally {
      await pane.surface.destroy();
    }
  });

  it("stops reconciling once the pane is closed", async () => {
    // A pane is closed constantly under splits and tabs, and a transport that outlives one by
    // a frame would reconcile into an editor that has been destroyed.
    const store = withBase("Three levels.\n");
    const pane = await openWithTransport(store.handle);
    await vi.waitFor(() => expect(pane.ready() && store.state.asked).toBe(true));
    await pane.surface.destroy();
    store.written.length = 0;

    pane.raise({ mine: await stateOf("Five levels.\n"), theirs: await stateOf("Four levels.\n") });

    expect(store.written).toEqual([]);
  });

  it("does nothing for a local-only replica", async () => {
    // Nothing to diverge from and no base to keep, so no count is rendered — not even zero.
    const { surface, dom } = await open();
    try {
      expect(dom.panel.querySelector<HTMLElement>(".conflict-count")?.hidden).toBe(true);
      expect(dom.panel.querySelector(".conflict-action")).toBeNull();
    } finally {
      await surface.destroy();
    }
  });
});
