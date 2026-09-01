/** Generated-schema-safe editor commands and Markdown input rules. */

import { Extension, InputRule, textblockTypeInputRule, wrappingInputRule, type Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { parseNaturalDate, todayDate, type TaskPriority } from "./task-metadata.js";

export type BlockKind = "paragraph" | "heading" | "bullet_list" | "ordered_list" | "task_item" | "blockquote" | "callout" | "code_block" | "divider" | "table";

export interface SlashCommand {
  readonly label: string;
  readonly description: string;
  readonly run: (editor: Editor) => boolean;
}

/** Input rules required by M3. Their node names are pinned by `schema.json`. */
export const memberberryInputRules = Extension.create({
  name: "memberberryInputRules",
  addInputRules() {
    const { heading, bullet_list, blockquote } = this.editor.schema.nodes;
    if (heading === undefined || bullet_list === undefined || blockquote === undefined) return [];
    return [
      textblockTypeInputRule({ find: /^(#{1,6})\s$/, type: heading, getAttributes: (match) => ({ level: match[1]?.length ?? 1 }) }),
      wrappingInputRule({ find: /^-\s$/, type: bullet_list }),
      wrappingInputRule({ find: /^>\s$/, type: blockquote }),
      codeFenceRule(),
      taskRule(),
    ];
  },
});

/** Inserts a generated block at the current selection. */
export function insertBlock(editor: Editor, kind: BlockKind): boolean {
  const content = blockContent(kind);
  return editor.chain().focus().insertContent(content).run();
}

/** Changes the current text block into a heading of the requested level. */
export function setHeading(editor: Editor, level: number): boolean {
  return editor.chain().focus().setNode("heading", { level }).run();
}

/** Updates the selected task's priority. `null` removes the metadata. */
export function setTaskPriority(editor: Editor, priority: TaskPriority | null): boolean {
  return editor.chain().focus().updateAttributes("task_item", { priority }).run();
}

/** Updates the selected task's due date from a canonical or supported natural-language date. */
export function setTaskDue(editor: Editor, input: string, now?: Date): boolean {
  const parsed = input.length === 0 ? null : parseNaturalDate(input, now);
  if (input.length > 0 && parsed === null) return false;
  return editor.chain().focus().updateAttributes("task_item", { due: parsed?.value ?? null }).run();
}

/** Toggles task completion and writes today's completion date as required by SPEC.md §10.2. */
export function toggleTask(editor: Editor, now?: Date): boolean {
  const attrs = editor.getAttributes("task_item");
  const done = attrs["status"] === "done";
  return editor.chain().focus().updateAttributes("task_item", {
    status: done ? "todo" : "done",
    done: done ? null : todayDate(now),
  }).run();
}

/** Moves the selected top-level block one position, preserving its generated node shape. */
export function moveCurrentBlock(editor: Editor, direction: "up" | "down"): boolean {
  const { $from } = editor.state.selection;
  const index = $from.index(0);
  const current = editor.state.doc.child(index);
  const siblingIndex = direction === "up" ? index - 1 : index + 1;
  if (siblingIndex < 0 || siblingIndex >= editor.state.doc.childCount) return false;
  const sibling = editor.state.doc.child(siblingIndex);
  let start = 0;
  for (let position = 0; position < Math.min(index, siblingIndex); position += 1) {
    start += editor.state.doc.child(position).nodeSize;
  }
  const end = start + current.nodeSize + sibling.nodeSize;
  const content = direction === "up" ? [current, sibling] : [sibling, current];
  const transaction = editor.state.tr.replaceWith(start, end, Fragment.fromArray(content));
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Commands exposed by the slash menu. */
export const slashCommands: readonly SlashCommand[] = [
  { label: "Heading 1", description: "Large section heading", run: (editor) => setHeading(editor, 1) },
  { label: "Bullet list", description: "Unordered list", run: (editor) => insertBlock(editor, "bullet_list") },
  { label: "Numbered list", description: "Ordered list", run: (editor) => insertBlock(editor, "ordered_list") },
  { label: "Task", description: "Checkbox with metadata", run: (editor) => insertBlock(editor, "task_item") },
  { label: "Quote", description: "Block quote", run: (editor) => insertBlock(editor, "blockquote") },
  { label: "Callout", description: "Highlighted note block", run: (editor) => insertBlock(editor, "callout") },
  { label: "Code block", description: "Fenced code", run: (editor) => insertBlock(editor, "code_block") },
  { label: "Divider", description: "Horizontal divider", run: (editor) => insertBlock(editor, "divider") },
  { label: "Table", description: "Two-column table", run: (editor) => insertBlock(editor, "table") },
];

/** Applies `/due tomorrow` and `/priority high` directly to the selected task. */
export function runTaskSlashCommand(editor: Editor, query: string, now?: Date): boolean | null {
  const due = /^due\s+(.+)$/i.exec(query);
  if (due?.[1] !== undefined) return setTaskDue(editor, due[1], now);
  const priority = /^priority\s+(lowest|low|medium|high|highest)$/i.exec(query);
  if (priority?.[1] !== undefined) return setTaskPriority(editor, priority[1].toLowerCase() as TaskPriority);
  return null;
}

function blockContent(kind: BlockKind) {
  switch (kind) {
    case "paragraph": return { type: "paragraph" };
    case "heading": return { type: "heading", attrs: { level: 1 } };
    case "bullet_list": return { type: "bullet_list", content: [{ type: "list_item", content: [{ type: "paragraph" }] }] };
    case "ordered_list": return { type: "ordered_list", attrs: { start: 1 }, content: [{ type: "list_item", content: [{ type: "paragraph" }] }] };
    case "task_item": return { type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] }, content: [{ type: "paragraph" }] }] };
    case "blockquote": return { type: "blockquote", content: [{ type: "paragraph" }] };
    case "callout": return { type: "callout", attrs: { kind: "note", fold: "none" }, content: [{ type: "callout_title" }, { type: "paragraph" }] };
    case "code_block": return { type: "code_block" };
    case "divider": return { type: "divider" };
    case "table": return { type: "table", attrs: { alignments: ["none", "none"] }, content: [{ type: "table_row", content: [{ type: "table_cell" }, { type: "table_cell" }] }] };
  }
}

function codeFenceRule(): InputRule {
  return new InputRule({
    find: /^```\s$/,
    handler: ({ commands }) => { commands.setNode("code_block"); },
  });
}

function taskRule(): InputRule {
  return new InputRule({
    find: /^- \[ \] $/,
    handler: ({ state, range, commands }) => {
      const paragraph = state.selection.$from.parent;
      const list = state.schema.nodes["bullet_list"];
      const task = state.schema.nodes["task_item"];
      if (list === undefined || task === undefined || !paragraph.isTextblock) return;
      const item = task.create({ status: "todo", unknown: [] }, paragraph.type.create());
      const replacement = list.create(null, item);
      commands.command(({ tr, dispatch }) => {
        const from = state.selection.$from.before(state.selection.$from.depth);
        if (dispatch !== undefined) dispatch(tr.replaceWith(from, range.to, replacement));
        return true;
      });
    },
  });
}
