// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { createMemberberryExtensions } from "./schema.js";
import { insertBlock, memberberryInputRules, moveCurrentBlock, resolveEmojiInput, resolveEmojiShortcode, setTaskDue, setTaskPriority, toggleTask } from "./commands.js";

const CONTRACT = {
  version: 1,
  topNode: "doc",
  nodes: {
    doc: { content: "block+" }, paragraph: { group: "block", content: "inline*" }, text: { group: "inline" },
    bullet_list: { group: "block", content: "(list_item | task_item)+" }, ordered_list: { group: "block", content: "(list_item | task_item)+", attrs: { start: { type: "integer", default: 1 } } }, list_item: { content: "block*" },
    task_item: { content: "block*", attrs: { status: { type: "enum", default: "todo" }, priority: { type: "enum", optional: true }, due: { type: "date", optional: true }, done: { type: "date", optional: true }, unknown: { type: "string[]", default: [] } } },
    heading: { group: "block", content: "inline*", attrs: { level: { type: "integer", default: 1 } } },
    blockquote: { group: "block", content: "block*" }, code_block: { group: "block", content: "text*", marks: "" }, divider: { group: "block", atom: true },
    table: { group: "block", content: "table_row+", attrs: { alignments: { type: "enum[]", default: [] } } }, table_row: { content: "table_cell+" }, table_cell: { content: "inline*" },
  }, marks: {},
};

function editor(): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  return new Editor({ element, extensions: [...createMemberberryExtensions(CONTRACT), memberberryInputRules] });
}

describe("editor commands", () => {
  it("resolves known shortcode input and leaves custom names alone", () => {
    const catalog = [{ shortcode: "tada", glyph: "🎉", category: "activities", aliases: ["party"], supportsSkinTone: false }];
    expect(resolveEmojiShortcode(catalog, "TADA")).toBe("🎉");
    expect(resolveEmojiShortcode(catalog, "PARTY")).toBe("🎉");
    expect(resolveEmojiShortcode(catalog, "partyparrot")).toBeUndefined();
    expect(resolveEmojiShortcode(catalog, undefined)).toBeUndefined();
    expect(resolveEmojiInput(catalog, "wave", "skin-tone-3")).toBeUndefined();
    expect(resolveEmojiInput(catalog, "tada", "skin-tone-3")).toBe("🎉");
    expect(resolveEmojiInput([{ shortcode: "wave", glyph: "👋", category: "people", aliases: [], supportsSkinTone: true }], "wave", "skin-tone-3")).toBe("👋🏼");
  });

  it("inserts every M3 toolbar block through the generated schema", () => {
    const view = editor();
    expect(insertBlock(view, "task_item")).toBe(true);
    expect(JSON.stringify(view.getJSON())).toContain('"bullet_list"');
    expect(insertBlock(view, "ordered_list")).toBe(true);
    expect(JSON.stringify(view.getJSON())).toContain('"ordered_list"');
    expect(insertBlock(view, "divider")).toBe(true);
    expect(insertBlock(view, "table")).toBe(true);
    view.destroy();
  });

  it("writes canonical task metadata from the selected task", () => {
    const view = editor();
    view.commands.setContent({ type: "doc", content: [{ type: "bullet_list", content: [{ type: "task_item", attrs: { status: "todo", unknown: [] }, content: [{ type: "paragraph", content: [{ type: "text", text: "Ship" }] }] }] }] });
    view.commands.setTextSelection(4);

    expect(setTaskDue(view, "tomorrow", new Date(2026, 8, 1))).toBe(true);
    expect(setTaskPriority(view, "high")).toBe(true);
    expect(toggleTask(view, new Date(2026, 8, 1))).toBe(true);
    expect(JSON.stringify(view.getJSON())).toContain('"status":"done"');
    expect(JSON.stringify(view.getJSON())).toContain('"due":"2026-09-02"');
    expect(JSON.stringify(view.getJSON())).toContain('"priority":"high"');
    expect(JSON.stringify(view.getJSON())).toContain('"done":"2026-09-01"');
    view.destroy();
  });

  it("moves the selected top-level block for keyboard and touch toolbar reordering", () => {
    const view = editor();
    view.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }, { type: "paragraph", content: [{ type: "text", text: "Second" }] }] });
    view.commands.setTextSelection(8);

    expect(moveCurrentBlock(view, "up")).toBe(true);
    expect(JSON.stringify(view.getJSON())).toContain('"text":"Second"');
    view.commands.setTextSelection(2);
    expect(moveCurrentBlock(view, "up")).toBe(false);
    view.destroy();
  });
});
