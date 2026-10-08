/** Isolated real-browser binding fixture; not application wiring. */
import {Editor} from "@tiptap/core";
import {Doc, applyUpdate, encodeStateAsUpdate} from "yjs";
import {undo, redo, yUndoPluginKey} from "y-prosemirror";
import {load, schema, updateFromMarkdown} from "../src/notes.js";
import {createMemberberryExtensions} from "../src/editor/schema.js";
import {createYjsBinding} from "../src/editor/collaboration.js";
import {editorMarkdown} from "../src/editor/source.js";
import {captureFormatSelection,canApplyInlineFormat,applyInlineFormat} from "../src/editor/selection-format.js";
let editor:Editor|undefined, doc:Doc|undefined;
export async function mount(body:string) {
 editor?.destroy();doc?.destroy();document.body.replaceChildren();
 await load(new Uint8Array(await (await fetch('/src/wasm/mb_bg.wasm')).arrayBuffer()));
 doc=new Doc();applyUpdate(doc,await updateFromMarkdown(body));
 const element=document.createElement('div');document.body.append(element);
 editor=new Editor({element,extensions:[...createMemberberryExtensions(await schema()),createYjsBinding(doc.getXmlFragment('prosemirror'))]});
 editor.state.doc.check();editor.commands.setTextSelection(3);editor.commands.focus();
 yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
 return inspect();
}
export async function inspect() {
 if(!editor||!doc)throw new Error('unmounted');editor.state.doc.check();
 return {markdown:await editorMarkdown(doc),pm:editor.state.doc.toJSON(),focused:editor.isFocused,
  nativeFocused:document.activeElement===editor.view.dom,selection:editor.state.selection.from};
}
export function history(action:'undo'|'redo') {
 if(!editor)throw new Error('unmounted');
 yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
 return action==='undo'?undo(editor.state):redo(editor.state);
}
export async function reopen() {
 if(!editor||!doc)throw new Error('unmounted');const binary=new Doc();applyUpdate(binary,encodeStateAsUpdate(doc));
 try {return {binaryMarkdown:await editorMarkdown(binary),markdown:await editorMarkdown(doc)};}finally{binary.destroy();}
}
export async function format() {
 if(!editor||!doc)throw new Error('unmounted');editor.commands.setTextSelection({from:1,to:editor.state.doc.content.size-1});
 const token=captureFormatSelection(editor);if(!token)throw new Error('capture missing');
 const capability=canApplyInlineFormat(editor,token,'strong');
 const result=applyInlineFormat(editor,token,'strong');return {capability,result,...await inspect()};
}
