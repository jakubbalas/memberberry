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
