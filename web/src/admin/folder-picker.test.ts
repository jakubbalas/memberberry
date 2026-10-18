// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
const html=readFileSync("add-vault.html","utf8");
const rootState={location_root:true,registration:"available",selectable:false,browsable:true};
const eligible={...rootState,location_root:false,selectable:true};
let destroy=():void=>{};
afterEach(()=>{destroy();vi.restoreAllMocks();vi.unstubAllGlobals();document.body.replaceChildren();});
function button(text:string):HTMLButtonElement {const b=[...document.querySelectorAll("button")].find(b=>b.textContent===text);if(!b)throw new Error(`missing ${text}`);return b;}
function input(id:string,text:string):void {const e=document.querySelector<HTMLInputElement>(`#${id}`);if(!e)throw new Error(id);e.value=text;e.dispatchEvent(new Event("input",{bubbles:true}));}
function reply(value:unknown,status=200):Response {return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});}
function mount(){
 // External jsdom platform shim only; native focus containment/Escape are proved in Playwright.
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.open=true;});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.open=false;});
 document.body.innerHTML=new DOMParser().parseFromString(html,"text/html").body.innerHTML;
 const f=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith("/vault-locations"))return reply({locations:[{id:"projects",name:"Projects"},{id:"other",name:"Other"}]});
  if(url.includes("/directories?")){const path=new URL(url,"http://localhost").searchParams.get("path")??"";return reply({path,state:path===""?rootState:eligible,children:path===""?[{name:"日本: 100%",path:"日本: 100%",state:eligible}]:[]});}
  const s=JSON.parse(String(init?.body)) as {slug:string};
  if(url.endsWith("/preview"))return reply({confirmation:"a".repeat(64),expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true});
  if(url.endsWith("/register"))return reply({slug:s.slug,committed:true,directory_synced:true,audit_recorded:false,watched:true,index_ready:true,index_storage:"memory_until_restart"},201);
  return reply([]);
 });
 vi.stubGlobal("fetch",f);const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);return f;
}
// jsdom has no native dialog implementation; define its platform methods, not application behavior.
Object.defineProperties(HTMLDialogElement.prototype,{showModal:{configurable:true,value(){throw new Error("unshimmed native dialog");}},close:{configurable:true,value(){throw new Error("unshimmed native dialog");}}});
test("compact form opens plain-name dialog, cancellation keeps selection and restores opener focus without writes",async()=>{
 const f=mount();expect(document.querySelector<HTMLInputElement>("#vault-slug")?.value).toBe("");expect(document.body.textContent).not.toContain("Check storage and review");
 button("Choose folder").click();await vi.waitFor(()=>expect(button("日本: 100%")).toBeDefined());expect(document.querySelector<HTMLDialogElement>("#picker")?.open).toBe(true);expect(document.querySelector("#directories")?.textContent).not.toContain("Available");
 button("日本: 100%").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Use this folder").click();const selection=document.querySelector("#selected-path")?.textContent;
 button("Choose folder").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));const location=document.querySelector<HTMLSelectElement>("#location");if(!location)throw new Error("location");location.value="other";location.dispatchEvent(new Event("change"));await vi.waitFor(()=>expect(button("日本: 100%")).toBeDefined());button("Cancel").click();expect(document.querySelector("#selected-path")?.textContent).toBe(selection);expect(document.activeElement).toBe(button("Choose folder"));expect(f.mock.calls.every(([,init])=>init?.method!=="POST")).toBe(true);
});
test("one Add vault automatically previews and registers identical generated intent once",async()=>{
 const f=mount();input("vault-name"," Exact 日本 ");button("Choose folder").click();await vi.waitFor(()=>expect(button("日本: 100%")).toBeDefined());button("日本: 100%").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Use this folder").click();
 document.querySelector("#details")?.dispatchEvent(new Event("submit",{cancelable:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector("#result-heading")?.textContent).toBe("Vault registered"));
 const posts=f.mock.calls.filter(([,init])=>init?.method==="POST");expect(posts).toHaveLength(2);const p=JSON.parse(String(posts[0]?.[1]?.body)) as Record<string,unknown>;expect(p).toEqual({mode:"existing",path:"日本: 100%",name:" Exact 日本 ",slug:expect.stringMatching(/^exact-[a-f0-9]{12}$/)});expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({...p,confirmation:"a".repeat(64)});expect(document.querySelector("#confirmation")).toBeNull();
});
