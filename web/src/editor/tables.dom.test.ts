// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createMemberberryExtensions } from "./schema.js";
import { addTableColumn, addTableRow, backspaceInTable, deleteTableRow, insertTable, moveTableRow, newlineInTable, selectedTable, selectTableCell } from "./tables.js";
import { mountTableTools } from "./table-tools.js";
import { standaloneHtml } from "./export.js";
import { applySourceMarkdownWith } from "./source.js";
import { load, noteBridge, type NoteBridge } from "../notes.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const editors: Editor[] = [];
let bridge: NoteBridge;
beforeAll(async () => {
  await load(readFileSync("src/wasm/mb_bg.wasm"));
  bridge = await noteBridge();
});
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

function mounted(rows = ["Header", "Alpha", "Beta"]): Editor {
  const editor = new Editor({ element: document.createElement("div"), extensions: createMemberberryExtensions(contract) });
  document.body.append(editor.view.dom);
  editor.commands.setContent({ type: "doc", content: [{ type: "table", attrs: { alignments: ["left", "right"] }, content: rows.map((text) => ({
    type: "table_row", content: [{ type: "table_cell", content: [{ type: "text", text, marks: [{ type: "strong" }] }] }, { type: "table_cell" }],
  })) }] });
  editor.commands.setTextSelection(3);
  editors.push(editor);
  return editor;
}

describe("visual Markdown tables", () => {
  it("Backspace in an empty cell moves to the end of the cell to its left", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    const before = editor.getJSON();
    selectTableCell(editor, 1, 1);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    expect(selectedTable(editor)?.row).toBe(1);
    expect(selectedTable(editor)?.column).toBe(0);
    expect(editor.state.selection.$from.parentOffset).toBe(5);
    expect(editor.getJSON()).toEqual(before);
    tools.destroy();
  });
  it("clicking an empty cell places the caret in that cell", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    editor.view.dom.querySelectorAll("tr")[1]?.querySelectorAll("td")[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(selectedTable(editor)?.row).toBe(1);
    expect(selectedTable(editor)?.column).toBe(1);
    tools.destroy();
  });
  it("Backspace on the last empty body row removes the table and preserves surrounding text", () => {
    const editor = mounted();
    applySourceMarkdownWith(bridge, editor.view, "Before\n\n| Header |\n| --- |\n|  |\n\nAfter\n");
    editor.commands.setTextSelection(11);
    selectTableCell(editor, 1);
    expect(backspaceInTable(editor)).toBe(true);
    expect(editor.view.dom.querySelector("table")).toBeNull();
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
    editor.commands.insertContent("Continue");
    expect(editor.state.doc.textContent).toBe("BeforeContinueAfter");
  });
  it("Cmd+Enter and Ctrl+Enter insert a full row below the selected cell", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      selectTableCell(editor, 1, 1);
      const before = editor.state.doc.firstChild?.childCount ?? 0;
      const event = new KeyboardEvent("keydown", { key: "Enter", ...modifier, bubbles: true, cancelable: true });
      editor.view.dom.dispatchEvent(event);
      const table = editor.state.doc.firstChild;
      expect(event.defaultPrevented).toBe(true);
      expect(table?.childCount).toBe(before + 1);
      expect(selectedTable(editor)?.row).toBe(2);
      expect(table?.child(2).textContent).toBe("");
      table?.forEach((row) => expect(row.childCount).toBe(2));
    }
    tools.destroy();
  });
  it("mobile paragraph input adds repeated cell breaks and read-only input is inert", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    selectTableCell(editor, 0, 1);
    for (const inputType of ["insertParagraph", "insertLineBreak"]) {
      const input = new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true });
      editor.view.dom.dispatchEvent(input);
      expect(input.defaultPrevented).toBe(true);
    }
    expect(editor.state.doc.firstChild?.child(0).child(1).childCount).toBe(2);
    const before = editor.getJSON();
    editor.setEditable(false);
    expect(newlineInTable(editor)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    tools.destroy();
  });

  it("WASM preserves leading and repeated breaks within pipe-table cells", () => {
    const editor = mounted();
    applySourceMarkdownWith(bridge, editor.view, "| H |\n| --- |\n| <br>one<br><br>two<br> |\n");
    const row = editor.state.doc.firstChild?.child(1);
    expect(row?.firstChild?.childCount).toBe(6);
    expect(row?.firstChild?.firstChild?.type.name).toBe("hard_break");
    expect(row?.firstChild?.lastChild?.type.name).toBe("hard_break");
  });
  it("Enter in an empty cell inserts a line break without changing table dimensions", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    selectTableCell(editor, 1, 1);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    expect(table?.child(1).child(1).firstChild?.type.name).toBe("hard_break");
    table?.forEach((row) => expect(row.childCount).toBe(2));
    tools.destroy();
  });
  it("preserves headers and nonempty rows at cell boundaries", () => {
    const editor = mounted();
    const before = editor.getJSON();
    for (const [row, column] of [[0, 0], [1, 0], [1, 1]] as const) {
      selectTableCell(editor, row, column);
      expect(backspaceInTable(editor)).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    }
    selectTableCell(editor, 1);
    editor.commands.deleteRange({ from: editor.state.selection.from, to: editor.state.selection.from + 5 });
    selectTableCell(editor, 1, 1);
    editor.commands.insertContent("🍇");
    selectTableCell(editor, 1);
    const otherCellContent = editor.getJSON();
    expect(backspaceInTable(editor)).toBe(true);
    expect(editor.getJSON()).toEqual(otherCellContent);
  });

  it("leaves ordinary text deletion and read-only documents alone", () => {
    const editor = mounted();
    editor.commands.setTextSelection(4);
    expect(backspaceInTable(editor)).toBe(false);
    editor.commands.setTextSelection({ from: 3, to: 5 });
    expect(backspaceInTable(editor)).toBe(false);
    selectTableCell(editor, 1);
    addTableRow(editor);
    editor.setEditable(false);
    const before = editor.getJSON();
    expect(backspaceInTable(editor)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("handles mobile backward input and removes the handler on teardown", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    selectTableCell(editor, 1);
    addTableRow(editor);
    const input = new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(true);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
    tools.destroy();
    selectTableCell(editor, 1);
    addTableRow(editor);
    editor.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
    expect(editor.state.doc.firstChild?.childCount).toBe(4);
  });
  it("Backspace at the first cell deletes an empty body row without merging columns", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    selectTableCell(editor, 1);
    addTableRow(editor, "above");
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    const table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    table?.forEach((row) => expect(row.childCount).toBe(2));
    expect(table?.child(1).textContent).toBe("Alpha");
    tools.destroy();
  });
  it("inserts above a body row and deletes only the selected row", () => {
    const editor = mounted();
    selectTableCell(editor, 1);
    expect(addTableRow(editor, "above")).toBe(true);
    expect(editor.state.doc.firstChild?.child(2).textContent).toBe("Alpha");
    expect(deleteTableRow(editor)).toBe(true);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
    selectTableCell(editor, 2);
    expect(deleteTableRow(editor)).toBe(true);
    selectTableCell(editor, 1);
    expect(deleteTableRow(editor)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("protects the header and refuses row deletion or insertion above in read-only notes", () => {
    const editor = mounted();
    const before = editor.getJSON();
    expect(deleteTableRow(editor)).toBe(false);
    expect(addTableRow(editor, "above")).toBe(false);
    selectTableCell(editor, 1);
    editor.setEditable(false);
    expect(deleteTableRow(editor)).toBe(false);
    expect(addTableRow(editor, "above")).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("opens actions for the clicked row and releases the popup on changes and teardown", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    const open = (): void => { editor.view.dom.querySelector<HTMLButtonElement>(".table-row-handle")?.click(); };
    open();
    expect(document.querySelector(".table-row-menu")?.textContent).toBe("New row aboveNew row belowDelete row");
    document.querySelector<HTMLButtonElement>(".table-row-menu button")?.click();
    expect(editor.state.doc.firstChild?.child(2).textContent).toBe("Alpha");
    expect(document.querySelector(".table-row-menu")).toBeNull();
    open();
    editor.commands.insertContent("Changed");
    expect(document.querySelector(".table-row-menu")).toBeNull();
    open();
    tools.destroy();
    expect(document.querySelector(".table-row-menu")).toBeNull();
  });
  it("edits the header above the selected column, including newly added columns", () => {
    const editor = mounted();
    const parent = document.createElement("div");
    const tools = mountTableTools(editor, parent);
    selectTableCell(editor, 1, 1);
    addTableColumn(editor);
    const editHeader = Array.from(parent.querySelectorAll("button")).find((button) => button.textContent === "Edit header");
    for (let column = 0; column < 3; column += 1) {
      selectTableCell(editor, 1, column);
      editHeader?.click();
      expect(selectedTable(editor)?.row).toBe(0);
      expect(selectedTable(editor)?.column).toBe(column);
      editor.commands.insertContent(`Column ${column + 1}`);
      expect(editor.state.doc.firstChild?.child(0).child(column).textContent).toContain(`Column ${column + 1}`);
    }
    tools.destroy();
  });
  it("cancels a stale drag when the document changes before drop", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", { value: { setData: () => undefined, effectAllowed: "" } });
    editor.view.dom.querySelector(".table-row-handle")?.dispatchEvent(start);
    editor.commands.insertContent("Changed ");
    const beforeDrop = editor.getJSON();
    editor.view.dom.querySelectorAll("tr")[2]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(editor.getJSON()).toEqual(beforeDrop);
    tools.destroy();
  });

  it("refuses a drop into a different table", () => {
    const editor = mounted();
    const first = editor.state.doc.firstChild;
    if (first === null) throw new Error("fixture needs a table");
    editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, first));
    const tools = mountTableTools(editor, document.createElement("div"));
    const before = editor.getJSON();
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", { value: { setData: () => undefined, effectAllowed: "" } });
    editor.view.dom.querySelector(".table-row-handle")?.dispatchEvent(start);
    editor.view.dom.querySelectorAll("tr")[4]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(editor.getJSON()).toEqual(before);
    tools.destroy();
  });

  it("selects only valid cells and prevents nested table insertion", () => {
    const editor = mounted();
    const before = editor.getJSON();
    expect(selectTableCell(editor, -1)).toBe(false);
    expect(selectTableCell(editor, 3)).toBe(false);
    expect(selectTableCell(editor, 1, 2)).toBe(false);
    expect(insertTable(editor)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
  it("keeps a native mouse drag alive when the browser cancels its pointer stream", () => {
    const editor = mounted();
    const tools = mountTableTools(editor, document.createElement("div"));
    const handle = editor.view.dom.querySelector<HTMLButtonElement>(".table-row-handle");
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", { value: { setData: () => undefined, effectAllowed: "" } });
    handle?.dispatchEvent(start);
    window.dispatchEvent(new Event("pointercancel"));
    editor.view.dom.querySelectorAll("tr")[2]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(editor.state.doc.firstChild?.child(2).textContent).toBe("Alpha");
    tools.destroy();
  });
  it("inserts a rectangular header and two empty body rows", () => {
    const editor = mounted();
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    expect(insertTable(editor)).toBe(true);
    expect(editor.view.hasFocus()).toBe(true);
    const table = editor.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    table?.forEach((row) => expect(row.childCount).toBe(2));
    expect(selectedTable(editor)?.row).toBe(0);
  });

  it("adds rows below the caret and columns with alignment preserved", () => {
    const editor = mounted();
    selectTableCell(editor, 1);
    expect(addTableRow(editor)).toBe(true);
    expect(selectedTable(editor)?.row).toBe(2);
    expect(addTableColumn(editor)).toBe(true);
    const table = selectedTable(editor)?.node;
    expect(table?.attrs["alignments"]).toEqual(["left", "none", "right"]);
    expect(table?.childCount).toBe(4);
    table?.forEach((row) => expect(row.childCount).toBe(3));
    expect(table?.child(3).textContent).toBe("Beta");
  });

  it("preserves rich content, header and order under a move and its inverse", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 20 }), fc.nat(), fc.nat(), (count, source, target) => {
      const editor = mounted(Array.from({ length: count + 1 }, (_, index) => `Row ${index} — שלום 🍇`));
      const before = editor.getJSON();
      const from = source % count + 1;
      const to = target % count + 1;
      moveTableRow(editor, from, to);
      expect(editor.state.doc.firstChild?.child(to).textContent).toBe(`Row ${from} — שלום 🍇`);
      moveTableRow(editor, to, from);
      expect(editor.getJSON()).toEqual(before);
      editor.destroy();
      editors.pop();
    }), { seed: 20260922, numRuns: 40 });
  });

  it("refuses invalid moves and leaves the header unchanged", () => {
    const editor = mounted();
    const before = editor.getJSON();
    for (const [from, to] of [[0, 1], [1, 0], [-1, 2], [1, 3], [1.5, 2], [1, Number.NaN]] as const) expect(moveTableRow(editor, from, to)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("refuses mutations in read-only editors and outside tables", () => {
    const editor = mounted();
    editor.setEditable(false);
    const before = editor.getJSON();
    expect(addTableRow(editor)).toBe(false);
    expect(addTableColumn(editor)).toBe(false);
    expect(moveTableRow(editor, 1, 2)).toBe(false);
    expect(insertTable(editor)).toBe(false);
    expect(editor.getJSON()).toEqual(before);
    editor.setEditable(true);
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    expect(addTableRow(editor)).toBe(false);
    expect(addTableColumn(editor)).toBe(false);
    expect(moveTableRow(editor, 1, 2)).toBe(false);
  });

  it("keeps header-only imported Markdown editable", () => {
    const editor = mounted();
    applySourceMarkdownWith(bridge, editor.view, "| Header |\n| --- |\n");
    editor.commands.setTextSelection(3);
    expect(addTableRow(editor)).toBe(true);
    expect(addTableColumn(editor)).toBe(true);
    expect(selectedTable(editor)?.node.childCount).toBe(2);
  });

  it("shows contextual tools, disables header movement, and tears down decorations and listeners", async () => {
    const editor = mounted();
    const parent = document.createElement("div");
    const tools = mountTableTools(editor, parent);
    expect(parent.querySelector<HTMLElement>(".table-tools")?.hidden).toBe(false);
    const buttons = Array.from(parent.querySelectorAll("button"));
    expect(buttons.find((button) => button.textContent === "Row up")?.disabled).toBe(true);
    expect(editor.view.dom.querySelectorAll(".table-row-handle")).toHaveLength(2);
    expect(await standaloneHtml({ root: editor.view.dom, title: "Table" })).not.toContain("table-row-handle");
    selectTableCell(editor, 2);
    buttons.find((button) => button.textContent === "Row up")?.click();
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe("Beta");
    editor.setEditable(false);
    expect(parent.querySelector<HTMLElement>(".table-tools")?.hidden).toBe(true);
    tools.destroy();
    editor.setEditable(true);
    expect(parent.children).toHaveLength(0);
    expect(editor.view.dom.querySelectorAll(".table-row-handle")).toHaveLength(0);
  });
});
