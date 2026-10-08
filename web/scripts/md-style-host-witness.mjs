import {expect} from '@playwright/test';
// Independent manual targets copied from the existing finite design-token contract.
export const palette=['gray','brown','orange','yellow','green','blue','purple','pink','red'];
const light=['#62625f','#795548','#9a4f0a','#806000','#2f6b39','#305ca8','#7042a0','#953e70','#a52016'];
const lightBG=['#e7e7e5','#f1e5df','#fae6d4','#f5edc9','#e0efdf','#dde8f8','#ece2f6','#f6e2ef','#f8dfdb'];
// Dark targets are bound separately to the reviewed token declarations, not to observed CSS.
const dark=['#b5b5b0','#d6ac91','#f0ae72','#dec974','#91c79a','#a2bdf2','#c4a2ef','#e5a8ce','#f2a09a'];
const darkBG=['#353537','#493a33','#4d3729','#454025','#2f4134','#2d3a50','#3e3151','#4b3143','#4c3230'];
const rgb=hex=>{const x=Number.parseInt(hex.slice(1),16);return `rgb(${x>>16}, ${(x>>8)&255}, ${x&255})`;};
export const paletteMarkdown='# Palette\n\n'+palette.map(c=>`:mb-style[==${c}==]{underline="true" color="${c}" background="${c}" size="large"}`).join('\n\n')+'\n\n:mb-style[small]{size="small"}\n';
export async function combined(p,prefix='.editor-surface',theme='light') {
 const r=await p.evaluate(prefix=>{
  const root=document.querySelector(prefix),u=root?.querySelector('.mb-underline'),b=root?.querySelector('.mb-background-yellow'),s=root?.querySelector('.mb-size-large'),c=root?.querySelector('.mb-color-red');
  if(!root||!u||!b||!s||!c)throw Error('missing combined namespace marks');
  const leaf=s.querySelector('a')??s;const v=getComputedStyle(leaf),base=getComputedStyle(s.closest('p'));
  return {underline:getComputedStyle(u).textDecorationLine,color:v.color,background:getComputedStyle(b).backgroundColor,size:v.fontSize,base:base.fontSize,html:u.outerHTML};
 },prefix);
 expect(r.underline).toBe('underline');expect(r.color).toBe(rgb((theme==='dark'?dark:light)[8]));expect(r.background).toBe(rgb((theme==='dark'?darkBG:lightBG)[3]));expect(Number.parseFloat(r.size)).toBeGreaterThan(Number.parseFloat(r.base));return r;
}
export async function paletteWitness(p,prefix,theme,portableRules=null) {
 const rows=await p.evaluate(({prefix,palette,portableRules})=>{
  const root=document.querySelector(prefix);if(!root)throw Error('missing host');
  const flatten=rules=>[...rules].flatMap(r=>[r.cssText,...(r.cssRules?flatten(r.cssRules):[])]);
  const css=[...document.styleSheets].flatMap(s=>{try{return flatten(s.cssRules);}catch(e){if(portableRules!==null&&s.href?.startsWith('file:')&&e.name==='SecurityError')return [portableRules];throw e;}}).join('\n');
  return palette.map(name=>{
   const b=root.querySelector('.mb-background-'+name),c=root.querySelector('.mb-color-'+name);if(!b||!c)throw Error('missing palette '+name);
   const mark=b.querySelector('mark')??b.closest('mark');if(!mark)throw Error('missing highlight');
   const parent=b.closest('p'),u=b.closest('.mb-underline'),s=b.querySelector('.mb-size-large')??b.closest('.mb-size-large'),leaf=s.querySelector('mark')??s,v=getComputedStyle(leaf),background=getComputedStyle(b.querySelector('mark')??b),base=getComputedStyle(parent),token=getComputedStyle(document.documentElement);
   return {name,color:v.color,background:background.backgroundColor,underline:getComputedStyle(u).textDecorationLine,size:getComputedStyle(s).fontSize,base:base.fontSize,tokenColor:token.getPropertyValue('--note-color-'+name).trim(),tokenBG:token.getPropertyValue('--note-background-'+name).trim(),rules:['mb-color-'+name,'mb-background-'+name,'mb-size-large','mb-underline'].map(n=>({name:n,present:css.includes('.'+n)}))};
  });
 },{prefix,palette,portableRules});
 for(const [i,r]of rows.entries()){
  expect(r.color,`${prefix}/${theme}/${r.name} text`).toBe(rgb((theme==='dark'?dark:light)[i]));
  expect(r.background,`${prefix}/${theme}/${r.name} background`).toBe(rgb((theme==='dark'?darkBG:lightBG)[i]));
  expect(r.underline).toBe('underline');expect(Number.parseFloat(r.size)).toBeGreaterThan(Number.parseFloat(r.base));for(const q of r.rules)expect(q.present).toBe(true);
 }
 const small=await p.locator(prefix+' .mb-size-small').evaluate(e=>({size:getComputedStyle(e).fontSize,base:getComputedStyle(e.closest('p')).fontSize}));expect(Number.parseFloat(small.size)).toBeLessThan(Number.parseFloat(small.base));return {theme,rows,small};
}
