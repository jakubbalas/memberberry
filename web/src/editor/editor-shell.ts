/** Accessible controls around the local Tiptap editor. */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "y-prosemirror";
import type { Doc } from "yjs";
import type { Awareness } from "y-protocols/awareness";

import type { ConnectionStatus } from "./collaboration.js";
import type { ConnectionState } from "./sync.js";
import { PRESENCE_CLIENT_ATTRIBUTE, trackPresenceIdle } from "./presence.js";

import { insertBlock, moveCurrentBlock, runTaskSlashCommand, setHeading, setTaskDue, setTaskPriority, slashCommands, toggleTask } from "./commands.js";
import { CONFLICT_EVENT, mountConflicts, type ConflictDetail } from "./conflict-view.js";
import { mountOutline } from "./outline.js";
import { applySourceMarkdown, copyMarkdown, editorMarkdown, longNoteMode, setLongNoteMode } from "./source.js";
import { TASK_CHIP_EVENT, type TaskChipEventDetail } from "./task-view.js";
import type { TaskChipField, TaskPriority } from "./task-metadata.js";
import { expandTemplate } from "../notes.js";
import { openTemplatePalette, TEMPLATE_EVENT, templateContext, type TemplateEventDetail } from "../shell/templates.js";
import type { MediaUploader } from "./media-upload.js";
import { mountEmojiPicker, type EmojiChoice, type EmojiImportOptions } from "./emoji-picker.js";
import { downloadHtml, printPanel, standaloneHtml } from "./export.js";

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
  readonly user?: string;
  readonly title?: string;
  readonly onTitleChange?: (title: string) => string | undefined;
  readonly mediaUploader?: MediaUploader;
  readonly emojiChoices?: readonly EmojiChoice[];
  readonly emojiImport?: EmojiImportOptions;
}

let focusedEditor: Editor | undefined;

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
  const more = document.createElement("details");
  more.className = "editor-more";
  const summary = document.createElement("summary");
  summary.textContent = "More";
  summary.setAttribute("aria-label", "More editing tools");
  const secondary = document.createElement("div");
  secondary.className = "editor-secondary";
  more.append(summary, secondary);

  const source = document.createElement("textarea");
  source.className = "source-view";
  source.hidden = true;
  source.setAttribute("aria-label", "Markdown source");
  const sourceToggle = button("Source", "Toggle Markdown source view");
  const copy = button("Copy Markdown", "Copy canonical Markdown");
  const print = button("Print PDF", "Print note or save it as PDF");
  const html = button("Export HTML", "Export note as self-contained HTML");
  let sourceVisible = false;
  let latestMarkdown = "";
  let committedTitle = options.editor.state.doc.firstChild?.textContent.trim() ?? "";

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
    if (["Text", "H1", "List", "Task"].includes(label)) toolbar.append(control);
    else secondary.append(control);
  }
  toolbar.append(sourceToggle);
  secondary.append(copy, print, html);
  const media = mediaControls(options.editor, options.mediaUploader, options.status);
  if (media !== undefined) toolbar.append(media.element);
  const emoji = mountEmojiPicker(options.editor, toolbar, options.emojiChoices ?? [], options.emojiImport);
  toolbar.append(more);

  const inspector = taskInspector(options.editor);
  controls.append(inspector.element, source);
  options.panel.prepend(controls);
  const presence = options.awareness === undefined
    ? undefined
    : mountPresence(options.panel, options.awareness, options.connection);

  const slash = slashMenu(options.editor, toolbar);
  const onTemplate = (event: Event): void => {
    if (focusedEditor !== options.editor) return;
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (typeof detail !== "object" || detail === null || !("body" in detail) || typeof (detail as TemplateEventDetail).body !== "string") return;
    const selection = options.editor.state.doc.textBetween(
      options.editor.state.selection.from,
      options.editor.state.selection.to,
      "\n",
    );
    void expandTemplate((detail as TemplateEventDetail).body, templateContext(options.title ?? "", options.user ?? "", selection))
      .then((expanded) => {
        const from = options.editor.state.selection.from;
        const cursor = expanded.cursor === null ? expanded.text.length : expanded.cursor;
        const offset = expanded.text.slice(0, cursor).length;
        options.editor.chain().focus().insertContent(expanded.text).setTextSelection(from + offset).run();
      });
  };
  window.addEventListener(TEMPLATE_EVENT, onTemplate);
  const rememberFocus = (): void => { focusedEditor = options.editor; };
  options.editor.view.dom.addEventListener("focusin", rememberFocus);
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
  const commitTitle = (): void => {
    const first = options.editor.state.doc.firstChild;
    if (first?.type.name !== "heading" || first.attrs["level"] !== 1) return;
    let title = first.textContent.trim();
    if (title === "") {
      const fallback = options.onTitleChange?.("") ?? "untitled";
      const heading = options.editor.state.doc.firstChild;
      if (heading === null || fallback.trim() === "") return;
      if (!options.editor.commands.insertContentAt({ from: 1, to: heading.nodeSize - 1 }, fallback)) return;
      title = fallback.trim();
    }
    if (title === committedTitle) return;
    committedTitle = title;
    options.onTitleChange?.(title);
  };
  const onSelectionUpdate = (): void => {
    refreshControls();
    if (options.editor.state.selection.$from.parent !== options.editor.state.doc.firstChild) commitTitle();
  };
  const onBlur = (): void => commitTitle();
  const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
    const sync = transaction.getMeta(ySyncPluginKey) as { readonly isChangeOrigin?: boolean } | undefined;
    if (sync?.isChangeOrigin === true) {
      committedTitle = options.editor.state.doc.firstChild?.textContent.trim() ?? "";
    }
  };
  options.editor.on("transaction", onTransaction);
  options.editor.on("selectionUpdate", onSelectionUpdate);
  options.editor.on("update", refreshControls);
  options.editor.view.dom.addEventListener("blur", onBlur);
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
  let printCleanup: (() => void) | undefined;
  const onPrint = (): void => {
    printCleanup?.();
    printCleanup = printPanel(options.panel);
  };
  const onHtml = async (): Promise<void> => {
    try {
      const exported = await standaloneHtml({
        root: options.editor.view.dom,
        title: options.title ?? "note",
      });
      downloadHtml(exported, options.title ?? "note");
      options.status.textContent = "Self-contained HTML exported.";
    } catch (error: unknown) {
      options.status.textContent = error instanceof Error ? error.message : "HTML export failed.";
    }
  };
  const onHtmlClick = (): void => { void onHtml(); };
  print.addEventListener("click", onPrint);
  html.addEventListener("click", onHtmlClick);

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

  // §3.5's count. The listener is attached before the announcer is mounted, because
  // `mountConflicts` announces the note's current count immediately — a note opened with a
  // conflict already in it must say so without waiting for the first keystroke.
  const conflicts = document.createElement("p");
  conflicts.className = "conflict-count";
  conflicts.setAttribute("role", "status");
  conflicts.hidden = true;
  controls.prepend(conflicts);
  const onConflicts = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as ConflictDetail;
    conflicts.textContent = conflictMessage(detail.count) ?? "";
    conflicts.hidden = detail.count === 0;
  };
  options.editor.view.dom.addEventListener(CONFLICT_EVENT, onConflicts);
  const conflictCount = mountConflicts(options.editor);

  return {
    destroy: () => {
      options.editor.view.dom.removeEventListener("keydown", onKeyDown);
      options.editor.view.dom.removeEventListener("keyup", onKeyUp);
      options.editor.view.dom.removeEventListener(TASK_CHIP_EVENT, onChip);
      options.editor.view.dom.removeEventListener("pointerdown", onPointerDown);
      options.editor.view.dom.removeEventListener("pointerup", clearPress);
      options.editor.view.dom.removeEventListener("pointercancel", clearPress);
      options.editor.off("selectionUpdate", onSelectionUpdate);
      options.editor.off("transaction", onTransaction);
      options.editor.off("update", refreshControls);
      options.editor.view.dom.removeEventListener("blur", onBlur);
      options.editor.off("update", refreshLongNoteMode);
      print.removeEventListener("click", onPrint);
      html.removeEventListener("click", onHtmlClick);
      printCleanup?.();
      visualViewport?.removeEventListener("resize", positionToolbar);
      visualViewport?.removeEventListener("scroll", positionToolbar);
      presence?.destroy();
      outline.destroy();
      conflictCount.destroy();
      options.editor.view.dom.removeEventListener(CONFLICT_EVENT, onConflicts);
      conflicts.remove();
      clearPress();
      controls.remove();
      media?.destroy();
      emoji.destroy();
      slash.destroy();
      window.removeEventListener(TEMPLATE_EVENT, onTemplate);
      options.editor.view.dom.removeEventListener("focusin", rememberFocus);
      if (focusedEditor === options.editor) focusedEditor = undefined;
    },
  };
}

interface MediaControls {
  readonly element: HTMLElement;
  destroy(): void;
}

function mediaControls(
  editor: Editor,
  uploader: MediaUploader | undefined,
  status: HTMLElement,
): MediaControls | undefined {
  if (uploader === undefined) return undefined;
  let destroyed = false;
  const buttonElement = button("Media", "Insert image or PDF");
  const container = document.createElement("span");
  container.className = "media-controls";
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/gif,image/webp,application/pdf";
  picker.multiple = false;
  picker.hidden = true;
  picker.setAttribute("aria-hidden", "true");
  const replacePath = (from: string, to: string): void => {
    const transaction = editor.state.tr;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "image" && node.attrs["dest"] === from) {
        transaction.setNodeMarkup(position, undefined, { ...node.attrs, dest: to });
      }
      if (!node.isText) return;
      for (const mark of node.marks) {
        if (mark.type.name !== "link" || mark.attrs["href"] !== from) continue;
        transaction.removeMark(position, position + node.nodeSize, mark.type);
        transaction.addMark(
          position,
          position + node.nodeSize,
          mark.type.create({ ...mark.attrs, href: to }),
        );
      }
    });
    if (transaction.docChanged) editor.view.dispatch(transaction);
  };
  const stopResolved = uploader.onResolved?.(replacePath);
  const upload = (file: File): void => {
    const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
    status.textContent = "Uploading " + file.name + "…";
    void uploader
      .upload(file)
      .then((result) => {
        if (destroyed) return;
        const content = file.type === "application/pdf"
          ? {
              type: "text",
              text: file.name,
              marks: [{ type: "link", attrs: { href: result.path, title: null } }],
            }
          : { type: "image", attrs: { dest: result.path, alt: file.name } };
        editor.chain().focus().insertContentAt(selection, content).run();
        status.textContent = file.type === "application/pdf" ? "PDF inserted." : "Image inserted.";
        if (result.pending !== undefined) {
          status.textContent = "Image queued for upload.";
          void result.pending
            .then((uploaded) => {
              if (destroyed) return;
              replacePath(result.path, uploaded.path);
              status.textContent = "Queued image uploaded.";
            })
            .catch(() => {
              if (!destroyed) status.textContent = "Queued image upload failed.";
            });
        }
      })
      .catch(() => {
        status.textContent = "Image upload failed.";
      });
  };
  const mediaFrom = (files: FileList | readonly File[] | null): File | undefined =>
    files === null ? undefined : [...files].find(isSafeMedia);
  const onChange = (): void => {
    const file = mediaFrom(picker.files);
    if (file !== undefined) upload(file);
    picker.value = "";
  };
  const onPaste = (event: ClipboardEvent): void => {
    const file = mediaFrom(event.clipboardData?.files ?? null);
    if (file === undefined) return;
    event.preventDefault();
    upload(file);
  };
  const onDrop = (event: DragEvent): void => {
    if ((event.dataTransfer?.files.length ?? 0) > 0) event.preventDefault();
    const file = mediaFrom(event.dataTransfer?.files ?? null);
    if (file === undefined) return;
    upload(file);
  };
  const onDragOver = (event: DragEvent): void => {
    if ((event.dataTransfer?.files.length ?? 0) > 0) event.preventDefault();
  };
  picker.addEventListener("change", onChange);
  buttonElement.addEventListener("click", () => picker.click());
  editor.view.dom.addEventListener("paste", onPaste);
  editor.view.dom.addEventListener("drop", onDrop);
  editor.view.dom.addEventListener("dragover", onDragOver);
  container.append(buttonElement, picker);
  return {
    element: container,
    destroy: () => {
      destroyed = true;
      picker.removeEventListener("change", onChange);
      editor.view.dom.removeEventListener("paste", onPaste);
      editor.view.dom.removeEventListener("drop", onDrop);
      editor.view.dom.removeEventListener("dragover", onDragOver);
      picker.remove();
      stopResolved?.();
      uploader.destroy();
    },
  };
}

const SAFE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

const SAFE_MEDIA_EXTENSIONS = new Set([
  "gif",
  "jpeg",
  "jpg",
  "pdf",
  "png",
  "webp",
]);

function isSafeMedia(file: File): boolean {
  if (SAFE_MEDIA_TYPES.has(file.type)) return true;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension !== undefined && SAFE_MEDIA_EXTENSIONS.has(extension);
}

interface PresenceHandle { destroy(): void; }

/**
 * What the note header says about the connection, or `undefined` for "nothing worth saying".
 *
 * Two promises meet here. §7.5: offline you are alone, and the UI says so rather than
 * showing stale avatars. §7.4: an offline application says how much is waiting to be sent —
 * silence and "everything is fine" must not look the same, because the difference between
 * them is whether the work is anywhere but this device.
 *
 * Connected with nothing pending is the only state that says nothing at all. Connected *with*
 * something pending is the moment between a socket opening and the flush going out; it is
 * usually too short to read, and leaving it unlabelled would mean the count vanishing before
 * anything reported it.
 */
/**
 * What the note says about its unresolved conflicts, or `undefined` for none (§3.5).
 *
 * `undefined` rather than "0 conflicts": a line of furniture on every note nobody has a
 * conflict in is a line readers stop seeing, which is the opposite of what §3.5 wants from
 * the one note where it matters.
 */
export function conflictMessage(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1
    ? "1 unresolved conflict — choose a version below"
    : `${count} unresolved conflicts — choose a version for each`;
}

export function connectionMessage(state: ConnectionState): string | undefined {
  const changes = `${state.pending} unsent ${state.pending === 1 ? "change" : "changes"}`;
  if (!state.connected) {
    return state.pending === 0
      ? "Offline — you are editing alone"
      : `Offline — ${changes}, saved on this device`;
  }
  return state.pending === 0 ? undefined : `Reconnected — sending ${changes}`;
}

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
  const unsubscribe = connection?.subscribe((state) => {
    status.dataset["state"] = state.connected ? "online" : "offline";
    const message = connectionMessage(state);
    status.textContent = message ?? "";
    status.hidden = message === undefined;
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
  const template = button("Template", "Insert a template");
  template.setAttribute("role", "menuitem");
  template.addEventListener("click", openTemplatePalette);
  menu.append(template);
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
      template.hidden = !"template".startsWith(typed);
      if (!template.hidden) matches += 1;
      // No match is the same as no menu: an empty popover over the note is an obstruction.
      menu.hidden = matches === 0;
    },
    /** Opens the full menu with no `/` typed — the mobile long-press route (§8.3). */
    show: (): void => {
      for (const { item } of items) item.hidden = false;
      template.hidden = false;
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
