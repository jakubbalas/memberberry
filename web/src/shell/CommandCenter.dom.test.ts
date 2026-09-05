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
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";
import type { renameNote as renameNoteRequest, renameTag as renameTagRequest } from "./rename.js";
import { TagView } from "./tags.svelte.js";
import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { createWorkspace } from "./workspace.js";

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
  { path: "Welcome.md", title: "Welcome" },
  { path: "Projects/Roadmap.md", title: "Product roadmap" },
  { path: "Projects/2024-01-15.md", title: "Sprint planning" },
  { path: "Untitled.md", title: null },
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
    tags?: TagView;
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
      catalog: new NoteCatalog({ vault: "personal", load: async () => NOTES }),
      bookmarks: new Bookmarks({
        vault: "personal",
        fetch: (async () => new Response("[]")) as unknown as typeof globalThis.fetch,
      }),
      loadVaults: async () => VAULTS,
      ...(options.onvault === undefined ? {} : { onvault: options.onvault }),
      ...(options.renameNote === undefined ? {} : { renameNote: options.renameNote }),
      ...(options.renameTag === undefined ? {} : { renameTag: options.renameTag }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
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
      shortcut("P", { shiftKey: true });
      await tick();
      expect(palette()?.open).toBe(true);
      expect(palette()?.getAttribute("aria-label")).toBe("Command palette");
    } finally {
      teardown();
    }
  });

  it("opens the quick switcher on its shortcut, and lists notes", async () => {
    const { teardown } = render();
    try {
      await tick();
      shortcut("k");
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
      shortcut("k");
      await flush();
      expect(palette()?.getAttribute("aria-label")).toBe("Open a note");

      shortcut("P", { shiftKey: true });
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
      shortcut("P", { shiftKey: true });
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
      shortcut("P", { shiftKey: true });
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
      shortcut("P", { shiftKey: true });
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

describe("the quick switcher", () => {
  it("finds a note by its title rather than its filename", async () => {
    // The whole reason the server parses titles: `Projects/2024-01-15.md` is "Sprint
    // planning", and nobody remembers the date.
    const { teardown } = render();
    try {
      await tick();
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
      shortcut("k");
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
    shortcut("P", { shiftKey: true });
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
      shortcut("P", { shiftKey: true });
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
