/**
 * The inline rendering of a task: a checkbox and its metadata chips (`SPEC.md` §10.2).
 *
 * Until this existed a task rendered as a plain bullet. Nothing was lost — the attributes
 * round-tripped to disk correctly and `data-task-status` was on the `li` — but there was no
 * checkbox to tick and no due date to read, which is the one thing `PROJECT.md` asks for by
 * name. It was a missing view, and this is the view.
 *
 * A ProseMirror node view rather than a `renderHTML` rule, for two reasons. `renderHTML`
 * produces static DOM, so a checkbox drawn there could show state but never accept a click.
 * And keeping it out of `schema.ts` keeps that module what it claims to be: a generator over
 * the Rust-owned contract, with no special case for one node in it. The contract governs the
 * *document*; how a task looks is not part of it, and a paste target or a test that mounts
 * the bare extensions still gets the plain `li` from `renderHTML`.
 *
 * The checkbox is deliberately **not** in the tab order, and that is not a mouse-only
 * feature. `Tab` inside a document is the editor's key, and a note with a hundred tasks
 * would otherwise be a hundred tab stops between the text and anything after it. The
 * keyboard route to the same change is the toolbar's task inspector, which appears when a
 * task is selected — the §8.2 rule that a pointer gesture and its keyboard equivalent are
 * two features and two tests, applied here.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";

import { isTaskComplete, taskChips, toggledTaskAttributes, type TaskChipField } from "./task-metadata.js";

/**
 * Fired at the editor's DOM when a chip is clicked, so the toolbar can open the right
 * control for it (§10.2: "click a chip for a date picker or priority menu").
 *
 * An event rather than a direct call: the node view lives inside ProseMirror and the
 * inspector lives in the shell, and coupling them would mean the editor could not be mounted
 * without the toolbar. The shell listens; nothing breaks when nothing does.
 */
export const TASK_CHIP_EVENT = "memberberry:task-chip";

/** The `detail` of a {@link TASK_CHIP_EVENT}. */
export interface TaskChipEventDetail {
  readonly field: TaskChipField;
}

/** What the checkbox shows for each status. `cancelled` is `[-]` in the file (§10.1). */
const MARKS: Readonly<Record<string, string>> = { done: "✓", cancelled: "✕" };

class TaskItemView implements NodeView {
  readonly dom: HTMLLIElement;
  readonly contentDOM: HTMLElement;

  private readonly checkbox: HTMLButtonElement;
  private readonly chips: HTMLElement;
  private node: ProseMirrorNode;
  private readonly onCheckboxClick: () => void;

  constructor(
    node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.node = node;

    this.dom = document.createElement("li");
    this.dom.className = "task-item";

    this.checkbox = document.createElement("button");
    this.checkbox.type = "button";
    this.checkbox.className = "task-checkbox";
    this.checkbox.setAttribute("role", "checkbox");
    // See the module comment: the keyboard path is the inspector, not this element.
    this.checkbox.tabIndex = -1;
    // The attribute, not the `contentEditable` property: the property is what tells
    // ProseMirror this subtree is not the document, and not every DOM implementation
    // reflects the property back onto the attribute the editor actually reads.
    this.checkbox.setAttribute("contenteditable", "false");
    this.onCheckboxClick = () => this.toggle();
    this.checkbox.addEventListener("click", this.onCheckboxClick);

    const line = document.createElement("div");
    line.className = "task-line";
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "task-body";
    this.chips = document.createElement("span");
    this.chips.className = "task-chips";
    this.chips.setAttribute("contenteditable", "false");
    line.append(this.contentDOM, this.chips);

    this.dom.append(this.checkbox, line);
    this.render();
  }

  /**
   * Accepts any later state of the same node type, re-rendering the parts we own.
   *
   * Returning `true` is what keeps the cursor where the user left it: rejecting the update
   * makes ProseMirror throw the node view away and build a new one, which on every keystroke
   * inside a task would destroy and recreate the element the selection lives in.
   */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    // why: `sameMarkup` is true when only the *content* changed — which is every keystroke
    // inside a task. Rebuilding the chips there would put a `replaceChildren` and a handful
    // of element allocations on the keystroke path for no visible difference (§4.5), and
    // would also throw away the element under a chip the user was in the middle of clicking.
    const unchanged = node.sameMarkup(this.node);
    this.node = node;
    if (!unchanged) this.render();
    return true;
  }

  /**
   * Everything outside `contentDOM` is ours, and ProseMirror must not read it as an edit.
   *
   * Without this, re-rendering a chip after a toggle looks to ProseMirror like the user
   * changed the document by hand, and it re-parses the DOM back into the doc — turning the
   * chip text into note content.
   */
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean {
    return !this.contentDOM.contains(mutation.target);
  }

  /** Clicks on the checkbox and the chips are ours; PM should not move the selection. */
  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Node)) return false;
    return this.checkbox.contains(target) || this.chips.contains(target);
  }

  destroy(): void {
    this.checkbox.removeEventListener("click", this.onCheckboxClick);
  }

  private render(): void {
    const attrs = this.node.attrs;
    const status = typeof attrs["status"] === "string" ? attrs["status"] : "todo";
    const complete = isTaskComplete(status);

    this.dom.dataset["taskStatus"] = status;
    this.checkbox.textContent = MARKS[status] ?? "";
    this.checkbox.setAttribute("aria-checked", complete ? "true" : "false");
    this.checkbox.setAttribute("aria-label", complete ? "Mark task not done" : "Mark task done");

    this.chips.replaceChildren();
    for (const chip of taskChips(attrs)) {
      // Inert: §10.4 says a marker this version does not model is preserved and shown, not
      // offered as something to edit. A button would promise an editor we do not have.
      const element = document.createElement(chip.field === "unknown" ? "span" : "button");
      element.className = "task-chip-inline";
      element.dataset["taskChip"] = chip.field;
      element.setAttribute("aria-label", chip.description);
      if (chip.label.length > 0) {
        const label = document.createElement("span");
        label.className = "task-chip-label";
        label.textContent = chip.label;
        element.append(label);
      }
      element.append(document.createTextNode(chip.value));
      if (element instanceof HTMLButtonElement) {
        element.type = "button";
        element.tabIndex = -1;
        element.addEventListener("click", () => this.openChip(chip.field));
      }
      this.chips.append(element);
    }
  }

  private toggle(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const attrs = { ...this.node.attrs, ...toggledTaskAttributes(this.node.attrs) };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, attrs));
  }

  /**
   * Selects this task, then asks the toolbar to open the control for the clicked field.
   *
   * The selection has to move first: the inspector shows the *selected* task, so opening its
   * date picker while the cursor sat in some other block would edit the wrong task.
   */
  private openChip(field: TaskChipField): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const inside = this.view.state.doc.resolve(pos + 1);
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(inside)));
    const detail: TaskChipEventDetail = { field };
    this.view.dom.dispatchEvent(new CustomEvent(TASK_CHIP_EVENT, { bubbles: true, detail }));
  }
}

/**
 * Registers the task node view.
 *
 * Added alongside the generated extensions in `note-editor.ts` rather than folded into them,
 * so `createMemberberryExtensions` stays a pure function of the schema contract.
 */
export const taskItemView = Extension.create({
  name: "memberberryTaskView",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("memberberryTaskView"),
        props: {
          nodeViews: {
            task_item: (node, view, getPos) => new TaskItemView(node, view, getPos),
          },
        },
      }),
    ];
  },
});
