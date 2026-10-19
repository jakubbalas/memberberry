// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
const html=readFileSync("add-vault.html","utf8"),state={location_root:true,registration:"available",selectable:false,browsable:true};
const parent=" Parent 日本 ",directory="  Child: %2e%2e 日本  ";
let dispose=():void=>{};
afterEach(()=>{dispose();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
function button(name:string):HTMLButtonElement{const b=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()===name);if(b===undefined)throw new Error(name);return b;}
function response(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");},reject=(_v:Error):void=>{throw new Error("uninitialized");};const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function input(id:string,value:string):void{const i=document.querySelector<HTMLInputElement>(`#${id}`);if(i===null)throw new Error(id);i.value=value;i.dispatchEvent(new Event("input"));}
async function setup(write:()=>Promise<Response>,holdRead?:ReturnType<typeof deferred<Response>>){
 let dirs=0;const f=vi.fn(async(u:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(u);if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:" Projects 日本 "}]});
  if(url.includes("/directories?")){if(++dirs===1&&holdRead!==undefined)return holdRead.promise;const path=new URL(url,"http://localhost").searchParams.get("path")??"";return response({path,state:path===""?state:{...state,location_root:false,selectable:true},children:path===""?[{name:parent,path:parent,state:{...state,location_root:false,selectable:true}}]:[]});}
  if(init?.method==="POST")return write();throw new Error("unexpected request");
 });
 document.body.innerHTML=new DOMParser().parseFromString(html,"text/html").body.innerHTML;vi.stubGlobal("fetch",f);const root=document.querySelector<HTMLElement>("#folder-vault");if(root===null)throw new Error("root");dispose=mountFolderVault(root);button("Choose folder").click();
 if(holdRead!==undefined){await vi.waitFor(()=>expect(dirs).toBe(1));button("Refresh folders").dispatchEvent(new Event("click"));}
 await vi.waitFor(()=>expect(button(parent.trim())).toBeDefined());button(parent.trim()).click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Add folder here").click();input("directory-name",directory);input("vault-name"," Exact label ");
 return {f,root};
}
function submit():void{document.querySelector("#create-directory")?.dispatchEvent(new Event("submit",{cancelable:true}));}
test("explicit mkdir immediately sends exact parent/name once and navigates verified creation, without registration",async()=>{
 const {f}=await setup(async()=>response({path:`${parent}/${directory}`,created:true,directory_synced:false},201));expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(0);submit();submit();
 await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(directory));expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
 expect(f.mock.calls.find(([,i])=>i?.method==="POST")?.[1]).toMatchObject({body:JSON.stringify({path:parent,directory}),credentials:"same-origin",cache:"no-store"});
 button("Cancel").click();expect(document.querySelector("#selected-path")?.textContent).toBe("No folder selected");expect(f.mock.calls.some(([u])=>String(u).includes("/register"))).toBe(false);
});
test("verified collision keeps the original parent and name without adopting the existing child",async()=>{
 const {f}=await setup(async()=>response({error:"confirmation_conflict"},409));submit();await vi.waitFor(()=>expect(document.querySelector("#picker-message")?.textContent).toContain("collision"));expect(document.querySelector("#picker-heading")?.textContent).toBe(parent);expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe(directory);expect(f.mock.calls.filter(([u])=>String(u).includes(encodeURIComponent(directory)))).toHaveLength(0);
});
for(const completion of ["success","network","authority","schema"] as const){for(const order of ["denial-first","completion-first"] as const){
 if(completion==="success"&&order==="completion-first")continue;
 test(`sent mkdir survives older denial, ${completion}/${order}, remount and no replay`,async()=>{
  const old=deferred<Response>(),late=deferred<Response>(),{f,root}=await setup(()=>late.promise,old);submit();await vi.waitFor(()=>expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1));vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const complete=()=>{if(completion==="network")late.reject(new Error("private diagnostic"));else late.resolve(completion==="success"?response({path:`${parent}/${directory}`,created:true,directory_synced:true},201):completion==="authority"?response({error:"not_found"},404):response({created:true},201));};
  if(order==="denial-first"){old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);complete();}else{complete();await vi.advanceTimersByTimeAsync(0);old.resolve(response({error:"not_found"},404));}await vi.advanceTimersByTimeAsync(0);
  const assert=()=>{expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable");expect(document.querySelector("#mkdir-message")?.textContent).toContain("Do not retry");for(const s of [parent,directory," Projects 日本 ","projects"])expect(document.querySelector("#mkdir-intent")?.textContent).toContain(JSON.stringify(s));expect(button("Create vault").disabled).toBe(true);expect(document.body.textContent).not.toContain("private diagnostic");};
  assert();dispose();dispose=mountFolderVault(root);assert();const count=f.mock.calls.length;for(const b of root.querySelectorAll("button"))b.dispatchEvent(new Event("click"));submit();root.querySelector("#details")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.advanceTimersByTimeAsync(0);expect(f.mock.calls).toHaveLength(count);
 });
}}
test("teardown retains unknown sent mkdir and a disposed read denial fences the remounted controls",async()=>{
 const old=deferred<Response>(),late=deferred<Response>(),{f,root}=await setup(()=>late.promise,old);submit();await vi.waitFor(()=>expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1));dispose();dispose=mountFolderVault(root);vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);expect(button("Choose folder").disabled).toBe(true);const before=root.innerHTML;late.resolve(response({path:`${parent}/${directory}`,created:true,directory_synced:true},201));await vi.advanceTimersByTimeAsync(0);expect(root.innerHTML).toBe(before);expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
});

test("sent mkdir network uncertainty without denial survives remount and disabled dispatch never replays it",async()=>{
 const {f,root}=await setup(async()=>{throw new Error("lost response");});submit();await vi.waitFor(()=>expect(document.querySelector("#mkdir-message")?.textContent).toContain("Do not retry"));dispose();dispose=mountFolderVault(root);expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe(directory);button("Choose folder").click();await vi.waitFor(()=>expect(button(parent.trim())).toBeDefined());button(parent.trim()).click();await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(parent));button("Add folder here").dispatchEvent(new Event("click"));submit();root.querySelector("#details")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector("#mkdir-message")?.textContent).toContain("Do not retry"));expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
});
test("disposed setup listeners and rows issue no requests",async()=>{
 const {f,root}=await setup(async()=>response({path:`${parent}/${directory}`,created:true,directory_synced:true},201));dispose();const calls=f.mock.calls.length;for(const b of root.querySelectorAll("button"))b.dispatchEvent(new Event("click"));for(const i of root.querySelectorAll("input"))i.dispatchEvent(new Event("input"));submit();root.querySelector("#details")?.dispatchEvent(new Event("submit",{cancelable:true}));expect(f.mock.calls).toHaveLength(calls);
});

test("an older denial after verified mkdir success clears rows without fabricating uncertainty or replay",async()=>{
 const old=deferred<Response>(),{f,root}=await setup(async()=>response({path:`${parent}/${directory}`,created:true,directory_synced:true},201),old);submit();await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(directory));old.resolve(response({error:"not_found"},404));await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable"));expect(document.querySelector("#directories")?.childElementCount).toBe(0);expect(document.querySelector<HTMLElement>("#mkdir-outcome")?.hidden).toBe(true);dispose();dispose=mountFolderVault(root);expect(button("Choose folder").disabled).toBe(true);expect(document.querySelector<HTMLElement>("#mkdir-outcome")?.hidden).toBe(true);expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
});
