// Installed-binding regression: actual native WASM generation, never a public seed replacement.
// Run from any cwd: node web/scripts/test-contiguous-history.mjs.
// MB_CONTIGUOUS_EVIDENCE optionally selects an existing absolute evidence directory.
import { readFileSync, writeFileSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from '../node_modules/jsdom/lib/api.js';
import * as Y from '../node_modules/yjs/dist/yjs.mjs';
import { EditorState, TextSelection } from '../node_modules/prosemirror-state/dist/index.js';
import { EditorView } from '../node_modules/prosemirror-view/dist/index.js';
import { ySyncPlugin, yUndoPlugin, yUndoPluginKey, undo, redo, yXmlFragmentToProsemirrorJSON } from '../node_modules/y-prosemirror/src/y-prosemirror.js';
import { createServer } from '../node_modules/vite/dist/node/index.js';
import * as wasm from '../src/wasm/mb.js';
const requested = process.env.MB_CONTIGUOUS_EVIDENCE;
if (requested !== undefined && (!isAbsolute(requested) || !existsSync(requested) || !statSync(requested).isDirectory())) throw Error('MB_CONTIGUOUS_EVIDENCE must be an existing absolute directory');
const evidence = requested ?? mkdtempSync(join(tmpdir(), 'memberberry-contiguous-'));
const out = (p, v) => writeFileSync(join(evidence, p), JSON.stringify(v, null, 2) + '\n');
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/contiguous-fragmented.json', import.meta.url)));
assert.equal(fixtures.length, 11);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual:true });
for (const k of ['window','document','navigator','MutationObserver','Node','HTMLElement','getComputedStyle']) Object.defineProperty(globalThis,k,{value:k === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[k],configurable:true});
Object.assign(globalThis,{innerHeight:800,innerWidth:1280,requestAnimationFrame:dom.window.requestAnimationFrame.bind(dom.window),cancelAnimationFrame:dom.window.cancelAnimationFrame.bind(dom.window)});
wasm.initSync({module:readFileSync(new URL('../src/wasm/mb_bg.wasm',import.meta.url))});
const vite = await createServer({root:new URL('../',import.meta.url).pathname,configFile:false,cacheDir:join(evidence,'vite-cache'),server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]}});
function adjacent(f) { let count=0; const walk=t=>{const xs=t.toArray?.()??[];for(let i=1;i<xs.length;i++)if(xs[i] instanceof Y.XmlText && xs[i-1] instanceof Y.XmlText)count++; xs.forEach(walk);};walk(f);return count; }
const tree=t=>({name:t.nodeName,attrs:t.getAttributes?.(),delta:t.toDelta?.(),children:t.toArray?.().map(tree)});
const rows=[], singles=[];
try {
 const {createMemberberrySchema} = await vite.ssrLoadModule('/src/editor/schema.ts');
 const schema = createMemberberrySchema(JSON.parse(wasm.schemaJson()));
 assert.equal(schema.marks.code.spec.excludes, 'code mb_underline mb_color mb_background mb_size');
 out('schema.json', JSON.parse(wasm.schemaJson()));
 const project=d=>schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(d.getXmlFragment('prosemirror'))).toJSON();
 for(const fixture of fixtures) {
  const canonical = Object.fromEntries(Object.entries({initial:fixture.source,older:fixture.source.replace('alpha','Oalpha'),typed:fixture.source.replace('alpha','OalXpha')}).map(([k,v])=>[k,wasm.markdownFromUpdate(wasm.updateFromMarkdown(v))]));
  for(const shape of ['actual-native-contiguous','original-fragmented-negative']) {
   const d=new Y.Doc();
   const bytes = shape === 'actual-native-contiguous' ? wasm.updateFromMarkdown(fixture.source) : Buffer.from(fixture.legacyBinary,'base64');
   Y.applyUpdate(d,bytes);
   const f=d.getXmlFragment('prosemirror'), initialAdjacent=adjacent(f);
   if(shape === 'actual-native-contiguous') assert.equal(initialAdjacent,0,fixture.name+' adjacent wrappers');
   const expected=schema.nodeFromJSON(fixture.expected).toJSON();
   const mount=document.createElement('div');document.body.append(mount);
   const view=new EditorView(mount,{state:EditorState.create({schema,plugins:[ySyncPlugin(f),yUndoPlugin()]}),dispatchTransaction(tr){this.updateState(this.state.applyTransaction(tr).state);}});
   const manager=yUndoPluginKey.getState(view.state).undoManager, snaps=[];
   const snapshot=(label,which)=>{const bytes=Y.encodeStateAsUpdate(d), fresh=new Y.Doc();Y.applyUpdate(fresh,bytes);const s={label,pm:view.state.doc.toJSON(),yProjection:project(fresh),tree:tree(f),markdown:wasm.markdownFromUpdate(bytes),expectedMarkdown:canonical[which],binaryReopenMarkdown:wasm.markdownFromUpdate(Y.encodeStateAsUpdate(fresh)),binary:Buffer.from(bytes).toString('base64')};fresh.destroy();snaps.push(s);return s;};
   const initial=snapshot('initial','initial');
   const insert=(text,index)=>{let pos;view.state.doc.descendants((n,p)=>{if(pos===undefined&&n.isText&&n.text.includes('alpha'))pos=p+n.text.indexOf('alpha')+index;});assert.notEqual(pos,undefined);view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos)));const tr=view.state.tr.insertText(text),wanted=tr.doc.toJSON();view.dispatch(tr);return wanted;};
   manager.stopCapturing();const olderExpected=insert('O',0), older=snapshot('older','older');manager.stopCapturing();const typedExpected=insert('X',2),typed=snapshot('typed','typed');manager.stopCapturing();
   const history=[];
   for(let cycle=0;cycle<3;cycle++){const u=undo(view.state),us=snapshot('undo-'+cycle,'older'),r=redo(view.state),rs=snapshot('redo-'+cycle,'typed');history.push({cycle,undoReturned:u,redoReturned:r,undoExact:eq(us.pm,olderExpected),redoExact:eq(rs.pm,typedExpected)});}
   const uLater=undo(view.state),afterLater=snapshot('final-undo-later','older'),uOlder=undo(view.state),afterOlder=snapshot('final-undo-older','initial'),rOlder=redo(view.state),afterRedoOlder=snapshot('final-redo-older','older'),rLater=redo(view.state),afterRedoLater=snapshot('final-redo-later','typed');
   const row={name:fixture.name,shape,initialAdjacent,initialExact:eq(initial.pm,expected),olderExact:eq(older.pm,olderExpected),typedExact:eq(typed.pm,typedExpected),history,olderHistoryExact:uLater&&uOlder&&rOlder&&rLater&&eq(afterLater.pm,olderExpected)&&eq(afterOlder.pm,expected)&&eq(afterRedoOlder.pm,olderExpected)&&eq(afterRedoLater.pm,typedExpected),projectionExactEveryStage:snaps.every(s=>eq(s.pm,s.yProjection)),markdownExactEveryStage:snaps.every(s=>s.markdown===s.expectedMarkdown),binaryReopenMarkdownEveryStage:snaps.every(s=>s.markdown===s.binaryReopenMarkdown),leadingH1EveryStage:snaps.every(s=>eq(s.pm.content[0],expected.content[0])),states:snaps};
   row.pass=row.initialExact&&row.olderExact&&row.typedExact&&row.history.every(h=>h.undoReturned&&h.redoReturned&&h.undoExact&&h.redoExact)&&row.olderHistoryExact&&row.projectionExactEveryStage&&row.markdownExactEveryStage&&row.binaryReopenMarkdownEveryStage&&row.leadingH1EveryStage;
   out(fixture.name+'-'+shape+'.json',row);rows.push(row);console.log(JSON.stringify({...row,states:undefined}));
   view.destroy();d.destroy();mount.remove();
   if(shape==='actual-native-contiguous')assert.ok(row.pass,fixture.name+' actual encoder history');
  }
 }
 // Exact original alpha -> alXpha title-triplet reproducer, without older typing first.
 const fixture=fixtures[0];
 for(const shape of ['actual-native-contiguous','original-fragmented-negative']) {
  const d=new Y.Doc();Y.applyUpdate(d,shape==='actual-native-contiguous'?wasm.updateFromMarkdown(fixture.source):Buffer.from(fixture.legacyBinary,'base64'));
  const mount=document.createElement('div');document.body.append(mount);
  const v=new EditorView(mount,{state:EditorState.create({schema,plugins:[ySyncPlugin(d.getXmlFragment('prosemirror')),yUndoPlugin()]}),dispatchTransaction(tr){this.updateState(this.state.apply(tr));}});
  const initial=v.state.doc.toJSON();v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc,10)));const tr=v.state.tr.insertText('X'),typed=tr.doc.toJSON();v.dispatch(tr);
  const states=[];
  const snap=label=>{const bytes=Y.encodeStateAsUpdate(d),fresh=new Y.Doc();Y.applyUpdate(fresh,bytes);const s={label,pm:v.state.doc.toJSON(),projection:project(fresh),markdown:wasm.markdownFromUpdate(bytes),binary:Buffer.from(bytes).toString('base64')};fresh.destroy();states.push(s);return s;};
  snap('typed');const cycles=[];
  for(let i=0;i<3;i++){assert.ok(undo(v.state));const u=snap('undo-'+i);assert.ok(redo(v.state));const r=snap('redo-'+i);cycles.push({undoExact:eq(u.pm,initial),redoExact:eq(r.pm,typed),projectionExact:eq(r.pm,r.projection)});}
  const row={shape,cycles,initialExpected:initial,typedExpected:typed,states};out('single-'+shape+'.json',row);singles.push(row);console.log('single',JSON.stringify({shape,cycles}));
  v.destroy();d.destroy();mount.remove();
  if(shape==='actual-native-contiguous')assert.ok(cycles.every(c=>c.undoExact&&c.redoExact&&c.projectionExact));
  else assert.ok(cycles.every(c=>!c.redoExact&&c.projectionExact),'original content divergence detector must fail all three Redos');
 }
 const positive=rows.filter(r=>r.shape==='actual-native-contiguous'),negative=rows.filter(r=>r.shape==='original-fragmented-negative');
 assert.equal(positive.filter(r=>r.pass).length,11);
 assert.equal(negative.filter(r=>!r.olderHistoryExact).length,10,'old raw fragmented control must fail content, not setup');
 const summary={positiveCases:positive.length,positivePassed:positive.filter(r=>r.pass).length,negativeCases:negative.length,negativeOlderContentFailures:negative.filter(r=>!r.olderHistoryExact).length,singleActualRedoPassed:singles[0].cycles.filter(c=>c.redoExact).length,singleOriginalRedoFailures:singles[1].cycles.filter(c=>!c.redoExact).length,boundary:'installed PM/Yjs binding in jsdom; actual native rebuilt WASM; fresh binary Y.Doc, not durable browser/server reopen',evidence};
 out('summary.json',summary);console.log(JSON.stringify(summary));
} finally { await vite.close();dom.window.close(); }
