import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
const evidence=process.env.MB_TITLE_EVIDENCE;
assert(evidence && path.isAbsolute(evidence) && fs.statSync(evidence).isDirectory());
const glue=fs.readFileSync('src/wasm/mb.js','utf8');
const wasm=await import('data:text/javascript;base64,'+Buffer.from(glue).toString('base64')+'#title-probe');
await wasm.default({module_or_path:fs.readFileSync('src/wasm/mb_bg.wasm')});
const doc=new Y.Doc(),p=new Y.XmlElement('paragraph'),t=new Y.XmlText();
doc.getXmlFragment('prosemirror').insert(0,[p]);p.insert(0,[t]);
t.insert(0,'literal',{code:{},link:{href:'https://example.org',title:''}});
const bytes=Y.encodeStateAsUpdate(doc);
const markdown=wasm.markdownFromUpdate(bytes);
const reopened=wasm.updateFromMarkdown(markdown);
const reopenedMarkdown=wasm.markdownFromUpdate(reopened);
const reopenedDoc=new Y.Doc();Y.applyUpdate(reopenedDoc,reopened);
const rows={markdown,reopenedMarkdown,delta:reopenedDoc.getXmlFragment('prosemirror').toArray()[0].toArray()[0].toDelta(),updateHex:Buffer.from(bytes).toString('hex')};
fs.writeFileSync(path.join(evidence,'wasm-original.json'),JSON.stringify(rows,null,2));
assert.equal(reopenedMarkdown,markdown,'explicit empty title must survive actual WASM Markdown reopen');
assert.equal(rows.delta[0].attributes.link.title,'');
console.log('1 actual WASM exact-empty-title case passed');

const parity=[];
for (const fixture of JSON.parse(fs.readFileSync(path.join(evidence,'native-titles.json')))) {
 const raw=Buffer.from(fixture.updateHex,'hex');
 assert.equal(wasm.markdownFromUpdate(raw),fixture.markdown,fixture.id);
 for (const [kind,source] of [['inline',fixture.markdown],['reference',fixture.reference]]) {
  const update=wasm.updateFromMarkdown(source);
  const markdown=wasm.markdownFromUpdate(update);
  assert.equal(markdown,fixture.markdown,`${fixture.id} ${kind}`);
  const doc=new Y.Doc();Y.applyUpdate(doc,update);
  const delta=doc.getXmlFragment('prosemirror').toArray()[0].toArray()[0].toDelta();
  assert.equal(delta.map(d=>d.insert).join(''),fixture.literal);
  for(const run of delta) {
   if(fixture.title===null) assert(run.attributes.link.title==null);
   else assert.equal(run.attributes.link.title,fixture.title);
   assert.equal(run.attributes.link.href,'https://example.org/a?x=()&q=""');
   assert.equal(Object.hasOwn(run.attributes,'code'),fixture.code);
  }
  assert.equal(wasm.markdownFromUpdate(wasm.updateFromMarkdown(markdown)),markdown);
  parity.push({id:`${fixture.id}-${kind}`,markdown,delta}); doc.destroy();
 }
}
fs.writeFileSync(path.join(evidence,'wasm-title-parity.json'),JSON.stringify(parity,null,2));
assert.equal(parity.length,20);
console.log(JSON.stringify({original:1,titleBoundaryCases:parity.length,passed:true}));
