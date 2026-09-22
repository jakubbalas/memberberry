import type { Editor } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

/** The table and cell containing the current caret. */
export function selectedTable(editor: Editor) {
  const { $from, $to } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "table" || depth >= $from.depth) continue;
    const position = $from.before(depth);
    if ($to.pos >= position + node.nodeSize) return undefined;
    return { node, position, row: $from.index(depth), column: $from.index(depth + 1) };
  }
  return undefined;
}

/** Inserts a Markdown table with an editable header and two body rows. */
export function insertTable(editor: Editor): boolean {
  if (!editor.isEditable || selectedTable(editor) !== undefined) return false;
  const cell = { type: "table_cell" };
  const inserted = editor.commands.insertContent({
    type: "table", attrs: { alignments: ["none", "none"] },
    content: Array.from({ length: 3 }, () => ({ type: "table_row", content: [cell, cell] })),
  });
  if (inserted) {
    selectTableCell(editor, 0);
    // why: deferred focus can restore the header selection during a subsequent cell click.
    editor.view.focus();
  }
  return inserted;
}

function rowPosition(table: ProseMirrorNode, position: number, row: number): number {
  let offset = position + 1;
  for (let index = 0; index < row; index += 1) offset += table.child(index).nodeSize;
  return offset;
}

/** Selects a table cell without changing its content. */
export function selectTableCell(editor: Editor, row: number, column = 0): boolean {
  const table = selectedTable(editor);
  if (table === undefined || row < 0 || row >= table.node.childCount) return false;
  const cells = table.node.child(row);
  if (column < 0 || column >= cells.childCount) return false;
  let position = rowPosition(table.node, table.position, row) + 2;
  for (let index = 0; index < column; index += 1) position += cells.child(index).nodeSize;
  return editor.commands.setTextSelection(position);
}

/** Adds a body row beside the selected row, without displacing the header. */
export function addTableRow(editor: Editor, placement: "above" | "below" = "below"): boolean {
  const table = selectedTable(editor);
  if (!editor.isEditable || table === undefined || (placement === "above" && table.row === 0)) return false;
  const row = table.node.child(table.row);
  const cells: ProseMirrorNode[] = [];
  row.forEach((cell) => cells.push(cell.type.create()));
  const position = rowPosition(table.node, table.position, table.row + (placement === "below" ? 1 : 0));
  const transaction = editor.state.tr.insert(position, row.type.create(null, Fragment.fromArray(cells)));
  transaction.setSelection(TextSelection.create(transaction.doc, position + 2));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Deletes a body row, replacing the table with a paragraph when its last body row is removed. */
export function deleteTableRow(editor: Editor): boolean {
  const table = selectedTable(editor);
  if (!editor.isEditable || table === undefined || table.row === 0) return false;
  if (table.node.childCount === 2) {
    const paragraph = editor.schema.nodes["paragraph"];
    if (paragraph === undefined) return false;
    const transaction = editor.state.tr.replaceWith(table.position, table.position + table.node.nodeSize, paragraph.create());
    transaction.setSelection(TextSelection.create(transaction.doc, table.position + 1));
    editor.view.dispatch(transaction.scrollIntoView());
    return true;
  }
  const position = rowPosition(table.node, table.position, table.row);
  const transaction = editor.state.tr.delete(position, position + table.node.child(table.row).nodeSize);
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(position), -1));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Handles backward deletion at a cell boundary without joining Markdown table cells. */
export function backspaceInTable(editor: Editor): boolean {
  const { selection } = editor.state;
  if (!editor.isEditable || !selection.empty || selection.$from.parent.type.name !== "table_cell"
    || selection.$from.parentOffset !== 0) return false;
  const table = selectedTable(editor);
  if (table === undefined) return false;
  if (table.column > 0 && selection.$from.parent.content.size === 0) {
    const previousCellEnd = selection.from - 2;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, previousCellEnd)).scrollIntoView());
    return true;
  }
  if (table.row > 0 && table.column === 0) {
    let empty = true;
    table.node.child(table.row).forEach((cell) => { if (cell.content.size > 0) empty = false; });
    if (empty) deleteTableRow(editor);
  }
  return true;
}

/** Inserts a Markdown-preserved line break inside one table cell. */
export function newlineInTable(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  if (!editor.isEditable || $from.parent.type.name !== "table_cell" || !$from.sameParent($to)) return false;
  const hardBreak = editor.schema.nodes["hard_break"];
  if (hardBreak === undefined) return false;
  editor.view.dispatch(editor.state.tr.replaceSelectionWith(hardBreak.create(), false).scrollIntoView());
  return true;
}

/** Adds an empty column to every row, preserving Markdown column alignment. */
export function addTableColumn(editor: Editor): boolean {
  const table = selectedTable(editor);
  if (!editor.isEditable || table === undefined) return false;
  const transaction = editor.state.tr;
  for (let row = table.node.childCount - 1; row >= 0; row -= 1) {
    const cells = table.node.child(row);
    let position = rowPosition(table.node, table.position, row) + 1;
    for (let column = 0; column <= table.column; column += 1) position += cells.child(column).nodeSize;
    transaction.insert(position, cells.child(0).type.create());
  }
  const alignments = [...table.node.attrs["alignments"] as string[]];
  alignments.splice(table.column + 1, 0, "none");
  transaction.setNodeMarkup(table.position, undefined, { ...table.node.attrs, alignments });
  editor.view.dispatch(transaction);
  selectTableCell(editor, table.row, table.column + 1);
  return true;
}

/** Moves a body row to another body-row index; the Markdown header stays fixed. */
export function moveTableRow(editor: Editor, from: number, to: number): boolean {
  const table = selectedTable(editor);
  if (!editor.isEditable || table === undefined || !Number.isInteger(from) || !Number.isInteger(to)
    || from < 1 || to < 1 || from >= table.node.childCount || to >= table.node.childCount || from === to) return false;
  const row = table.node.child(from);
  const start = rowPosition(table.node, table.position, from);
  const destination = rowPosition(table.node, table.position, to + (from < to ? 1 : 0));
  const transaction = editor.state.tr.delete(start, start + row.nodeSize);
  const mapped = transaction.mapping.map(destination);
  transaction.insert(mapped, row);
  transaction.setSelection(TextSelection.create(transaction.doc, mapped + 2));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}
