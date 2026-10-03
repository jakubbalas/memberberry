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
import { describe, expect, it, vi } from "vitest";

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

/** jsdom has no PointerEvent constructor; preserve the browser's event fields at this boundary. */
function pointer(target: EventTarget, type: string, options: Partial<PointerEventInit> = {}): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 100, ...options });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    pointerType: { value: options.pointerType ?? "touch" },
    isPrimary: { value: options.isPrimary ?? true },
  });
  target.dispatchEvent(event);
  return event;
}

function pointerClick(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

describe("task gestures", () => {
  it.each(["pointercancel", "drag", "return drag", "release movement", "ancestor scroll", "second touch"])(
    "does not untick after %s, but accepts the next deliberate tap",
    (gesture) => {
      const mounted = mount({ status: "done", done: "2026-08-28" });
      try {
        const down = pointer(mounted.checkbox, "pointerdown");
        expect(down.defaultPrevented).toBe(false);
        if (gesture === "pointercancel") pointer(document, "pointercancel");
        if (gesture === "drag" || gesture === "return drag") {
          const move = pointer(document, "pointermove", { clientY: 45 });
          expect(move.defaultPrevented).toBe(false);
        }
        if (gesture === "return drag") pointer(document, "pointermove", { clientY: 100 });
        if (gesture === "ancestor scroll") mounted.element.dispatchEvent(new Event("scroll"));
        if (gesture === "second touch") pointer(document, "pointerdown", { pointerId: 2, isPrimary: false });
        if (gesture !== "pointercancel") pointer(document, "pointerup", { clientY: gesture === "release movement" ? 45 : 100 });
        // Some engines/embedders still deliver a compatibility click after a cancelled gesture.
        pointerClick(mounted.checkbox);
        expect(mounted.attrs()["status"]).toBe("done");
        expect(mounted.attrs()["done"]).toBe("2026-08-28");
        pointer(mounted.checkbox, "pointerdown");
        pointer(document, "pointerup");
        pointerClick(mounted.checkbox);
        expect(mounted.attrs()["status"]).toBe("todo");
      } finally { mounted.destroy(); }
    },
  );

  it.each(["touch", "pen", "mouse"])("accepts a deliberate %s tap with small movement exactly once", (pointerType) => {
    const mounted = mount();
    const changed = vi.fn();
    mounted.editor.on("update", changed);
    try {
      pointer(mounted.checkbox, "pointerdown", { pointerType });
      pointer(document, "pointermove", { pointerType, clientX: 22, clientY: 103 });
      pointer(document, "pointerup", { pointerType, clientX: 22, clientY: 103 });
      expect(mounted.attrs()["status"]).toBe("todo");
      pointerClick(mounted.checkbox);
      expect(mounted.attrs()["status"]).toBe("done");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally { mounted.destroy(); }
  });

  it("does not let unrelated scrolls or other pointer movement cancel a tap", () => {
    const mounted = mount();
    const other = document.createElement("div");
    document.body.append(other);
    try {
      pointer(mounted.checkbox, "pointerdown");
      other.dispatchEvent(new Event("scroll"));
      pointer(document, "pointermove", { pointerId: 2, clientY: 5 });
      pointer(document, "pointerup", { pointerId: 2 });
      pointer(document, "pointerup");
      pointerClick(mounted.checkbox);
      expect(mounted.attrs()["status"]).toBe("done");
    } finally { other.remove(); mounted.destroy(); }
  });

  it("preserves keyboard/programmatic activation after a cancelled touch", () => {
    const mounted = mount();
    try {
      pointer(mounted.checkbox, "pointerdown");
      pointer(document, "pointercancel");
      mounted.checkbox.click();
      expect(mounted.attrs()["status"]).toBe("done");
    } finally { mounted.destroy(); }
  });

  it("rejects a touch PointerEvent click with zero detail after cancellation", () => {
    const mounted = mount();
    try {
      pointer(mounted.checkbox, "pointerdown");
      pointer(document, "pointercancel");
      pointer(mounted.checkbox, "click", { detail: 0 });
      expect(mounted.attrs()["status"]).toBe("todo");
      mounted.checkbox.click();
      expect(mounted.attrs()["status"]).toBe("done");
    } finally { mounted.destroy(); }
  });

  it("does not edit a read-only task or open its metadata picker", () => {
    const mounted = mount({ due: "2026-09-30" });
    const changed = vi.fn();
    const picker = vi.fn();
    mounted.editor.on("update", changed);
    mounted.editor.view.dom.addEventListener(TASK_CHIP_EVENT, picker);
    try {
      mounted.editor.setEditable(false);
      changed.mockClear();
      mounted.checkbox.click();
      mounted.chips()[0]?.click();
      expect(mounted.attrs()["status"]).toBe("todo");
      expect(changed).not.toHaveBeenCalled();
      expect(picker).not.toHaveBeenCalled();
      mounted.editor.setEditable(true);
      mounted.checkbox.click();
      expect(mounted.attrs()["status"]).toBe("done");
    } finally { mounted.destroy(); }
  });

  it.each(["pointerup", "pointercancel"])("removes document gesture listeners on %s rather than on every later scroll", (end) => {
    const mounted = mount();
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    try {
      pointer(mounted.checkbox, "pointerdown");
      const listeners = add.mock.calls.filter(([type]) => ["pointermove", "pointerup", "pointercancel", "pointerdown", "scroll"].includes(type));
      expect(listeners).toHaveLength(5);
      pointer(document, end);
      for (const [type, handler] of listeners) {
        expect(remove.mock.calls.some(([removedType, removedHandler, capture]) => removedType === type && removedHandler === handler && capture === true)).toBe(true);
      }
    } finally { mounted.destroy(); vi.restoreAllMocks(); }
  });

  it("does not track or prevent native pointer input in task text", () => {
    const mounted = mount();
    const add = vi.spyOn(document, "addEventListener");
    try {
      const body = mounted.item.querySelector(".task-body");
      if (body === null) throw new Error("missing task body");
      expect(pointer(body, "pointerdown").defaultPrevented).toBe(false);
      expect(add.mock.calls.filter(([type]) => type === "pointermove" || type === "scroll")).toEqual([]);
      mounted.editor.commands.insertContent("Typed ");
      expect(mounted.editor.getText()).toContain("Typed ");
      expect(mounted.attrs()["status"]).toBe("todo");
    } finally { mounted.destroy(); vi.restoreAllMocks(); }
  });

  it("does not open a chip after a drag, but accepts a deliberate tap on its nested label", () => {
    const mounted = mount({ due: "2026-09-30" });
    const picker = vi.fn();
    mounted.editor.view.dom.addEventListener(TASK_CHIP_EVENT, picker);
    try {
      const label = mounted.chips()[0]?.querySelector(".task-chip-label");
      if (label == null) throw new Error("missing chip label");
      pointer(label, "pointerdown");
      pointer(document, "pointermove", { clientY: 40 });
      pointer(document, "pointerup");
      pointerClick(label);
      expect(picker).not.toHaveBeenCalled();
      pointer(label, "pointerdown");
      pointer(document, "pointerup");
      pointerClick(label);
      expect(picker).toHaveBeenCalledTimes(1);
    } finally { mounted.destroy(); }
  });

  it("disposes a chip's active gesture and click handler when metadata replaces it", () => {
    const mounted = mount({ due: "2026-09-30" });
    const chip = mounted.chips()[0];
    const picker = vi.fn();
    mounted.editor.view.dom.addEventListener(TASK_CHIP_EVENT, picker);
    try {
      if (chip === undefined) throw new Error("missing chip");
      pointer(chip, "pointerdown");
      mounted.editor.commands.updateAttributes("task_item", { due: "2026-10-10" });
      pointer(document, "pointerup");
      chip.click();
      expect(picker).not.toHaveBeenCalled();
      mounted.chips()[0]?.click();
      expect(picker).toHaveBeenCalledTimes(1);
    } finally { mounted.destroy(); }
  });

  it("removes active gesture listeners and leaves detached controls inert on teardown", () => {
    const mounted = mount({ due: "2026-09-30" });
    const dispatch = vi.spyOn(mounted.editor.view, "dispatch");
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const chip = mounted.chips()[0];
    try {
      pointer(mounted.checkbox, "pointerdown");
      const listeners = add.mock.calls.filter(([type]) => ["pointermove", "pointerup", "pointercancel", "pointerdown", "scroll"].includes(type));
      mounted.destroy();
      for (const [type, handler] of listeners) {
        expect(remove.mock.calls.some(([removedType, removedHandler]) => removedType === type && removedHandler === handler)).toBe(true);
      }
      dispatch.mockClear();
      pointer(document, "pointerup");
      mounted.checkbox.click();
      chip?.click();
      expect(dispatch).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
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
  it("ignores its own checkbox/chip mutations without rereading them as note edits", async () => {
    const mounted = mount({ due: "2026-09-30", priority: "high" });
    const changed = vi.fn();
    mounted.editor.on("update", changed);
    try {
      mounted.checkbox.click();
      await Promise.resolve();
      const snapshot = mounted.editor.getJSON();
      const chip = mounted.chips()[0];
      if (chip === undefined) throw new Error("missing rendered chip");
      mounted.checkbox.setAttribute("data-test-paint", "touched");
      chip.append(document.createTextNode("Decoration only"));
      await Promise.resolve();
      expect(mounted.editor.getJSON()).toEqual(snapshot);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(mounted.editor.state.doc.textContent).toBe("Write the tests");
    } finally { mounted.destroy(); }
  });

  it("still reads native text mutations in contentDOM, preserving task metadata and node identity", async () => {
    const mounted = mount({ status: "done", done: "2026-08-28", due: "2026-09-30" });
    try {
      const text = mounted.item.querySelector(".task-body p")?.firstChild;
      if (text === undefined || text === null) throw new Error("missing editable text");
      text.nodeValue = "Native input survives";
      await vi.waitFor(() => expect(mounted.editor.state.doc.textContent).toBe("Native input survives"));
      expect(mounted.attrs()["status"]).toBe("done");
      expect(mounted.attrs()["due"]).toBe("2026-09-30");
      expect(mounted.item.querySelector(".task-checkbox")).toBe(mounted.checkbox);
    } finally { mounted.destroy(); }
  });
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
