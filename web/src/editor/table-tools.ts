import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { addTableColumn, addTableRow, backspaceInTable, deleteTableRow, moveTableRow, newlineInTable, selectedTable, selectTableCell } from "./tables.js";

/** Mounts contextual table tools and row handles; all listeners are released on teardown. */
export function mountTableTools(editor: Editor, parent: HTMLElement): { destroy(): void } {
  const element = document.createElement("div");
  element.className = "table-tools";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", "Table tools");
  const actions = [
    ["Edit header", () => selectTableCell(editor, 0, selectedTable(editor)?.column ?? 0)],
    ["Add row", () => addTableRow(editor)],
    ["Add column", () => addTableColumn(editor)],
    ["Row up", () => moveTableRow(editor, selectedTable(editor)?.row ?? 0, (selectedTable(editor)?.row ?? 0) - 1)],
    ["Row down", () => moveTableRow(editor, selectedTable(editor)?.row ?? 0, (selectedTable(editor)?.row ?? 0) + 1)],
  ] as const;
  const buttons = actions.map(([label, action]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-control";
    button.textContent = label;
    if (label === "Add row") {
      button.title = "Add row below (Cmd+Enter / Ctrl+Enter)";
      button.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
    }
    button.addEventListener("click", () => { action(); editor.view.focus(); });
    element.append(button);
    return button;
  });
  parent.append(element);
  let rowMenu: HTMLElement | undefined;
  let menuAnchor: HTMLButtonElement | undefined;
  let menuDocument: typeof editor.state.doc | undefined;
  let menuRow: number | undefined;
  let menuTable: number | undefined;
  const closeRowMenu = (): void => {
    menuAnchor?.setAttribute("aria-expanded", "false");
    rowMenu?.remove();
    rowMenu = undefined;
    menuAnchor = undefined;
  };
  const openRowMenu = (anchor: HTMLButtonElement, row: number): void => {
    closeRowMenu();
    if (!editor.isEditable || !selectTableCell(editor, row)) return;
    menuAnchor = anchor;
    menuDocument = editor.state.doc;
    menuRow = row;
    menuTable = selectedTable(editor)?.position;
    const menu = document.createElement("div");
    rowMenu = menu;
    menu.className = "table-row-menu";
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", `Actions for row ${row}`);
    for (const [label, action] of [
      ["New row above", () => addTableRow(editor, "above")],
      ["New row below", () => addTableRow(editor)],
      ["Delete row", () => deleteTableRow(editor)],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "editor-control";
      button.textContent = label;
      button.addEventListener("click", () => {
        const current = selectedTable(editor);
        if (editor.state.doc === menuDocument && current?.row === menuRow && current?.position === menuTable) action();
        closeRowMenu();
        editor.view.focus();
      });
      menu.append(button);
    }
    document.body.append(menu);
    anchor.setAttribute("aria-expanded", "true");
    const bounds = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(bounds.left, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(bounds.bottom, window.innerHeight - menu.offsetHeight))}px`;
    menu.querySelector("button")?.focus();
  };
  const onOutsidePointer = (event: PointerEvent): void => {
    if (event.target instanceof Node && !rowMenu?.contains(event.target) && !menuAnchor?.contains(event.target)) closeRowMenu();
  };
  const onMenuKey = (event: KeyboardEvent): void => {
    if (rowMenu === undefined) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const anchor = menuAnchor;
      closeRowMenu();
      anchor?.focus();
    }
  };
  let dragging: { row: number; table: number; document: typeof editor.state.doc } | undefined;
  let touchPointer: number | undefined;
  let dropTarget: Element | null = null;
  const key = new PluginKey("tableRowHandles");
  editor.registerPlugin(new Plugin({
    key,
    props: {
      decorations: () => {
        const table = selectedTable(editor);
        if (!editor.isEditable || table === undefined) return null;
        const decorations: Decoration[] = [];
        let position = table.position + 1;
        table.node.forEach((row, _offset, index) => {
          if (index > 0) decorations.push(Decoration.widget(position + 2, () => {
            const handle = document.createElement("button");
            handle.type = "button";
            handle.className = "table-row-handle";
            handle.textContent = "⠿";
            handle.draggable = true;
            handle.contentEditable = "false";
            handle.setAttribute("aria-label", `Move table row ${index}`);
            handle.title = "Row actions · drag to move";
            handle.setAttribute("aria-haspopup", "dialog");
            handle.setAttribute("aria-expanded", "false");
            handle.addEventListener("click", () => { openRowMenu(handle, index); });
            handle.addEventListener("pointerdown", (event) => {
              if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
              event.preventDefault();
              event.stopPropagation();
              closeRowMenu();
              selectTableCell(editor, index);
              touchPointer = event.pointerId;
              dragging = { row: index, table: table.position, document: editor.state.doc };
            });
            handle.addEventListener("dragstart", (event) => {
              event.stopPropagation();
              closeRowMenu();
              selectTableCell(editor, index);
              dragging = { row: index, table: table.position, document: editor.state.doc };
              event.dataTransfer?.setData("text/plain", "");
              if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = "move";
            });
            return handle;
          }, { key: `${table.position}:${index}`, side: -1, stopEvent: () => true }));
          position += row.nodeSize;
        });
        return DecorationSet.create(editor.state.doc, decorations);
      },
    },
  }));
  const targetRow = (element: EventTarget | null): number | undefined => {
    dropTarget?.classList.remove("table-drop-target");
    dropTarget = null;
    if (dragging === undefined || dragging.document !== editor.state.doc
      || selectedTable(editor)?.position !== dragging.table) return undefined;
    const target = element instanceof Element ? element.closest("tr") : null;
    if (target === null || !editor.view.dom.contains(target)) return undefined;
    const resolved = editor.state.doc.resolve(editor.view.posAtDOM(target, 0));
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      if (resolved.node(depth).type.name === "table" && resolved.before(depth) === dragging.table) {
        const row = resolved.index(depth);
        if (row > 0) {
          // why: decorations are outside document parsing; mutating a row can trigger a reparse during drag.
          dropTarget = target.querySelector(".table-row-handle");
          dropTarget?.classList.add("table-drop-target");
        }
        return row;
      }
    }
    return undefined;
  };
  const onDragOver = (event: DragEvent): void => {
    const row = targetRow(event.target);
    if (row !== undefined && row > 0) { event.preventDefault(); if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move"; }
  };
  const onDrop = (event: DragEvent): void => {
    if (dragging === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const row = targetRow(event.target);
    if (row !== undefined) moveTableRow(editor, dragging.row, row);
    onDragEnd();
  };
  const onDragEnd = (): void => {
    dragging = undefined;
    touchPointer = undefined;
    dropTarget?.classList.remove("table-drop-target");
    dropTarget = null;
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (touchPointer !== event.pointerId) return;
    event.preventDefault();
    targetRow(document.elementFromPoint(event.clientX, event.clientY));
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (touchPointer !== event.pointerId || dragging === undefined) return;
    const row = targetRow(document.elementFromPoint(event.clientX, event.clientY));
    if (row === dragging.row) {
      const anchor = dropTarget;
      if (anchor instanceof HTMLButtonElement) openRowMenu(anchor, row);
    } else if (row !== undefined) moveTableRow(editor, dragging.row, row);
    onDragEnd();
  };
  const onPointerCancel = (event: PointerEvent): void => {
    // why: native mouse dragging cancels its pointer stream before dragover/drop.
    if (touchPointer !== undefined && event.pointerId === touchPointer) onDragEnd();
  };
  const refresh = (): void => {
    const table = selectedTable(editor);
    if (!editor.isEditable || editor.state.doc !== menuDocument || table?.position !== menuTable || table?.row !== menuRow) closeRowMenu();
    element.hidden = table === undefined || !editor.isEditable;
    buttons.forEach((button, index) => {
      button.disabled = table === undefined || !editor.isEditable
        || (index === 3 && table.row <= 1)
        || (index === 4 && (table.row === 0 || table.row === table.node.childCount - 1));
    });
  };
  editor.on("transaction", refresh);
  editor.on("update", refresh);
  const onEmptyCellClick = (event: MouseEvent): void => {
    if (!editor.isEditable || !(event.target instanceof Element) || event.target.closest("button") !== null) return;
    const cell = event.target.closest("td");
    if (cell === null || !editor.view.dom.contains(cell)) return;
    const position = editor.view.posAtDOM(cell, 0);
    const node = editor.state.doc.resolve(position).parent;
    if (node.type.name !== "table_cell" || node.content.size !== 0) return;
    editor.commands.setTextSelection(position);
    editor.view.focus();
  };
  editor.view.dom.addEventListener("click", onEmptyCellClick);
  const onTableKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      const handled = event.metaKey || event.ctrlKey ? addTableRow(editor) : newlineInTable(editor);
      if (handled) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (event.key !== "Backspace") return;
    if (backspaceInTable(editor)) { event.preventDefault(); event.stopPropagation(); }
  };
  const onBeforeInput = (event: InputEvent): void => {
    if (event.isComposing || !event.cancelable) return;
    if ((event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") && newlineInTable(editor)) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.inputType !== "deleteContentBackward") return;
    if (backspaceInTable(editor)) { event.preventDefault(); event.stopPropagation(); }
  };
  // why: run before ProseMirror's generic join-backward command or native mobile deletion.
  editor.view.dom.addEventListener("keydown", onTableKeyDown, true);
  editor.view.dom.addEventListener("beforeinput", onBeforeInput, true);
  window.addEventListener("pointerdown", onOutsidePointer);
  window.addEventListener("keydown", onMenuKey);
  window.addEventListener("resize", closeRowMenu);
  window.addEventListener("scroll", closeRowMenu, true);
  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  editor.view.dom.addEventListener("dragover", onDragOver, true);
  editor.view.dom.addEventListener("drop", onDrop, true);
  editor.view.dom.addEventListener("dragend", onDragEnd);
  refresh();
  return { destroy: () => {
    editor.off("transaction", refresh);
    editor.off("update", refresh);
    editor.view.dom.removeEventListener("click", onEmptyCellClick);
    editor.view.dom.removeEventListener("keydown", onTableKeyDown, true);
    editor.view.dom.removeEventListener("beforeinput", onBeforeInput, true);
    window.removeEventListener("pointerdown", onOutsidePointer);
    window.removeEventListener("keydown", onMenuKey);
    window.removeEventListener("resize", closeRowMenu);
    window.removeEventListener("scroll", closeRowMenu, true);
    closeRowMenu();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    onDragEnd();
    editor.view.dom.removeEventListener("dragover", onDragOver, true);
    editor.view.dom.removeEventListener("drop", onDrop, true);
    editor.view.dom.removeEventListener("dragend", onDragEnd);
    editor.unregisterPlugin(key);
    element.remove();
  } };
}
