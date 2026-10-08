// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import { undo, redo, yUndoPluginKey } from "y-prosemirror";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { createYjsBinding } from "./collaboration.js";
import { editorMarkdown } from "./source.js";
import { applyInlineFormat, canApplyInlineFormat, captureFormatSelection, type InlineFormat } from "./selection-format.js";
const disposers: (() => void)[] = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const d of disposers.splice(0)) d(); });
async function open(body: string) {
 const doc = new Doc(); applyUpdate(doc, await updateFromMarkdown(body));
 const element = document.createElement("div"); document.body.append(element);
 const editor = new Editor({ element, extensions: [...createMemberberryExtensions(await schema()), createYjsBinding(doc.getXmlFragment("prosemirror"))] });
 disposers.push(() => { editor.destroy(); doc.destroy(); element.remove(); });
 return {editor, doc};
}
function capture(editor: Editor) {
 editor.commands.setTextSelection({from: 1, to: editor.state.doc.content.size - 1});
 const token = captureFormatSelection(editor); if (!token) throw new Error("missing capture"); return token;
}
it.each([
 ["strong", "**`literal`**\n"], ["em", "*`literal`*\n"],
 ["strikethrough", "~~`literal`~~\n"], ["highlight", "==`literal`==\n"],
 ["link", '[`literal`](https://example.org "Authored title")\n'],
] as const)("imports, types, undoes and reopens native %s around Code", async (_name, body) => {
 const f = await open(body); f.editor.state.doc.check();
 const original = f.editor.state.doc.toJSON(); const saved = await editorMarkdown(f.doc);
 const manager = yUndoPluginKey.getState(f.editor.state)?.undoManager;
 manager?.stopCapturing(); f.editor.view.dispatch(f.editor.state.tr.insertText("Z", 3)); manager?.stopCapturing();
 f.editor.state.doc.check(); const typed = await editorMarkdown(f.doc);
 expect(typed).toContain("liZteral"); expect(undo(f.editor.state)).toBe(true);
 expect(f.editor.state.doc.toJSON()).toEqual(original); expect(await editorMarkdown(f.doc)).toBe(saved);
 expect(redo(f.editor.state)).toBe(true); expect(await editorMarkdown(f.doc)).toBe(typed);
 const binary = new Doc(); applyUpdate(binary, encodeStateAsUpdate(f.doc));
 try { expect(await editorMarkdown(binary)).toBe(typed); } finally { binary.destroy(); }
 const reopened = await open(typed); expect(reopened.editor.state.doc.toJSON()).toEqual(f.editor.state.doc.toJSON());
});
it.each(["strong", "em", "strikethrough", "highlight", {link: "https://new.example"}] satisfies InlineFormat[])("capability and direct action preserve Code wrappers %j in both orders", async action => {
 const f = await open("`literal`\n"); let token = capture(f.editor);
 expect(canApplyInlineFormat(f.editor, token, action)).toBe(true);
 expect(applyInlineFormat(f.editor, token, action)).toBe("applied");
 f.editor.state.doc.check(); expect(f.editor.state.doc.firstChild?.firstChild?.marks.map(m => m.type.name)).toContain("code");
 const g = await open("literal\n"); token = capture(g.editor);
 expect(applyInlineFormat(g.editor, token, action)).toBe("applied"); token = capture(g.editor);
 expect(canApplyInlineFormat(g.editor, token, "code")).toBe(true);
 expect(applyInlineFormat(g.editor, token, "code")).toBe("applied");
 g.editor.state.doc.check(); expect(await editorMarkdown(g.doc)).toBe(await editorMarkdown(f.doc));
});
it("destination-only wrapped Code edits preserve authored titles", async () => {
 const f = await open('[`literal`](https://example.org "Authored title")\n');
 const token = capture(f.editor); expect(canApplyInlineFormat(f.editor, token, {link:"https://new.example"})).toBe(true);
 expect(applyInlineFormat(f.editor, token, {link:"https://new.example"})).toBe("applied");
 expect(await editorMarkdown(f.doc)).toBe('[`literal`](https://new.example "Authored title")\n');
});
