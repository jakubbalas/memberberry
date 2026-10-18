import { Buffer } from "node:buffer";
import { expect, test, vi, afterEach } from "vitest";
import fc from "fast-check";
import { readFolderListing } from "./folder-listing.js";
import { FolderBrowser } from "./folder-browser.svelte.js";
afterEach(()=>vi.unstubAllGlobals());
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");},reject=(_v:Error):void=>{throw new Error("uninitialized");};const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function response(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
const good={path:" 日本: %2e%2e ",folders:[{name:"Sub",path:" 日本: %2e%2e /Sub"}],files:[{name:"Exact.md",path:" 日本: %2e%2e /Exact.md"}]};
// why: every generated case contains the BMP/astral discriminator, not just a chance of it.
const literalNames = fc.uniqueArray(
 fc.constantFrom(" 日本 ", "%2e%2e", "é", "é", "A", "مجلد"), {maxLength:6},
).map(names => ["\uE000", "📚", ...names]);
// why: Node's byte oracle is independent of the production TextEncoder/comparison loop.
function utf8Ordered(names:readonly string[]):string[]{
 return [...names].sort((a,b)=>Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8")));
}
test("literal names/order/immediate path roundtrip (seed 6006)",()=>{
 fc.assert(fc.property(literalNames,names=>{
  const entries=utf8Ordered(names).map(name=>({name,path:`${good.path}/${name}`}));
  const listing={path:good.path,folders:entries,files:[]};
  expect(readFolderListing(listing,good.path)).toEqual(listing);
 }),{seed:6006,numRuns:128});
});
test("literal Markdown names/order/immediate path roundtrip (seed 6007)",()=>{
 fc.assert(fc.property(literalNames,names=>{
  const entries=utf8Ordered(names.map(name=>`${name}.md`)).map(name=>({name,path:`${good.path}/${name}`}));
  const listing={path:good.path,folders:[],files:entries};
  expect(readFolderListing(listing,good.path)).toEqual(listing);
 }),{seed:6007,numRuns:128});
});
for(const field of ["folders","files"] as const){
 // why: fixed wire order is not derived from any comparator; UTF-8 E000 precedes U+1F4DA.
 const names=field==="folders"?["\uE000","📚"]:["\uE000.md","📚.md"];
 const entries=names.map(name=>({name,path:`${good.path}/${name}`}));
 const forward={path:good.path,folders:field==="folders"?entries:[],files:field==="files"?entries:[]};
 test(`${field} accept UTF-8 BMP-before-astral golden`,()=>{
  expect(readFolderListing(forward,good.path)).toEqual(forward);
 });
 test(`${field} refuse reversed astral-before-BMP golden`,()=>{
  expect(()=>readFolderListing({...forward,[field]:[...entries].reverse()},good.path)).toThrow("schema");
 });
}
for(const value of [{...good,body:"private"},{...good,files:[{name:"x.txt",path:`${good.path}/x.txt`}]},{...good,folders:[{name:"Sub",path:`${good.path}/Sub/descendant`}]},{...good,folders:[{name:"B",path:`${good.path}/B`},{name:"A",path:`${good.path}/A`}]},{...good,path:good.path.trim()},{...good,files:Array.from({length:129},(_,i)=>({name:`${i}.md`,path:`${good.path}/${i}.md`}))}])test(`strict shallow listing refuses ${JSON.stringify(value).slice(0,120)}`,()=>expect(()=>readFolderListing(value,good.path)).toThrow());
for(const completion of ["success","network"] as const){for(const order of ["denial-first","completion-first"] as const){test(`older authoritative denial wins ${completion}/${order}, including dispose and remount`,async()=>{
 const old=deferred<Response>(),newer=deferred<Response>();let calls=0;vi.stubGlobal("fetch",vi.fn(()=>++calls===1?old.promise:newer.promise));const view=new FolderBrowser();const one=view.navigate("personal",good.path);view.dispose();const two=view.navigate("personal",good.path);
 const complete=()=>{if(completion==="success")newer.resolve(response(good));else newer.reject(new Error("private diagnostic"));};
 if(order==="denial-first"){old.resolve(response({error:"not_found"},404));await one;complete();}else{complete();await two;old.resolve(response({error:"not_found"},404));}await Promise.all([one,two]);expect(view.listing).toBeUndefined();expect(view.loading).toBe(false);expect(view.error).toContain("unavailable");expect(view.error).not.toContain("private");
 vi.stubGlobal("fetch",vi.fn(async()=>response(good)));await view.navigate("personal",good.path);expect(view.listing).toEqual(good);view.dispose();
});}}
