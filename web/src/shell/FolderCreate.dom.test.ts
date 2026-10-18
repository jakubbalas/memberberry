// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import FolderContents from "./FolderContents.svelte";
import { FolderBrowser } from "./folder-browser.svelte.js";
import { installDialogShim } from "../admin/folder-dialog-test.js";
installDialogShim();
const apps:ReturnType<typeof mount>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await unmount(app);vi.unstubAllGlobals();document.body.replaceChildren();});
const parent=" Parent 日本 ",child=" Child: %2e%2e 日本 ";
function response(value:unknown,status=200):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");},reject=(_e:Error):void=>{throw new Error("uninitialized");};const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
async function render(write:()=>Promise<Response>){
 const f=vi.fn(async(_u:RequestInfo|URL,i?:RequestInit)=>i?.method==="POST"?write():response({path:new URL(String(_u),"http://localhost").searchParams.get("path")??"",folders:[],files:[]}));vi.stubGlobal("fetch",f);
 const browser=new FolderBrowser(),onfolder=vi.fn(),target=document.createElement("div");document.body.append(target);apps.push(mount(FolderContents,{target,props:{path:parent,vault:"fixture",browser,onfolder,onopen:vi.fn(),onclose:vi.fn()}}));
 await vi.waitFor(()=>expect(browser.listing).toBeDefined());await tick();target.querySelector<HTMLButtonElement>(".folder-row")?.click();await tick();const input=target.querySelector<HTMLInputElement>(".rename-input");if(input===null)throw new Error("prompt");input.value=child;input.dispatchEvent(new Event("input",{bubbles:true}));await tick();target.querySelector(".rename-body")?.dispatchEvent(new Event("submit",{cancelable:true}));
 await vi.waitFor(()=>expect(f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1));return {f,browser,onfolder,target};
}
test("an authoritative listing denial aborts a sent folder create and fences late success publication",async()=>{
 const late=deferred<Response>(),view=await render(()=>late.promise);const sent=view.f.mock.calls.find(([,i])=>i?.method==="POST")?.[1];expect(sent?.body).toBe(JSON.stringify({path:`${parent}/${child}`}));view.browser.deny();await tick();late.resolve(response({path:`${parent}/${child}`},200));await vi.waitFor(()=>expect(view.target.querySelector<HTMLButtonElement>(".rename-confirm")?.disabled).toBe(false));expect(view.onfolder).not.toHaveBeenCalled();expect(sent?.signal?.aborted).toBe(true);
});
test("verified exact folder creation navigates once through the in-vault endpoint, never E31",async()=>{
 const view=await render(async()=>response({path:`${parent}/${child}`},200));await vi.waitFor(()=>expect(view.onfolder).toHaveBeenCalledWith(`${parent}/${child}`));expect(view.f.mock.calls.filter(([u,i])=>i?.method==="POST"&&String(u)==="/api/v1/vaults/fixture/folders")).toHaveLength(1);expect(view.f.mock.calls.some(([u])=>String(u).includes("vault-locations"))).toBe(false);
});
test("native prompt focus restoration cannot publish a create after a new authoritative denial",async()=>{
 const late=deferred<Response>(),view=await render(()=>late.promise);const opener=view.target.querySelector<HTMLButtonElement>(".folder-row");if(opener===null)throw new Error("opener");opener.addEventListener("focus",()=>view.browser.deny(),{once:true});late.resolve(response({path:`${parent}/${child}`},200));await vi.waitFor(()=>expect(view.browser.denialRevision).toBe(1));await tick();expect(view.onfolder).not.toHaveBeenCalled();expect(view.browser.listing).toBeUndefined();
});
test("navigation/remount aborts a sent create and a late response cannot reopen its old folder or detached prompt",async()=>{
 const late=deferred<Response>(),view=await render(()=>late.promise),sent=view.f.mock.calls.find(([,i])=>i?.method==="POST")?.[1];const app=apps.pop();if(app===undefined)throw new Error("mounted app");await unmount(app);const detached=view.target.innerHTML;
 const sibling=" Sibling 日本 ",target=document.createElement("div"),onfolder=vi.fn();document.body.append(target);apps.push(mount(FolderContents,{target,props:{path:sibling,vault:"fixture",browser:view.browser,onfolder,onopen:vi.fn(),onclose:vi.fn()}}));await vi.waitFor(()=>expect(view.browser.listing?.path).toBe(sibling));expect(sent?.signal?.aborted).toBe(true);
 const created=response({path:`${parent}/${child}`},200),read=created.json.bind(created),consumed=deferred<unknown>();vi.spyOn(created,"json").mockImplementation(async()=>{const value:unknown=await read();consumed.resolve(value);return value;});late.resolve(created);await consumed.promise;
 // why: finish the real response parser and its queued Svelte/native-focus continuations before asserting no callback; no timed sleep.
 await new Promise<void>(resolve=>setImmediate(resolve));await tick();expect(view.onfolder).not.toHaveBeenCalled();expect(onfolder).not.toHaveBeenCalled();expect(target.querySelector("h1")?.textContent).toBe(sibling);expect(view.target.innerHTML).toBe(detached);expect(view.f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
});
for(const dismissal of ["close","backdrop"] as const){
 test(`S1 ${dismissal} cancels pending publication after real 200 parsing and restores focus`,async()=>{
  const late=deferred<Response>(),view=await render(()=>late.promise),dialog=view.target.querySelector<HTMLDialogElement>("dialog"),opener=view.target.querySelector<HTMLButtonElement>(".folder-row");
  if(dialog===null||opener===null)throw new Error("dialog/opener");await tick();expect(dialog.open).toBe(true);
  if(dismissal==="close"){dialog.close();dialog.dispatchEvent(new Event("close"));}else dialog.click();await tick();expect(dialog.open).toBe(false);
  const actual=response({path:`${parent}/${child}`}),read=actual.json.bind(actual),parsed=deferred<void>();vi.spyOn(actual,"json").mockImplementation(async()=>{const value:unknown=await read();parsed.resolve();return value;});
  late.resolve(actual);await parsed.promise;await new Promise<void>(resolve=>setImmediate(resolve));await tick();
  expect(view.onfolder).not.toHaveBeenCalled();expect(document.activeElement).toBe(opener);expect(view.target.querySelector("h1")?.textContent).toBe(parent);expect(view.f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
 });
}
for(const completion of ["success","network","denial"] as const){
 test(`S1 old dismissed ${completion} cannot close or publish into a newer prompt`,async()=>{
  const late=deferred<Response>(),view=await render(()=>late.promise),dialog=view.target.querySelector<HTMLDialogElement>("dialog");if(dialog===null)throw new Error("dialog");
  await tick();dialog.close();dialog.dispatchEvent(new Event("close"));await tick();const opener=view.target.querySelector<HTMLButtonElement>(".folder-row");expect(opener?.disabled).toBe(false);opener?.click();await tick();
  const next=view.target.querySelector<HTMLDialogElement>("dialog");if(next===null)throw new Error("new prompt");expect(next.open).toBe(true);
  // External response ignores abort; this is a publication test, not a filesystem rollback claim.
  if(completion==="network")late.reject(new Error("private network diagnostic"));else late.resolve(completion==="success"?response({path:`${parent}/${child}`}):response({error:"not_found"},404));
  await new Promise<void>(resolve=>setImmediate(resolve));await tick();expect(view.onfolder).not.toHaveBeenCalled();expect(next.open).toBe(completion!=="denial");expect(view.f.mock.calls.filter(([,i])=>i?.method==="POST")).toHaveLength(1);
 });
}
test("S1 a newer deliberate pending create survives old completion and navigates exactly once",async()=>{
 const old=deferred<Response>(),fresh=deferred<Response>();let writes=0;const view=await render(()=>++writes===1?old.promise:fresh.promise),dialog=view.target.querySelector<HTMLDialogElement>("dialog");if(dialog===null)throw new Error("dialog");
 await tick();dialog.close();dialog.dispatchEvent(new Event("close"));await tick();view.target.querySelector<HTMLButtonElement>(".folder-row")?.click();await tick();
 const input=view.target.querySelector<HTMLInputElement>(".rename-input");if(input===null)throw new Error("input");input.value="Fresh 📚";input.dispatchEvent(new Event("input",{bubbles:true}));await tick();view.target.querySelector(".rename-body")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(writes).toBe(2));
 const parsed=deferred<void>(),actual=response({path:`${parent}/${child}`}),read=actual.json.bind(actual);vi.spyOn(actual,"json").mockImplementation(async()=>{const value:unknown=await read();parsed.resolve();return value;});old.resolve(actual);await parsed.promise;await new Promise<void>(resolve=>setImmediate(resolve));await tick();
 expect(view.target.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);expect(view.target.querySelector<HTMLButtonElement>(".rename-confirm")?.disabled).toBe(true);expect(view.onfolder).not.toHaveBeenCalled();
 fresh.resolve(response({path:`${parent}/Fresh 📚`}));await vi.waitFor(()=>expect(view.onfolder).toHaveBeenCalledWith(`${parent}/Fresh 📚`));expect(view.onfolder).toHaveBeenCalledTimes(1);expect(writes).toBe(2);
});
test("a refused in-vault creation clears rows and does not navigate",async()=>{
 const view=await render(async()=>response({error:"not_found"},404));await vi.waitFor(()=>expect(view.browser.error).toContain("unavailable"));expect(view.browser.listing).toBeUndefined();expect(view.onfolder).not.toHaveBeenCalled();
});
