// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it } from "vitest";
import { Doc, applyUpdate } from "yjs";
import { load, schema, updateFromMarkdown } from "../notes.js";
import { createMemberberryExtensions } from "./schema.js";
import { createYjsBinding } from "./collaboration.js";
import { tableRowHandles } from "./table-tools.js";
import { mountEditorShell } from "./editor-shell.js";
import { editorMarkdown } from "./source.js";
const cleanups: Array<() => void> = [];
beforeAll(async () => { await load(readFileSync("src/wasm/mb_bg.wasm")); });
afterEach(() => { for (const dispose of cleanups.splice(0)) dispose(); });
it("selected underline is a visible contextual control backed by actual WASM and Yjs", async () => {
 const panel = document.createElement("section"), element = document.createElement("div"), status = document.createElement("p");
 panel.append(element,status); document.body.append(panel);
 const doc = new Doc(); applyUpdate(doc,await updateFromMarkdown("# Title\n\nLater words\n"));
 const editor = new Editor({element,extensions:[...createMemberberryExtensions(await schema()),tableRowHandles,createYjsBinding(doc.getXmlFragment("prosemirror"))]});
 const shell = mountEditorShell({editor,document:doc,panel,status});
 cleanups.push(() => { shell.destroy();editor.destroy();doc.destroy();panel.remove(); });
 let from = -1; editor.state.doc.descendants((node,pos) => { if (node.isText && node.text === "Later words") from=pos; });
 expect(from).toBeGreaterThan(0); editor.commands.setTextSelection({from,to:from+5});
 const popup=document.querySelector<HTMLElement>(".selection-menu"); expect(popup?.hidden).toBe(false);
 const control=popup?.querySelector<HTMLButtonElement>("[aria-label='Underline']"); expect(control).toBeInstanceOf(HTMLButtonElement);
 control?.click(); expect(await editorMarkdown(doc)).toBe('# Title\n\n:mb-style[Later]{underline="true"} words\n');
 expect(editor.view.dom.querySelector(".mb-underline")?.textContent).toBe("Later");
});

it("independent contextual properties and defaults retain other dimensions and explicit Clear removes them", async () => {
 const panel=document.createElement("section"),element=document.createElement("div"),status=document.createElement("p");panel.append(element,status);document.body.append(panel);
 const doc=new Doc();applyUpdate(doc,await updateFromMarkdown('# Title\n\n:mb-style[Later]{underline="true"} words\n'));
 const editor=new Editor({element,extensions:[...createMemberberryExtensions(await schema()),tableRowHandles,createYjsBinding(doc.getXmlFragment("prosemirror"))]});
 const shell=mountEditorShell({editor,document:doc,panel,status});cleanups.push(() => {shell.destroy();editor.destroy();doc.destroy();panel.remove();});
 let from=-1;editor.state.doc.descendants((node,pos) => {if(node.isText&&node.text==="Later")from=pos;});editor.commands.setTextSelection({from,to:from+5});
 document.querySelector<HTMLButtonElement>(".selection-menu [aria-label='Text color, background and size']")?.click();
 const pick=(label:string) => {const choice=document.querySelector<HTMLButtonElement>(`.selection-style-panel [aria-label='${label}']`);expect(choice).toBeInstanceOf(HTMLButtonElement);choice?.click();};
 pick("Red text");pick("Yellow background");pick("Large text size");
 expect(await editorMarkdown(doc)).toBe('# Title\n\n:mb-style[Later]{underline="true" color="red" background="yellow" size="large"} words\n');
 pick("Default text color");expect(await editorMarkdown(doc)).toBe('# Title\n\n:mb-style[Later]{underline="true" background="yellow" size="large"} words\n');
 const clear=document.querySelector<HTMLButtonElement>(".selection-menu [aria-label='Clear formatting']");clear?.click();expect(await editorMarkdown(doc)).toBe('# Title\n\nLater words\n');
});
