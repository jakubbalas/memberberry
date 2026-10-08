// Test-only READ-ONLY observer using installed public Yjs APIs.
import {encodeStateAsUpdate} from 'yjs';
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
function value(v){if(v instanceof ArrayBuffer)return {arrayBuffer:hex(new Uint8Array(v))};if(ArrayBuffer.isView(v))return {typed:v.constructor.name,hex:hex(new Uint8Array(v.buffer,v.byteOffset,v.byteLength))};if(v===undefined)return {undefined:true};if(v===null||typeof v!=='object')return v;if(Array.isArray(v))return v.map(value);return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,value(x)]));}
const dbs=new Map();
export async function snapshot(){
 const editor=document.querySelector('.editor-surface .tiptap')?.editor;
 if(!editor)throw Error('Actual routed Editor absent');
 const plugin=editor.state.plugins.find(p=>p.key.startsWith('y-sync$'));if(!plugin)throw Error('Installed public ySync plugin absent');
 const sync=plugin.getState(editor.state);const doc=sync.doc;if(!doc)throw Error('Actual public binding doc absent');
 const storage={};for(const info of await indexedDB.databases()){
  if(!dbs.has(info.name)){const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onupgradeneeded=()=>reject(Error('Observer attempted creation'));});dbs.set(info.name,db);}
  const db=dbs.get(info.name);const stores={};for(const name of db.objectStoreNames){stores[name]=await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),s=tx.objectStore(name),keys=s.getAllKeys(),rows=s.getAll();tx.oncomplete=()=>resolve({keys:value(keys.result),rows:value(rows.result)});tx.onerror=()=>reject(tx.error);});}storage[info.name]={version:db.version,stores};
 }
 return {pm:editor.getJSON(),yjsUpdateHex:hex(encodeStateAsUpdate(doc)),yjsFragment:sync.type.toString(),storage,source:Array.from(document.querySelectorAll('textarea.source-view'),el=>({value:el.value,hidden:el.hidden,disabled:el.disabled})),linkInputs:Array.from(document.querySelectorAll('.selection-link-editor input'),el=>({label:el.getAttribute('aria-label'),value:el.value,disabled:el.disabled,hidden:el.closest('form').hidden})),connection:Array.from(document.querySelectorAll('.connection-status'),el=>({text:el.textContent,hidden:el.hidden})),statuses:Array.from(document.querySelectorAll('[role=status],[role=alert]'),el=>({text:el.textContent,hidden:el.hidden})),buttons:Array.from(document.querySelectorAll('button'),el=>({text:el.textContent,label:el.getAttribute('aria-label'),disabled:el.disabled})),bodyText:document.body.innerText};
}
