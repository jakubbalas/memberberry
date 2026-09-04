// @vitest-environment jsdom

/**
 * The inline task view (`SPEC.md` §10.2).
 *
 * Before this existed a task rendered as a plain bullet with its metadata living only in
 * attributes on the `li`. Every test in the repository passed, because every one of them
 * asserted on the *document* — which was correct — and none on what a reader sees. So the
 * assertions here are deliberately about the rendered DOM and about what a click does to the
 * document, which are the two things nothing else was looking at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { createMemberberryExtensions } from "./schema.js";
import { TASK_CHIP_EVENT, taskItemView, type TaskChipEventDetail } from "./task-view.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

/** A document holding one task, so a test can name its attributes precisely. */
function taskDocument(attrs: Readonly<Record<string, unknown>>, text = "Write the tests") {
  return {
    type: "doc",
    content: [
      {
        type: "bullet_list",
        content: [
          {
            type: "task_item",
            attrs: { status: "todo", unknown: [], ...attrs },
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          },
        ],
      },
    ],
  };
}

function mount(attrs: Readonly<Record<string, unknown>> = {}, text?: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [...createMemberberryExtensions(contract), taskItemView],
    content: text === undefined ? taskDocument(attrs) : taskDocument(attrs, text),
  });
  const item = element.querySelector<HTMLLIElement>("li.task-item");
  if (item === null) throw new Error("the task node view did not render an item");
  const checkbox = item.querySelector<HTMLButtonElement>(".task-checkbox");
  if (checkbox === null) throw new Error("the task node view did not render a checkbox");
  return {
    editor,
    element,
    item,
    checkbox,
    /** The attributes of the single task, read back out of the document. */
    attrs: (): Readonly<Record<string, unknown>> => {
      const list = editor.state.doc.child(0);
      return list.child(0).attrs;
    },
    chips: (): readonly HTMLElement[] => [...item.querySelectorAll<HTMLElement>(".task-chip-inline")],
    destroy: (): void => {
      editor.destroy();
      element.remove();
    },
  };
}

describe("the task checkbox", () => {
  it("renders an unticked box for an open task", () => {
    const mounted = mount({ status: "todo" });
    try {
      expect(mounted.checkbox.getAttribute("aria-checked")).toBe("false");
      expect(mounted.checkbox.getAttribute("aria-label")).toBe("Mark task done");
      expect(mounted.item.dataset["taskStatus"]).toBe("todo");
    } finally {
      mounted.destroy();
    }
  });

  it("renders a ticked box for a completed task", () => {
    const mounted = mount({ status: "done", done: "2026-08-28" });
    try {
      expect(mounted.checkbox.getAttribute("aria-checked")).toBe("true");
      expect(mounted.checkbox.getAttribute("aria-label")).toBe("Mark task not done");
      expect(mounted.checkbox.textContent).toBe("✓");
    } finally {
      mounted.destroy();
    }
  });

  it("distinguishes a cancelled task from a completed one", () => {
    // `[-]` and `[x]` are different lines in the file (§10.1) and must not look the same.
    const mounted = mount({ status: "cancelled", cancelled: "2026-08-20" });
    try {
      expect(mounted.item.dataset["taskStatus"]).toBe("cancelled");
      expect(mounted.checkbox.textContent).toBe("✕");
      expect(mounted.checkbox.getAttribute("aria-checked")).toBe("false");
    } finally {
      mounted.destroy();
    }
  });

  it("completes the task it belongs to when clicked, and stamps the date", () => {
    const mounted = mount({ status: "todo" });
    try {
      mounted.checkbox.click();

      expect(mounted.attrs()["status"]).toBe("done");
      expect(mounted.attrs()["done"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The view followed the document rather than only the click.
      expect(mounted.item.dataset["taskStatus"]).toBe("done");
      expect(mounted.checkbox.getAttribute("aria-checked")).toBe("true");
    } finally {
      mounted.destroy();
    }
  });

  it("reopens a completed task and clears its completion date", () => {
    const mounted = mount({ status: "done", done: "2026-08-28" });
    try {
      mounted.checkbox.click();

      expect(mounted.attrs()["status"]).toBe("todo");
      expect(mounted.attrs()["done"]).toBeNull();
    } finally {
      mounted.destroy();
    }
  });

  it("toggles the clicked task rather than wherever the cursor happens to be", () => {
    // The regression this rules out is the obvious implementation: reusing the toolbar's
    // `toggleTask`, which acts on the selection. With the cursor in the first task, clicking
    // the second one's box would have completed the first.
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [...createMemberberryExtensions(contract), taskItemView],
      content: {
        type: "doc",
        content: [
          {
            type: "bullet_list",
            content: ["First", "Second"].map((text) => ({
              type: "task_item",
              attrs: { status: "todo", unknown: [] },
              content: [{ type: "paragraph", content: [{ type: "text", text }] }],
            })),
          },
        ],
      },
    });
    try {
      // The cursor starts in the first task; click the second one's box.
      const boxes = element.querySelectorAll<HTMLButtonElement>(".task-checkbox");
      expect(boxes).toHaveLength(2);
      boxes[1]?.click();

      const list = editor.state.doc.child(0);
      expect(list.child(0).attrs["status"]).toBe("todo");
      expect(list.child(1).attrs["status"]).toBe("done");
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  it("is out of the tab order, because the inspector is the keyboard route", () => {
    // Not an oversight: a note with a hundred tasks would otherwise put a hundred tab stops
    // between the text and anything after it, and `Tab` inside a document is the editor's.
    const mounted = mount();
    try {
      expect(mounted.checkbox.tabIndex).toBe(-1);
      expect(mounted.checkbox.getAttribute("contenteditable")).toBe("false");
    } finally {
      mounted.destroy();
    }
  });
});

describe("the inline metadata chips", () => {
  it("renders a due date as a chip a reader can see", () => {
    const mounted = mount({ due: "2026-09-30" });
    try {
      const chips = mounted.chips();
      expect(chips).toHaveLength(1);
      expect(chips[0]?.textContent).toBe("Due2026-09-30");
      expect(chips[0]?.getAttribute("aria-label")).toBe("Due 2026-09-30");
      expect(chips[0]?.dataset["taskChip"]).toBe("due");
    } finally {
      mounted.destroy();
    }
  });

  it("shows no chips for a task carrying no metadata", () => {
    const mounted = mount();
    try {
      expect(mounted.chips()).toHaveLength(0);
    } finally {
      mounted.destroy();
    }
  });

  it("does not render the raw emoji markers the file uses", () => {
    // §10.2: "renders as inline chips, not raw emoji". The markers belong to the Markdown.
    const mounted = mount({ due: "2026-09-30", priority: "high" });
    try {
      expect(mounted.item.textContent).not.toContain("📅");
      expect(mounted.item.textContent).not.toContain("⏫");
      expect(mounted.item.textContent).toContain("2026-09-30");
    } finally {
      mounted.destroy();
    }
  });

  it("leaves the chips alone while the task's text is being typed", () => {
    // §4.5: nothing allocates on the keystroke path without a reason. Rebuilding a chip on
    // every character would also destroy the element under a chip mid-click.
    const mounted = mount({ due: "2026-09-30" });
    try {
      const before = mounted.chips()[0];
      mounted.editor.commands.insertContent("more");

      expect(mounted.chips()[0]).toBe(before);
    } finally {
      mounted.destroy();
    }
  });

  it("updates the chips when the document's metadata changes", () => {
    const mounted = mount({ due: "2026-09-30" });
    try {
      mounted.editor.commands.updateAttributes("task_item", { due: "2026-10-15" });

      expect(mounted.chips()[0]?.textContent).toContain("2026-10-15");
    } finally {
      mounted.destroy();
    }
  });

  it("renders a preserved marker as a label rather than a control", () => {
    // §10.4: inert. A button would offer an editor for a marker we deliberately do not model.
    const mounted = mount({ unknown: ["🔁 every week"] });
    try {
      const chip = mounted.chips()[0];
      expect(chip?.tagName).toBe("SPAN");
      expect(chip?.textContent).toBe("🔁 every week");
    } finally {
      mounted.destroy();
    }
  });

  it("asks the toolbar to open the picker for the chip that was clicked", () => {
    // §10.2: "click a chip for a date picker or priority menu". The node view cannot reach
    // the toolbar, so it announces the request; `editor-shell.ts` is what listens.
    const mounted = mount({ due: "2026-09-30" });
    const seen: TaskChipEventDetail[] = [];
    const listen = (event: Event): void => {
      if (event instanceof CustomEvent) seen.push(event.detail as TaskChipEventDetail);
    };
    mounted.editor.view.dom.addEventListener(TASK_CHIP_EVENT, listen);
    try {
      mounted.chips()[0]?.click();

      expect(seen).toEqual([{ field: "due" }]);
      // The selection moved onto this task first, so the inspector shows the right one.
      expect(mounted.editor.isActive("task_item")).toBe(true);
    } finally {
      mounted.editor.view.dom.removeEventListener(TASK_CHIP_EVENT, listen);
      mounted.destroy();
    }
  });
});

describe("the task view and the document underneath it", () => {
  it("leaves the task's text as note content and the chips out of it", () => {
    // The failure this rules out is the node view's own DOM being parsed back in: chips are
    // outside `contentDOM`, and if ProseMirror read them as an edit the due date would
    // become part of the sentence — and then part of the Markdown file.
    const mounted = mount({ due: "2026-09-30" }, "Write the tests");
    try {
      const task = mounted.editor.state.doc.child(0).child(0);
      expect(task.textContent).toBe("Write the tests");
      expect(mounted.editor.getText()).not.toContain("2026-09-30");
    } finally {
      mounted.destroy();
    }
  });

  it("keeps the status attribute on the item, which the note tree and index read", () => {
    const mounted = mount({ status: "done" });
    try {
      expect(mounted.element.querySelector("ul li[data-task-status='done']")).not.toBeNull();
    } finally {
      mounted.destroy();
    }
  });
});
