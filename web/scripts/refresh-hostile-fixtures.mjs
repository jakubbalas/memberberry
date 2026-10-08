import {Doc,XmlElement,XmlText,applyUpdate,encodeStateAsUpdate,encodeStateVector} from 'yjs';
// TEST ONLY: clone saved live bytes, never mutate the browser binding.
export function hostileFrame(before,kind,note){
 const d=new Doc();applyUpdate(d,Buffer.from(before.yjsUpdateHex,'hex'));const v=encodeStateVector(d),p=d.getXmlFragment('prosemirror').get(1),text=p.get(0);
 if(kind==='unknown-attribute')p.setAttribute('future_attr','hostile');
 else if(kind==='unknown-mark')text.format(0,1,{future_mark:{}});
 else if(kind==='code-namespace-pair')text.format(0,1,{code:{}});
 else if(kind==='pending-struct'){
  const missing=new Doc(),node=new XmlElement('paragraph'),t=new XmlText();node.insert(0,[t]);t.insert(0,'A');missing.getXmlFragment('prosemirror').insert(0,[node]);const vector=encodeStateVector(missing);t.insert(1,'B');const payload=encodeStateAsUpdate(missing,vector);missing.destroy();d.destroy();return frame(payload,note);
 }else throw Error('Unknown hostile test case');
 const payload=encodeStateAsUpdate(d,v);d.destroy();return frame(payload,note);
}
// Exact production framing (sync.ts:529), with explicit big-endian u16 fields.
function frame(payload,note){const vault=Buffer.from('personal'),name=Buffer.from(note+'.md'),header=Buffer.alloc(5);header[0]=2;header.writeUInt16BE(vault.length,1);header.writeUInt16BE(name.length,3);return Buffer.concat([header,vault,name,payload]);}
