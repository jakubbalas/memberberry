// Focused installed-binding proof; no application server or real notes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {JSDOM} from 'jsdom';
import {Editor} from '@tiptap/core';
import * as Y from 'yjs';
import {yXmlFragmentToProsemirrorJSON} from 'y-prosemirror';
const evidence=process.env.MB_CODE_EVIDENCE;
assert(evidence && path.isAbsolute(evidence) && fs.statSync(evidence).isDirectory(), 'MB_CODE_EVIDENCE must be an existing absolute directory');
const web=process.cwd();
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
for(const name of ['window','document','navigator','Node','HTMLElement','Element','MutationObserver','DOMParser','getComputedStyle']) Object.defineProperty(globalThis,name,{value:name==='getComputedStyle'?dom.window[name].bind(dom.window):dom.window[name],configurable:true});
const vite=await createServer({root:web,configFile:false,cacheDir:path.join(evidence,'vite'),server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]}});
const rows=[];
try {
 const glue=fs.readFileSync(path.join(web,'src/wasm/mb.js'),'utf8');
 const wasm=await import('data:text/javascript;base64,'+Buffer.from(glue).toString('base64')+'#native-final');
 await wasm.default({module_or_path:fs.readFileSync(path.join(web,'src/wasm/mb_bg.wasm'))});
 const contract=JSON.parse(wasm.schemaJson());
 const declared=JSON.parse(fs.readFileSync(path.join(web,'../crates/mb-core/schema.json')));
 assert.deepEqual(contract,declared); assert.equal(contract.version,3); assert.equal(contract.marks.code.excludes,'code mb_underline mb_color mb_background mb_size');
 const {createMemberberrySchema,createMemberberryExtensions}=await vite.ssrLoadModule(path.join(web,'src/editor/schema.ts'));
 const {createYjsBinding}=await vite.ssrLoadModule(path.join(web,'src/editor/collaboration.ts'));
 const schema=createMemberberrySchema(contract); assert(schema.marks.code.excludes(schema.marks.code));
 rows.push({kind:'identity',version:contract.version,contract});
 for(const fixture of JSON.parse(fs.readFileSync(path.join(evidence,'native-subsets.json')))) {
  const bytes=Buffer.from(fixture.updateHex,'hex');
  assert.equal(wasm.markdownFromUpdate(bytes),fixture.markdown);
  const doc=new Y.Doc();Y.applyUpdate(doc,bytes); const before=Y.encodeStateAsUpdate(doc);
  schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('prosemirror'))).check();
  const element=document.createElement('div'); document.body.append(element);
  const editor=new Editor({element,extensions:[...createMemberberryExtensions(contract),createYjsBinding(doc.getXmlFragment('prosemirror'))],editorProps:{handleScrollToSelection:()=>true}});
  try {
   editor.state.doc.check(); assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
   editor.view.dispatch(editor.state.tr.insertText('Z',3)); editor.state.doc.check();
   const typed=wasm.markdownFromUpdate(Y.encodeStateAsUpdate(doc)); assert(typed.includes('Z'));
   const attrs=doc.getXmlFragment('prosemirror').toArray()[0].toArray().flatMap(t=>t.toDelta()).flatMap(t=>Object.keys(t.attributes??{}));
   assert(!attrs.some(k=>k.includes('--'))); assert(attrs.includes('code'));
   rows.push({kind:'subset',mask:fixture.mask,nativeMarkdown:fixture.markdown,typedMarkdown:typed,attrs,pm:editor.state.doc.toJSON()});
  } finally {editor.destroy();element.remove();doc.destroy();}
 }
 for(const [name,value] of [['unknown',{}],['code--LpaW+ak5',{}],['mb_color',{}],['code',true],['strong',true],['code',{extra:true}],['link',{href:'https://example.org',extra:true}],['link',{href:'https://example.org',title:true}]]) {
  const doc=new Y.Doc(),p=new Y.XmlElement('paragraph'),t=new Y.XmlText();doc.getXmlFragment('prosemirror').insert(0,[p]);p.insert(0,[t]);t.insert(0,'literal',{[name]:value});
  const before=Y.encodeStateAsUpdate(doc); let error;
  try {wasm.markdownFromUpdate(before)} catch(e) {error=String(e)}
  assert(error,`refuse ${name}`);assert.deepEqual(Y.encodeStateAsUpdate(doc),before);
  rows.push({kind:'refusal',name,value,error});doc.destroy();
 }
} finally {fs.writeFileSync(path.join(evidence,'binding-parity.json'),JSON.stringify(rows,null,2));await vite.close();dom.window.close();}
assert.equal(rows.filter(r=>r.kind==='subset').length,32);
console.log(JSON.stringify({identity:1,subsets:32,refusals:8,passed:true}));
