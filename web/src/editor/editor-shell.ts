/** Accessible controls around the local Tiptap editor. */

import type { Editor } from "@tiptap/core";
import type { Doc } from "yjs";

import { insertBlock, moveCurrentBlock, runTaskSlashCommand, setHeading, setTaskDue, setTaskPriority, slashCommands, toggleTask } from "./commands.js";
import { applySourceMarkdown, copyMarkdown, editorMarkdown, longNoteMode, setLongNoteMode } from "./source.js";
import type { TaskPriority } from "./task-metadata.js";

export interface EditorShell {
  destroy(): void;
}

export interface MountEditorShellOptions {
  readonly editor: Editor;
  readonly document: Doc;
  readonly panel: HTMLElement;
  readonly status: HTMLElement;
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

  const taskControls = taskInspector(options.editor);
  controls.append(taskControls, source);
  options.panel.prepend(controls);

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
    pressTimer = window.setTimeout(() => toolbar.classList.add("is-block-tools-open"), 450);
  };
  const clearPress = (): void => {
    if (pressTimer !== undefined) window.clearTimeout(pressTimer);
    pressTimer = undefined;
  };
  options.editor.view.dom.addEventListener("pointerdown", onPointerDown);
  options.editor.view.dom.addEventListener("pointerup", clearPress);
  options.editor.view.dom.addEventListener("pointercancel", clearPress);

  return {
    destroy: () => {
      options.editor.view.dom.removeEventListener("keydown", onKeyDown);
      options.editor.view.dom.removeEventListener("keyup", onKeyUp);
      options.editor.view.dom.removeEventListener("pointerdown", onPointerDown);
      options.editor.view.dom.removeEventListener("pointerup", clearPress);
      options.editor.view.dom.removeEventListener("pointercancel", clearPress);
      options.editor.off("update", refreshLongNoteMode);
      visualViewport?.removeEventListener("resize", positionToolbar);
      visualViewport?.removeEventListener("scroll", positionToolbar);
      clearPress();
      controls.remove();
      slash.destroy();
    },
  };
}

function taskInspector(editor: Editor): HTMLElement {
  const inspector = document.createElement("div");
  inspector.className = "task-inspector";
  inspector.setAttribute("aria-label", "Task metadata chips");
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
  inspector.append(complete, due, priority);
  return inspector;
}

function slashMenu(editor: Editor, toolbar: HTMLElement) {
  const menu = document.createElement("div");
  menu.className = "slash-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Slash commands");
  for (const command of slashCommands) {
    const item = button(command.label, command.description);
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => { command.run(editor); menu.hidden = true; });
    menu.append(item);
  }
  toolbar.after(menu);
  const query = (): string | null => {
    const text = editor.state.selection.$from.parent.textContent;
    const matched = /\/(.*)$/.exec(text);
    return matched === null ? null : matched[1] ?? "";
  };
  return {
    query,
    sync: () => { menu.hidden = query() === null; },
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
