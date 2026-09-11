// @vitest-environment jsdom

/**
 * The command palette, quick switcher and vault switcher (`SPEC.md` §8.4).
 *
 * The ranking, the binding resolution and the fetching each have their own tests. What is left
 * here is the wiring, and the keyboard behaviour that the three share — which is the part users
 * feel and the part that would be subtly different three times if this were three components.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import Workspace from "./Workspace.svelte";
import { Bookmarks } from "./bookmarks.svelte.js";
import type { NoteSummary, VaultSummary } from "./catalog.js";
import { NoteCatalog } from "./note-catalog.svelte.js";
import { PinnedNotes } from "./pins.svelte.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import type { createNote as createNoteRequest } from "./create.js";
import type { renameNote as renameNoteRequest, renameTag as renameTagRequest } from "./rename.js";
import { TagView } from "./tags.svelte.js";
import { stubReplica } from "../offline/testing.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";
import { DailyView } from "./daily.svelte.js";

/** jsdom implements `<dialog>` as an element but not as a dialog. See `MobileWorkspace`. */
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

const openSurface = async (_options: OpenNoteSurfaceOptions): Promise<NoteSurface> => ({
  destroy: async () => undefined,
});

const NOTES: readonly NoteSummary[] = [
  { path: "Welcome.md", title: "Welcome", conflicts: 0 },
  { path: "Projects/Roadmap.md", title: "Product roadmap", conflicts: 0 },
  { path: "Projects/2024-01-15.md", title: "Sprint planning", conflicts: 0 },
  { path: "Untitled.md", title: null, conflicts: 0 },
];

const VAULTS: readonly VaultSummary[] = [
  { slug: "personal", name: "Personal" },
  { slug: "work", name: "Work notes" },
];

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
  options: {
    notes?: readonly string[];
    onvault?: (slug: string) => void;
    renameNote?: typeof renameNoteRequest;
    renameTag?: typeof renameTagRequest;
    createNote?: typeof createNoteRequest;
    tags?: TagView;
    pins?: PinnedNotes;
    daily?: DailyView;
  } = {},
) {
  const ids = sessionIds();
  const store = new WorkspaceStore({ initial: createWorkspace("personal", ids), ids });
  for (const note of options.notes ?? []) store.open(note);

  const app = mount(Workspace, {
    target,
    props: {
      store,
      session: { vault: "personal", user: "alice" },
      chrome: { getItem: () => null, setItem: () => undefined },
      open: openSurface,
      target: commands,
      platform: "mac" as const,
      mode: "desktop" as const,
      // The note list is the shared catalog now, not a per-palette fetch: the tree and the
      // switcher search the same one.
      catalog: new NoteCatalog({
        vault: "personal",
        load: async () => ({ kind: "ok", notes: NOTES }),
        replica: async () => undefined,
      }),
      bookmarks: new Bookmarks({
        vault: "personal",
        fetch: (async () => new Response("[]")) as unknown as typeof globalThis.fetch,
      }),
      loadVaults: async () => VAULTS,
      ...(options.onvault === undefined ? {} : { onvault: options.onvault }),
      ...(options.renameNote === undefined ? {} : { renameNote: options.renameNote }),
      ...(options.renameTag === undefined ? {} : { renameTag: options.renameTag }),
      ...(options.createNote === undefined ? {} : { createNote: options.createNote }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      ...(options.pins === undefined ? {} : { pins: options.pins }),
      ...(options.daily === undefined ? {} : { daily: options.daily }),
    },
  });
  return { store, teardown: () => unmount(app) };
}

/** Presses a shortcut on the shell's command target. */
function shortcut(key: string, modifiers: Record<string, boolean> = {}): void {
  commands.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, ...modifiers }));
}

const palette = (): HTMLDialogElement | null => target.querySelector("dialog.palette");
const input = (): HTMLInputElement | null => target.querySelector(".palette-input");
const options = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('[role="option"]')];
const labels = (): string[] => options().map((option) => option.textContent?.trim() ?? "");

/** Types into the palette, the way an `input` event would. */
async function type(text: string): Promise<void> {
  const field = input();
  if (field === null) throw new Error("the palette should have an input");
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

/** Sends a key to the palette input. */
async function key(name: string): Promise<void> {
  input()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  await tick();
}

describe("opening", () => {
  it("opens the command palette on its shortcut", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("p");
      await tick();
      expect(palette()?.open).toBe(true);
      expect(palette()?.getAttribute("aria-label")).toBe("Command palette");
    } finally {
      teardown();
    }
  });

  it("opens the quick switcher from the top bar as well as from the keystroke", async () => {
    // §8.4: one command, reached two ways. The bar is a sibling of the palette rather than
    // its parent, so this is the whole path — button, `PALETTE_EVENT`, `CommandCenter` —
    // and a break anywhere along it leaves a button that visibly does nothing.
    const { teardown } = render();
    try {
      await tick();
      target.querySelector<HTMLButtonElement>(".topbar-find")?.click();
      await flush();
      expect(palette()?.open).toBe(true);
      expect(palette()?.getAttribute("aria-label")).toBe("Open a note");
      expect(labels()).toContain("Welcome");
    } finally {
      teardown();
    }
  });

  it("opens the quick switcher on its shortcut, and lists notes", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      expect(palette()?.getAttribute("aria-label")).toBe("Open a note");
      expect(labels()).toContain("Welcome");
    } finally {
      teardown();
    }
  });

  it("opens the vault switcher on its shortcut", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("V", { shiftKey: true });
      await flush();
      expect(palette()?.getAttribute("aria-label")).toBe("Switch vault");
      expect(labels()).toContain("Work notes");
    } finally {
      teardown();
    }
  });

  it("does not re-open or switch palettes while one is already open", async () => {
    // The palette owns the keyboard while it is up: its own Escape and arrows must not also
    // fire a shortcut behind it.
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      expect(palette()?.getAttribute("aria-label")).toBe("Open a note");

      shortcut("p");
      await tick();
      expect(palette()?.getAttribute("aria-label")).toBe("Open a note");
    } finally {
      teardown();
    }
  });
});

describe("the command palette", () => {
  it("lists commands with their bindings, formatted for the platform", async () => {
    const { teardown } = render(["Welcome.md"].length > 0 ? { notes: ["Welcome.md"] } : {});
    try {
      await tick();
      shortcut("p");
      await tick();
      const rows = labels();
      expect(rows.some((row) => row.includes("Split pane right"))).toBe(true);
      // Pinned to `mac`, so the binding renders with symbols rather than "Ctrl".
      expect(rows.some((row) => row.includes("⌘\\"))).toBe(true);
    } finally {
      teardown();
    }
  });

  it("narrows as you type, and runs the command you pick", async () => {
    const { store, teardown } = render({ notes: ["Welcome.md"] });
    try {
      await tick();
      shortcut("p");
      await tick();

      await type("split right");
      expect(labels()).toHaveLength(1);
      expect(labels()[0]).toContain("Split pane right");

      await key("Enter");
      await flush();
      expect(store.groups).toHaveLength(2);
      expect(palette()?.open).toBe(false);
    } finally {
      teardown();
    }
  });

  it("marks a command that cannot run right now, and refuses to run it", async () => {
    // "Close pane" with one pane open. Showing it greyed is better than hiding it: a command
    // that vanishes is one the user cannot find out about.
    const { store, teardown } = render();
    try {
      await tick();
      shortcut("p");
      await tick();
      await type("close pane");

      const option = options()[0];
      expect(option?.getAttribute("aria-disabled")).toBe("true");
      option?.click();
      await flush();
      expect(store.groups).toHaveLength(1);
      // Still open, because nothing was chosen.
      expect(palette()?.open).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe("periodic note commands", () => {
  it("creates this week's note through the ordinary note creation boundary", async () => {
    const daily = new DailyView({
      vault: "personal",
      formatPath: async (period, folder, _format, date) => period === "weekly"
        ? `${folder}2026-W37.md`
        : `${folder}${date.slice(0, 7)}.md`,
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [],
        weekly: { folder: "Weekly", format: "%G-W%V.md", notes: [] },
        monthly: { folder: "Monthly", format: "%Y-%m.md", notes: [] },
      }),
    });
    await daily.refresh();
    const created: string[] = [];
    const { store, teardown } = render({
      daily,
      createNote: async (_vault, path) => {
        created.push(path);
        return { ok: { path } };
      },
    });
    try {
      await flush();
      shortcut("p");
      await flush();
      await type("Open this week");
      await key("Enter");
      for (let attempt = 0; attempt < 10 && created.length === 0; attempt += 1) await flush();

      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^Weekly\/\d{4}-W\d{2}\.md$/);
      expect(store.activeTab?.note).toBe(created[0]);
    } finally {
      teardown();
    }
  });

  it("opens an existing monthly note without trying to create it", async () => {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const path = `Monthly/${date.slice(0, 7)}.md`;
    const daily = new DailyView({
      vault: "personal",
      formatPath: async (_period, folder, _format, value) => `${folder}${value.slice(0, 7)}.md`,
      load: async () => ({
        folder: "Daily",
        format: "%Y-%m-%d.md",
        notes: [],
        weekly: { folder: "Weekly", format: "%G-W%V.md", notes: [] },
        monthly: { folder: "Monthly", format: "%Y-%m.md", notes: [{ date: `${date.slice(0, 7)}-01`, path }] },
      }),
    });
    await daily.refresh();
    let creates = 0;
    const { store, teardown } = render({
      daily,
      createNote: async () => {
        creates += 1;
        return { refused: "must not create" };
      },
    });
    try {
      await flush();
      shortcut("p");
      await flush();
      await type("Open this month");
      await key("Enter");
      for (let attempt = 0; attempt < 10 && store.activeTab?.note !== path; attempt += 1) await flush();

      expect(store.activeTab?.note).toBe(path);
      expect(creates).toBe(0);
    } finally {
      teardown();
    }
  });
});

describe("the quick switcher", () => {
  it("finds a note by its title rather than its filename", async () => {
    // The whole reason the server parses titles: `Projects/2024-01-15.md` is "Sprint
    // planning", and nobody remembers the date.
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();

      await type("sprint");
      expect(labels()[0]).toContain("Sprint planning");
    } finally {
      teardown();
    }
  });

  it("falls back to the path for a note with no title", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      await type("untitled");
      expect(labels()[0]).toContain("Untitled");
    } finally {
      teardown();
    }
  });

  it("opens the chosen note in the workspace", async () => {
    const { store, teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      await type("roadmap");
      await key("Enter");
      await flush();

      expect(store.activeTab?.note).toBe("Projects/Roadmap.md");
      expect(palette()?.open).toBe(false);
    } finally {
      teardown();
    }
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      await type("zzzzzz");
      expect(target.querySelector(".palette-empty")?.textContent).toBe("No note matches.");
    } finally {
      teardown();
    }
  });
});

describe("the vault switcher", () => {
  it("navigates to the chosen vault", async () => {
    const visited: string[] = [];
    const { teardown } = render({ onvault: (slug) => visited.push(slug) });
    try {
      await tick();
      shortcut("V", { shiftKey: true });
      await flush();
      await type("work");
      await key("Enter");
      await flush();
      expect(visited).toEqual(["work"]);
    } finally {
      teardown();
    }
  });

  it("marks the current vault and will not navigate to it", async () => {
    const visited: string[] = [];
    const { teardown } = render({ onvault: (slug) => visited.push(slug) });
    try {
      await tick();
      shortcut("V", { shiftKey: true });
      await flush();
      await type("personal");

      const option = options()[0];
      expect(option?.textContent).toContain("current");
      option?.click();
      await flush();
      expect(visited).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe("the palette keyboard", () => {
  it("is a combobox driving a listbox, with focus staying in the input", async () => {
    // `aria-activedescendant`, not roving focus: the user is still typing, so focus cannot
    // leave the input. This is the pattern combobox exists for.
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();

      const field = input();
      expect(field?.getAttribute("role")).toBe("combobox");
      expect(field?.getAttribute("aria-controls")).toBe("palette-list");
      expect(target.querySelector('[role="listbox"]')).not.toBeNull();
      expect(field?.getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
    } finally {
      teardown();
    }
  });

  it("moves the selection with the arrow keys and wraps at the ends", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      const count = options().length;
      expect(count).toBeGreaterThan(1);

      await key("ArrowDown");
      expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

      await key("ArrowUp");
      await key("ArrowUp");
      // Wrapped past the top to the last option: a list you cannot cycle is one you have to
      // look at to use.
      expect(options()[count - 1]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      teardown();
    }
  });

  it("resets the selection when the results change underneath it", async () => {
    // Keeping index 3 after the results narrow to two selects something never looked at —
    // and Enter then opens it.
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      await key("ArrowDown");
      await key("ArrowDown");

      await type("roadmap");
      expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
    } finally {
      teardown();
    }
  });

  it("closes on dismiss without acting", async () => {
    const { store, teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      palette()?.close();
      await tick();

      expect(palette()?.open).toBe(false);
      expect(store.tabs).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("highlights where the query matched", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("o");
      await flush();
      await type("road");
      // The label is the *title*, "Product roadmap" — so the highlight lands on "road" in
      // "roadmap", not on the "ro" of "Product" that a purely greedy matcher would pick.
      expect(target.querySelector(".palette-match")?.textContent).toBe("road");
    } finally {
      teardown();
    }
  });
});

describe("rename (SPEC 6.6)", () => {
  const prompt = (): HTMLDialogElement | null => target.querySelector("dialog.rename-prompt");
  const nameField = (): HTMLInputElement | null => target.querySelector(".rename-input");
  const notice = (): string => target.querySelector(".rename-notice")?.textContent?.trim() ?? "";

  /** Opens the palette and runs the command with this title. */
  async function run(title: string): Promise<void> {
    shortcut("p");
    await flush();
    const option = options().find((entry) => entry.textContent?.trim().startsWith(title));
    if (option === undefined) {
      throw new Error(`no palette entry for ${title}; saw ${labels().join(", ")}`);
    }
    option.click();
    await flush();
  }

  async function submit(name: string): Promise<void> {
    const field = nameField();
    if (field === null) throw new Error("the prompt should have an input");
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>(".rename-body")?.requestSubmit();
    await flush();
    await flush();
  }

  it("prefills the open note's name and sends the path its folder implies", async () => {
    const calls: Array<readonly [string, string, string]> = [];
    const { teardown } = render({
      notes: ["Projects/Roadmap.md"],
      renameNote: async (vault, from, to) => {
        calls.push([vault, from, to]);
        return { ok: { to, notes: 2, references: 3 } };
      },
    });
    try {
      await flush();
      await run("Rename note…");
      expect(prompt()?.open).toBe(true);
      // Prefilled with the *name*, not the path: nobody retypes the folder to rename a note.
      expect(nameField()?.value).toBe("Roadmap");
      await submit("Plan");
      expect(calls).toEqual([["personal", "Projects/Roadmap.md", "Projects/Plan.md"]]);
      expect(prompt()?.open).toBe(false);
    } finally {
      teardown();
    }
  });

  it("moves every tab showing the renamed note, not only the one it was asked from", async () => {
    // Two panes over one note is an ordinary split. Leaving the other pointed at a path that
    // no longer exists would render an error beside a working editor.
    const { store, teardown } = render({
      notes: ["Projects/Roadmap.md"],
      renameNote: async (_vault, _from, to) => ({ ok: { to, notes: 0, references: 0 } }),
    });
    try {
      await flush();
      store.split(store.focusedGroup, "vertical", "Projects/Roadmap.md");
      await flush();
      expect(store.tabs.filter((tab) => tab.note === "Projects/Roadmap.md")).toHaveLength(2);
      await run("Rename note…");
      await submit("Plan");
      expect(store.tabs.map((tab) => tab.note)).toEqual([
        "Projects/Plan.md",
        "Projects/Plan.md",
      ]);
    } finally {
      teardown();
    }
  });

  it("says what the count means, and keeps the prompt open on a refusal", async () => {
    const { teardown } = render({
      notes: ["Welcome.md"],
      renameNote: async () => ({ refused: "That name is taken." }),
    });
    try {
      await flush();
      await run("Rename note…");
      await submit("Plan");
      expect(target.querySelector(".rename-error")?.textContent).toBe("That name is taken.");
      expect(prompt()?.open).toBe(true);
      expect(notice()).toBe("");
    } finally {
      teardown();
    }
  });

  it("reports the count as notes the user can see", async () => {
    const { teardown } = render({
      notes: ["Welcome.md"],
      renameNote: async (_vault, _from, to) => ({ ok: { to, notes: 2, references: 3 } }),
    });
    try {
      await flush();
      await run("Rename note…");
      await submit("Plan");
      expect(notice()).toBe("Renamed to Plan.md. Updated 3 references in 2 notes you can see.");
    } finally {
      teardown();
    }
  });

  it("refuses a name that is not one without asking the server", async () => {
    // Both paths, because they reject for different reasons: a note name goes through
    // `notePathFor`, and a tag has only its own emptiness to be caught by.
    let asked = 0;
    const tags = new TagView({
      vault: "personal",
      load: async () => [{ tag: "project", key: "project", notes: 1 }],
      loadNotes: async () => ({ tag: "project", notes: [] }),
    });
    const { teardown } = render({
      notes: ["Welcome.md"],
      tags,
      renameNote: async (_vault, _from, to) => {
        asked += 1;
        return { ok: { to, notes: 0, references: 0 } };
      },
      renameTag: async (_vault, _from, to) => {
        asked += 1;
        return { ok: { to, notes: 0, references: 0 } };
      },
    });
    try {
      await flush();
      await run("Rename note…");
      await submit("   ");
      expect(asked).toBe(0);
      expect(target.querySelector(".rename-error")?.textContent).toBe("That is not a usable name.");

      target.querySelector<HTMLButtonElement>(".rename-cancel")?.click();
      await flush();
      tags.select("project");
      await flush();
      await run("Rename the selected tag");
      await submit("   ");
      expect(asked).toBe(0);
      expect(target.querySelector(".rename-error")?.textContent).toBe("That is not a usable name.");
    } finally {
      teardown();
    }
  });

  it("renames whichever tag the pane has selected, and deselects it afterwards", async () => {
    // Deselected rather than re-selected under its new key: the key is folded server-side
    // (§9.3), so guessing it in the client would be a second copy of that rule.
    const calls: Array<readonly [string, string]> = [];
    const tags = new TagView({
      vault: "personal",
      load: async () => [{ tag: "project", key: "project", notes: 2 }],
      loadNotes: async () => ({ tag: "project", notes: [] }),
    });
    const { teardown } = render({
      tags,
      renameTag: async (_vault, from, to) => {
        calls.push([from, to]);
        return { ok: { to, notes: 2, references: 2 } };
      },
    });
    try {
      await flush();
      tags.select("project");
      await flush();
      await run("Rename the selected tag");
      expect(nameField()?.value).toBe("project");
      await submit("work");
      expect(calls).toEqual([["project", "work"]]);
      expect(tags.selected).toBeUndefined();
    } finally {
      teardown();
    }
  });

  it("offers no rename when nothing is open, and no tag rename when none is selected", async () => {
    const { teardown } = render();
    try {
      await flush();
      shortcut("p");
      await flush();
      const disabled = options()
        .filter((option) => option.getAttribute("aria-disabled") === "true")
        .map((option) => option.textContent?.trim() ?? "");
      expect(disabled).toContain("Rename note…");
      expect(disabled.some((label) => label.startsWith("Rename the selected tag"))).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe("creating a note (SPEC 6.10)", () => {
  const prompt = (): HTMLDialogElement | null => target.querySelector("dialog.rename-prompt");
  const nameField = (): HTMLInputElement | null => target.querySelector(".rename-input");
  const notice = (): string => target.querySelector(".rename-notice")?.textContent?.trim() ?? "";
  const error = (): string => target.querySelector(".rename-error")?.textContent?.trim() ?? "";

  async function run(title: string): Promise<void> {
    shortcut("p");
    await flush();
    const option = options().find((entry) => entry.textContent?.trim().startsWith(title));
    if (option === undefined) {
      throw new Error(`no palette entry for ${title}; saw ${labels().join(", ")}`);
    }
    option.click();
    await flush();
  }

  async function submit(name: string): Promise<void> {
    const field = nameField();
    if (field === null) throw new Error("the prompt should have an input");
    field.value = name;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    target.querySelector<HTMLFormElement>(".rename-body")?.requestSubmit();
    await flush();
    await flush();
  }

  it("creates the note beside the one that is open, and opens it", async () => {
    const calls: Array<readonly [string, string]> = [];
    const { store, teardown } = render({
      notes: ["Projects/Roadmap.md"],
      createNote: async (vault, path) => {
        calls.push([vault, path]);
        return { ok: { path } };
      },
    });
    try {
      await flush();
      await run("New note…");
      expect(prompt()?.open).toBe(true);
      // Empty, not prefilled: there is no existing name to edit.
      expect(nameField()?.value).toBe("");
      await submit("Plan");

      expect(calls).toEqual([["personal", "Projects/Plan.md"]]);
      // Opening it is the point — somebody who just named a note wants to write in it.
      expect(store.tabs.some((tab) => tab.note === "Projects/Plan.md")).toBe(true);
      expect(store.activeTab?.note).toBe("Projects/Plan.md");
      expect(prompt()?.open).toBe(false);
      expect(notice()).toContain("Projects/Plan.md");
    } finally {
      teardown();
    }
  });

  it("creates at the vault root when nothing is open", async () => {
    const calls: string[] = [];
    const { teardown } = render({
      createNote: async (_vault, path) => {
        calls.push(path);
        return { ok: { path } };
      },
    });
    try {
      await flush();
      await run("New note…");
      await submit("First");
      expect(calls).toEqual(["First.md"]);
    } finally {
      teardown();
    }
  });

  it("is offered even with nothing open, which is when it matters most", async () => {
    // The other note commands are disabled without an active tab. This one must not be: an
    // empty vault is exactly the case the command exists for.
    const { teardown } = render();
    try {
      await flush();
      shortcut("p");
      await flush();
      const entry = options().find((option) => option.textContent?.trim().startsWith("New note…"));
      expect(entry).toBeDefined();
      expect(entry?.getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      teardown();
    }
  });

  it("does not warn about rewriting other notes, because it does not touch any", async () => {
    // The rename prompt's warning is about a privileged rewrite reaching notes the user
    // cannot see. Creating a note touches one file and nobody else's, so inheriting that
    // sentence would be a lie about what the button does.
    const { teardown } = render({ notes: ["Projects/Roadmap.md"] });
    try {
      await flush();
      await run("New note…");
      expect(target.querySelector(".rename-warning")).toBeNull();
      expect(prompt()?.getAttribute("aria-label")).toBe("New note");
      expect(target.querySelector(".rename-confirm")?.textContent?.trim()).toBe("Create");

      // And the rename prompt still carries it, so this is a difference and not a deletion.
      target.querySelector<HTMLButtonElement>(".rename-cancel")?.click();
      await flush();
      await run("Rename note…");
      expect(target.querySelector(".rename-warning")?.textContent).toContain("cannot see");
      expect(target.querySelector(".rename-confirm")?.textContent?.trim()).toBe("Rename");
    } finally {
      teardown();
    }
  });

  it("says where the note will go without making the user read a path", async () => {
    const { teardown } = render({ notes: ["Projects/Roadmap.md"] });
    try {
      await flush();
      await run("New note…");
      expect(target.querySelector(".rename-subject")?.textContent?.trim()).toBe("In Projects/");
    } finally {
      teardown();
    }
  });

  it("keeps the prompt open on a refusal, with the reason, and opens nothing", async () => {
    const { store, teardown } = render({
      createNote: async () => ({ refused: "`Plan.md` already exists" }),
    });
    try {
      await flush();
      await run("New note…");
      await submit("Plan");

      expect(prompt()?.open).toBe(true);
      expect(error()).toContain("already exists");
      expect(store.tabs.some((tab) => tab.note === "Plan.md")).toBe(false);
    } finally {
      teardown();
    }
  });

  it("refuses a name that cannot be a path without asking the server", async () => {
    let asked = false;
    const { teardown } = render({
      createNote: async (_vault, path) => {
        asked = true;
        return { ok: { path } };
      },
    });
    try {
      await flush();
      await run("New note…");
      await submit("   ");

      expect(asked).toBe(false);
      expect(error()).toContain("not a usable name");
      expect(prompt()?.open).toBe(true);
    } finally {
      teardown();
    }
  });
});

describe("keeping a note offline (SPEC §7.2)", () => {
  /** Opens the command palette and clicks the entry starting with `title`. */
  async function runCommand(title: string): Promise<void> {
    shortcut("p");
    await flush();
    const option = options().find((entry) => entry.textContent?.trim().startsWith(title));
    if (option === undefined) {
      throw new Error(`no palette entry for ${title}; saw ${labels().join(", ")}`);
    }
    option.click();
    await flush();
  }

  /** A `PinnedNotes` over a replica whose pins live in a set. */
  function pinnedNotes(...initial: string[]) {
    const stored = new Set(initial);
    return {
      stored,
      pins: new PinnedNotes({
        vault: "personal",
        replica: async () =>
          stubReplica({
            pinned: async () => [...stored],
            setPinned: async (_vault, note, pinned) => {
              if (pinned) stored.add(note);
              else stored.delete(note);
            },
          }),
      }),
    };
  }

  it("pins the note in front, and says so the next time it is asked", async () => {
    const store = pinnedNotes();
    const { teardown } = render({ notes: ["Projects/Roadmap.md"], pins: store.pins });
    try {
      // The shell attaches its hotkey listener from an effect, so the first keystroke has to
      // wait for it — every command test in this file starts the same way.
      await flush();
      await runCommand("Keep this note available offline");
      await flush();

      expect([...store.stored]).toEqual(["Projects/Roadmap.md"]);
      // The command is a toggle, so its wording has to follow the state — otherwise it takes
      // two commands to say one thing.
      shortcut("p");
      await flush();
      expect(labels().some((label) => label.startsWith("Stop keeping this note offline"))).toBe(true);
    } finally {
      teardown();
    }
  });

  it("stays open when a stale native close event arrives after an immediate reopen", async () => {
    const store = pinnedNotes();
    const { teardown } = render({ notes: ["Projects/Roadmap.md"], pins: store.pins });
    try {
      await flush();
      shortcut("p");
      await flush();
      const dialog = palette();
      if (dialog === null) throw new Error("the palette should be open");
      let deliverClose = (): void => {};
      dialog.close = function closeLater(this: HTMLDialogElement): void {
        this.open = false;
        deliverClose = () => this.dispatchEvent(new Event("close"));
      };
      const option = options().find((entry) =>
        entry.textContent?.trim().startsWith("Keep this note available offline"),
      );
      if (option === undefined) throw new Error("the pin command should be listed");
      option.click();
      await tick();

      shortcut("p");
      await flush();
      expect(palette()?.open).toBe(true);

      // Deliver the event queued by the *previous* close after the second shortcut opened.
      deliverClose();
      await flush();
      expect(palette()?.open).toBe(true);
    } finally {
      teardown();
    }
  });

  it("unpins it again", async () => {
    const store = pinnedNotes("Projects/Roadmap.md");
    const { teardown } = render({ notes: ["Projects/Roadmap.md"], pins: store.pins });
    try {
      await flush();
      // The list is loaded when the palette first opens, like the note catalog.
      shortcut("p");
      await flush();
      await flush();
      await runCommand("Stop keeping this note offline");
      await flush();
      expect([...store.stored]).toEqual([]);
    } finally {
      teardown();
    }
  });

  it("cannot be run on a device with nowhere to keep a replica", async () => {
    // jsdom has no IndexedDB, which is exactly the private-window case: the command is
    // listed and refuses, rather than pretending to pin a note that will not be there.
    const { teardown } = render({ notes: ["Projects/Roadmap.md"] });
    try {
      await flush();
      shortcut("p");
      await flush();
      // Not a vacuous assertion: the palette is open and full of other commands.
      expect(labels().length).toBeGreaterThan(5);
      const row = options().find((entry) => entry.textContent?.includes("offline"));
      expect(row?.getAttribute("aria-disabled")).toBe("true");
    } finally {
      teardown();
    }
  });
});
