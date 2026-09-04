/** Accessible controls around the local Tiptap editor. */

import type { Editor } from "@tiptap/core";
import type { Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";

import type { ConnectionStatus } from "./collaboration.js";
import { PRESENCE_CLIENT_ATTRIBUTE, trackPresenceIdle } from "./presence.js";

import { insertBlock, moveCurrentBlock, runTaskSlashCommand, setHeading, setTaskDue, setTaskPriority, slashCommands, toggleTask } from "./commands.js";
import { mountOutline } from "./outline.js";
import { applySourceMarkdown, copyMarkdown, editorMarkdown, longNoteMode, setLongNoteMode } from "./source.js";
import { TASK_CHIP_EVENT, type TaskChipEventDetail } from "./task-view.js";
import type { TaskChipField, TaskPriority } from "./task-metadata.js";

export interface EditorShell {
  destroy(): void;
}

export interface MountEditorShellOptions {
  readonly editor: Editor;
  readonly document: Doc;
  readonly panel: HTMLElement;
  readonly status: HTMLElement;
  readonly awareness?: Awareness;
  readonly connection?: ConnectionStatus;
}

/** Mounts the M3 editor controls and releases every listener when the note closes. */
export function mountEditorShell(options: MountEditorShellOptions): EditorShell {
  const controls = document.createElement("div");
  controls.className = "editor-controls";
  controls.setAttribute("aria-label", "Editor controls");
  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Block toolbar");
  controls.append(toolbar);

  const source = document.createElement("textarea");
  source.className = "source-view";
  source.hidden = true;
  source.setAttribute("aria-label", "Markdown source");
  const sourceToggle = button("Source", "Toggle Markdown source view");
  const copy = button("Copy Markdown", "Copy canonical Markdown");
  let sourceVisible = false;
  let latestMarkdown = "";

  for (const [label, action] of [
    ["Text", () => insertBlock(options.editor, "paragraph")],
    ["H1", () => setHeading(options.editor, 1)],
    ["List", () => insertBlock(options.editor, "bullet_list")],
    ["1. List", () => insertBlock(options.editor, "ordered_list")],
    ["Task", () => insertBlock(options.editor, "task_item")],
    ["Quote", () => insertBlock(options.editor, "blockquote")],
    ["Callout", () => insertBlock(options.editor, "callout")],
    ["Code", () => insertBlock(options.editor, "code_block")],
    ["Rule", () => insertBlock(options.editor, "divider")],
    ["Move up", () => moveCurrentBlock(options.editor, "up")],
    ["Move down", () => moveCurrentBlock(options.editor, "down")],
  ] as const) {
    const control = button(label, `Insert ${label.toLowerCase()} block`);
    control.addEventListener("click", () => action());
    toolbar.append(control);
  }
  toolbar.append(sourceToggle, copy);

  const inspector = taskInspector(options.editor);
  controls.append(inspector.element, source);
  options.panel.prepend(controls);
  const presence = options.awareness === undefined
    ? undefined
    : mountPresence(options.panel, options.awareness, options.connection);

  const slash = slashMenu(options.editor, toolbar);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") slash.hide();
    if (event.key !== "Enter") return;
    const query = slash.query();
    if (query === null) return;
    const result = runTaskSlashCommand(options.editor, query);
    if (result !== null) {
      event.preventDefault();
      slash.hide();
      options.status.textContent = result ? "Task metadata updated." : "Use a date such as tomorrow or next Friday.";
    }
  };
  const onKeyUp = (): void => slash.sync();
  options.editor.view.dom.addEventListener("keydown", onKeyDown);
  options.editor.view.dom.addEventListener("keyup", onKeyUp);

  // §10.2: clicking a chip opens its picker. The node view has already moved the selection
  // onto the task it belongs to, so the inspector below is showing the right one.
  const onChip = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    if (typeof detail === "object" && detail !== null && "field" in detail) {
      inspector.open((detail as TaskChipEventDetail).field);
    }
  };
  options.editor.view.dom.addEventListener(TASK_CHIP_EVENT, onChip);

  /**
   * The control strip shows only what applies to where the cursor is.
   *
   * Both rows below the toolbar were built always-on for M3's convenience and stayed that
   * way through M7, which is what made the strip about 380px tall above *every* note and
   * twice that in a split. The slash menu belongs to a `/` being typed and the inspector to a
   * task being selected; neither is a property of having a note open.
   */
  const refreshControls = (): void => {
    inspector.sync(options.editor.isActive("task_item") ? options.editor.getAttributes("task_item") : null);
    slash.sync();
  };
  options.editor.on("selectionUpdate", refreshControls);
  options.editor.on("update", refreshControls);
  refreshControls();

  const refreshLongNoteMode = (): void => setLongNoteMode(options.panel, longNoteMode(options.editor));
  options.editor.on("update", refreshLongNoteMode);
  refreshLongNoteMode();

  const onSourceToggle = async (): Promise<void> => {
    if (sourceVisible) {
      await applySourceMarkdown(options.editor, source.value);
      source.hidden = true;
      options.editor.view.dom.hidden = false;
      sourceToggle.setAttribute("aria-pressed", "false");
      sourceVisible = false;
      options.status.textContent = "Markdown source applied.";
      return;
    }
    latestMarkdown = await editorMarkdown(options.document);
    source.value = latestMarkdown;
    options.editor.view.dom.hidden = true;
    source.hidden = false;
    source.focus();
    sourceToggle.setAttribute("aria-pressed", "true");
    sourceVisible = true;
  };
  const onCopy = async (): Promise<void> => {
    latestMarkdown = sourceVisible ? source.value : await editorMarkdown(options.document);
    options.status.textContent = await copyMarkdown(latestMarkdown) ? "Canonical Markdown copied." : "Clipboard access is unavailable.";
  };
  sourceToggle.addEventListener("click", () => { void onSourceToggle(); });
  copy.addEventListener("click", () => { void onCopy(); });

  const visualViewport = window.visualViewport ?? undefined;
  const positionToolbar = (): void => {
    if (visualViewport === undefined) return;
    controls.style.setProperty("--keyboard-offset", `${Math.max(0, window.innerHeight - visualViewport.height - visualViewport.offsetTop)}px`);
  };
  visualViewport?.addEventListener("resize", positionToolbar);
  visualViewport?.addEventListener("scroll", positionToolbar);
  positionToolbar();

  let pressTimer: number | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") return;
    // The M3 long-press block menu (§8.3). It used to add a class the stylesheet turned into
    // a `display: flex`, which is a second way of deciding whether the menu is open — and
    // one that could not agree with `hidden`. There is one switch now, and it is this.
    pressTimer = window.setTimeout(() => slash.show(), 450);
  };
  const clearPress = (): void => {
    if (pressTimer !== undefined) window.clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  options.editor.view.dom.addEventListener("pointerdown", onPointerDown);
  options.editor.view.dom.addEventListener("pointerup", clearPress);
  options.editor.view.dom.addEventListener("pointercancel", clearPress);

  // §9.5's outline. Mounted here because this is where the editor's lifetime is already
  // owned: the bridge holds a scroll listener and two of its own, and every one of them has
  // to go when the note closes.
  const outline = mountOutline(options.editor);

  return {
    destroy: () => {
      options.editor.view.dom.removeEventListener("keydown", onKeyDown);
      options.editor.view.dom.removeEventListener("keyup", onKeyUp);
      options.editor.view.dom.removeEventListener(TASK_CHIP_EVENT, onChip);
      options.editor.view.dom.removeEventListener("pointerdown", onPointerDown);
      options.editor.view.dom.removeEventListener("pointerup", clearPress);
      options.editor.view.dom.removeEventListener("pointercancel", clearPress);
      options.editor.off("selectionUpdate", refreshControls);
      options.editor.off("update", refreshControls);
      options.editor.off("update", refreshLongNoteMode);
      visualViewport?.removeEventListener("resize", positionToolbar);
      visualViewport?.removeEventListener("scroll", positionToolbar);
      presence?.destroy();
      outline.destroy();
      clearPress();
      controls.remove();
      slash.destroy();
    },
  };
}

interface PresenceHandle { destroy(): void; }

/**
 * Renders the note header's presence row: who is here, and whether we can see anyone.
 *
 * `role="group"` rather than a bare `div`: an `aria-label` on a generic element is dropped
 * by screen readers, so the label was previously decorative only (§8.4).
 */
function mountPresence(panel: HTMLElement, awareness: Awareness, connection?: ConnectionStatus): PresenceHandle {
  const header = document.createElement("div");
  header.className = "presence-header";
  header.setAttribute("role", "group");
  header.setAttribute("aria-label", "People editing this note");
  const people = document.createElement("div");
  people.className = "presence-people";
  header.append(people);

  const status = document.createElement("span");
  status.className = "connection-status";
  status.setAttribute("role", "status");
  const unsubscribe = connection?.subscribe((connected) => {
    status.dataset["state"] = connected ? "online" : "offline";
    // §7.5: offline you are alone, and the UI says so rather than showing stale avatars.
    status.textContent = connected ? "" : "Offline — you are editing alone";
    status.hidden = connected;
  });
  if (connection !== undefined) header.append(status);

  const render = (): void => {
    people.replaceChildren();
    const present = [...awareness.getStates().entries()]
      .filter(([client]) => client !== awareness.clientID)
      .flatMap(([client, state]) => {
        const user = state["user"];
        return typeof user === "object" && user !== null && typeof user.name === "string" && typeof user.color === "string"
          ? [{ client, name: user.name, color: user.color }]
          : [];
      });
    header.hidden = present.length === 0 && connection === undefined;
    for (const user of present) {
      const avatar = document.createElement("span");
      avatar.className = "presence-avatar";
      avatar.setAttribute(PRESENCE_CLIENT_ATTRIBUTE, String(user.client));
      avatar.style.setProperty("--presence-color", user.color);
      avatar.title = user.name;
      avatar.setAttribute("aria-label", user.name);
      avatar.textContent = user.name.slice(0, 1).toUpperCase();
      people.append(avatar);
    }
  };
  awareness.on("change", render);
  render();
  panel.prepend(header);

  // Ages both the avatars here and the carets inside the editor, from one tick.
  const idle = trackPresenceIdle({ awareness, root: panel });

  return {
    destroy: () => {
      idle.destroy();
      unsubscribe?.();
      awareness.off("change", render);
      header.remove();
    },
  };
}

interface TaskInspector {
  readonly element: HTMLElement;
  /** Shows the row for the selected task's attributes, or hides it when none is selected. */
  sync(attrs: Readonly<Record<string, unknown>> | null): void;
  /** Focuses the control a clicked chip stands for (§10.2). */
  open(field: TaskChipField): void;
}

/**
 * The task metadata row: the keyboard route to everything the inline chips offer.
 *
 * It is hidden unless a task is selected. It also *reads* the selected task now — before,
 * the date input and the priority menu were permanently blank, so selecting a task due on
 * the 30th and opening the picker showed you an empty field and invited you to overwrite it.
 */
function taskInspector(editor: Editor): TaskInspector {
  const element = document.createElement("div");
  element.className = "task-inspector";
  element.hidden = true;
  element.setAttribute("aria-label", "Task metadata chips");
  const complete = button("Complete", "Toggle selected task completion");
  const due = document.createElement("input");
  due.type = "date";
  due.className = "task-chip";
  due.setAttribute("aria-label", "Task due date");
  const priority = document.createElement("select");
  priority.className = "task-chip";
  priority.setAttribute("aria-label", "Task priority");
  for (const [value, label] of [["", "Priority"], ["lowest", "Lowest"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["highest", "Highest"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    priority.append(option);
  }
  complete.addEventListener("click", () => toggleTask(editor));
  due.addEventListener("change", () => { setTaskDue(editor, due.value); });
  priority.addEventListener("change", () => { setTaskPriority(editor, priority.value === "" ? null : priority.value as TaskPriority); });
  element.append(complete, due, priority);

  return {
    element,
    sync: (attrs) => {
      element.hidden = attrs === null;
      if (attrs === null) return;
      complete.setAttribute("aria-pressed", attrs["status"] === "done" ? "true" : "false");
      // why: never write into a control the user is currently in. A date input is edited a
      // field at a time and each keystroke is a transaction, so re-seeding it from the
      // document mid-entry would fight whoever is typing in it.
      if (document.activeElement !== due) due.value = typeof attrs["due"] === "string" ? attrs["due"] : "";
      if (document.activeElement !== priority) priority.value = typeof attrs["priority"] === "string" ? attrs["priority"] : "";
    },
    open: (field) => {
      if (field === "priority") {
        priority.focus();
        return;
      }
      // Nothing to open for a chip this row does not edit — §10.4's preserved markers above
      // all, but also `created` and `done`, which are written by the app rather than chosen.
      // Focusing the wrong control would be worse than doing nothing.
      if (field !== "due") return;
      due.focus();
      if (typeof due.showPicker === "function") {
        // Not every engine exposes it, and some throw unless the call is inside a user
        // gesture. The field is focused either way, which is the part that must not fail.
        try {
          due.showPicker();
        } catch {
          // The picker is a convenience; the focused input is the feature.
        }
      }
    },
  };
}

/**
 * The `/` menu.
 *
 * Two different questions were being asked of the same text, and conflating them is half of
 * why this was always open. *Should the menu be visible* is answered by a `/` that starts a
 * word at the end of the block with nothing but the command typed after it — so a URL, or a
 * date written `9/3`, no longer opens it. *What did the user type* is answered permissively,
 * because `/due tomorrow` contains a space and is still one command.
 *
 * The other half was CSS: `.slash-menu` declared `display: flex`, and an author rule beats
 * the user agent's `[hidden] { display: none }` regardless of specificity. The JavaScript
 * here has always set `hidden` correctly and it has never had any effect.
 */
function slashMenu(editor: Editor, toolbar: HTMLElement) {
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Slash commands");
  const items = slashCommands.map((command) => {
    const item = button(command.label, command.description);
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => { command.run(editor); menu.hidden = true; });
    menu.append(item);
    return { command, item };
  });
  toolbar.after(menu);

  const blockText = (): string => editor.state.selection.$from.parent.textContent;
  const query = (): string | null => {
    const matched = /\/(.*)$/.exec(blockText());
    return matched === null ? null : matched[1] ?? "";
  };
  const prefix = (): string | null => {
    const matched = /(?:^|\s)\/([^\s]*)$/.exec(blockText());
    return matched === null ? null : (matched[1] ?? "").toLowerCase();
  };

  return {
    query,
    sync: (): void => {
      const typed = prefix();
      if (typed === null) {
        menu.hidden = true;
        return;
      }
      let matches = 0;
      for (const { command, item } of items) {
        const shown = command.label.toLowerCase().startsWith(typed);
        item.hidden = !shown;
        if (shown) matches += 1;
      }
      // No match is the same as no menu: an empty popover over the note is an obstruction.
      menu.hidden = matches === 0;
    },
    /** Opens the full menu with no `/` typed — the mobile long-press route (§8.3). */
    show: (): void => {
      for (const { item } of items) item.hidden = false;
      menu.hidden = false;
    },
    hide: () => { menu.hidden = true; },
    destroy: () => menu.remove(),
  };
}

function button(label: string, accessibleName: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "editor-control";
  element.textContent = label;
  element.setAttribute("aria-label", accessibleName);
  return element;
}
