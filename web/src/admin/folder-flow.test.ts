// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
const html=readFileSync("add-vault.html","utf8");
const state={location_root:true,registration:"available",selectable:false,browsable:true};
const eligible={...state,location_root:false,selectable:true},token="a".repeat(64);
const previewResponse={confirmation:token,expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true};
let destroy=():void=>{};
afterEach(()=>{destroy();vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
function button(text:string):HTMLButtonElement {const b=[...document.querySelectorAll("button")].find(b=>b.textContent===text);if(!b)throw new Error(`missing ${text}`);return b;}
function input(id:string,value:string):void {const i=document.querySelector<HTMLInputElement>(`#${id}`);if(!i)throw new Error(id);i.value=value;i.dispatchEvent(new Event("input",{bubbles:true}));}
function submit():void {document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));}
function response(value:unknown,status=200):Response {return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});}
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");};const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function selected(mode:"existing"|"new"="existing",boundary?:(url:string,init?:RequestInit)=>Promise<Response>,folderName="Design: %2e%2e 日本"){
 document.body.innerHTML=new DOMParser().parseFromString(html,"text/html").body.innerHTML;
 const f=vi.fn(async(url:string,init?:RequestInit)=>{
  if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:"Projects"}]});
  if(url.includes("/directories?")){const path=new URL(url,"http://localhost").searchParams.get("path")??"";return response({path,state:path===""?state:eligible,children:path===""?[{name:"日本: 100%",path:"日本: 100%",state:eligible}]:[]});}
  if(url.endsWith("/directories"))return response({path:folderName,created:true,directory_synced:true},201);
  if(boundary)return boundary(url,init);
  if(url.endsWith("/preview"))return response(previewResponse);
  if(url.endsWith("/register")){const s=JSON.parse(String(init?.body)) as {slug:string};return response({slug:s.slug,committed:true,directory_synced:false,audit_recorded:false,watched:true,index_ready:true,index_storage:"memory_until_restart"},201);}
  if(url.endsWith("/vaults"))return response([]);throw new Error("unexpected route");
 });
 vi.stubGlobal("fetch",f);const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);
 button("Choose folder").click();await vi.waitFor(()=>expect(button("日本: 100%")).toBeDefined());
 if(mode==="existing"){button("日本: 100%").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));}
 else{button("Add folder here").click();input("directory-name",folderName);document.querySelector("#create-directory")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(folderName));}
 button("Use this folder").click();input("directory-name","Design: %2e%2e 日本");input("vault-name"," Project 日本 ");return f;
}
const layoutRefusal={error:"permission_layout_conflict",guidance:"Select the intended note root or resolve the policy layout outside Memberberry before adopting this folder."};
for(const phase of ["preview","register"] as const){test(`S2 verified layout refusal at ${phase} is known precommit, not uncertain across remount`,async()=>{
 const f=await selected("existing",async u=>u.endsWith("/preview")&&phase==="register"?response(previewResponse):response(layoutRefusal,409));submit();
 await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toMatch(/intended note root|policy layout/));
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(document.body.textContent).not.toContain("may already be committed");expect(button("Create vault").disabled).toBe(false);
 expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(phase==="register"?1:0);
 expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe("Design: %2e%2e 日本");
 const root=document.querySelector<HTMLElement>("#folder-vault");if(root===null)throw new Error("root");destroy();destroy=mountFolderVault(root);
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(document.querySelector("#selected-path")?.textContent).toBe("No folder selected");expect(button("Choose folder").disabled).toBe(false);expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");
 const before=f.mock.calls.length;submit();expect(f.mock.calls).toHaveLength(before);
 // A no-folder submit now leaves via the native managed POST; jsdom cannot navigate.
 destroy();destroy=mountFolderVault(root);
 button("Choose folder").click();await vi.waitFor(()=>expect(button("日本: 100%")).toBeDefined());button("日本: 100%").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Use this folder").click();submit();await vi.waitFor(()=>expect(f.mock.calls.filter(([u])=>u.endsWith("/preview"))).toHaveLength(2));
});}
test("S2 malformed layout guidance after valid preview retains true sent uncertainty",async()=>{
 const f=await selected("existing",async u=>u.endsWith("/preview")?response(previewResponse):response({...layoutRefusal,guidance:"/private/diagnostic"},409));submit();await vi.waitFor(()=>expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown"));expect(document.body.textContent).not.toContain("/private");expect(button("Create vault").disabled).toBe(true);submit();expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(1);
});
test("one submit previews exact generated existing JSON and consumes one identical receipt",async()=>{
 const f=await selected();expect(f.mock.calls.filter(([u])=>u.endsWith("/preview"))).toHaveLength(0);submit();submit();await vi.waitFor(()=>expect(document.querySelector("#result-heading")?.textContent).toBe("Vault registered"));
 const p=JSON.parse(String(f.mock.calls.find(([u])=>u.endsWith("/preview"))?.[1]?.body)) as Record<string,unknown>;
 expect(p).toEqual({mode:"existing",path:"日本: 100%",slug:expect.stringMatching(/^project-[a-f0-9]{12}$/),name:" Project 日本 "});
 const posts=f.mock.calls.filter(([u])=>u.endsWith("/register"));expect(posts).toHaveLength(1);expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({...p,confirmation:token});
 expect(document.querySelector("#secondary-outcomes")?.textContent).toContain("Directory sync not confirmed");expect(document.querySelector("#secondary-outcomes")?.textContent).toContain("Audit append not recorded");expect(document.querySelector<HTMLDetailsElement>("#outcome-details")?.open).toBe(false);
 await vi.waitFor(()=>expect(document.querySelector("#content-access")?.textContent).toContain("does not grant content access"));expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);
});
test("new mode sends exact parent and literal name, never auto-adopts collision",async()=>{
 const f=await selected("new",async()=>response({error:"confirmation_conflict"},409));submit();await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("collision"));
 expect(JSON.parse(String(f.mock.calls.find(([u])=>u.endsWith("/preview"))?.[1]?.body))).toEqual({mode:"existing",path:"Design: %2e%2e 日本",slug:expect.stringMatching(/^project-[a-f0-9]{12}$/),name:" Project 日本 "});
 expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe("Design: %2e%2e 日本");expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");expect(document.querySelector("#selected-path")?.textContent).toContain(JSON.stringify("Design: %2e%2e 日本"));expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);
});
for(const error of ["busy","limit_exceeded","storage_unavailable","invalid_request","cleanup_incomplete","confirmation_conflict","<img src=x onerror=alert(1)> /secret/config"]){
 test(`preview error ${error} preserves exact context without reflecting messages`,async()=>{
  const statuses:Record<string,number>={busy:429,limit_exceeded:422,invalid_request:400,confirmation_conflict:409};const f=await selected("existing",async()=>response({error},statuses[error]??503));submit();await vi.waitFor(()=>expect(document.querySelector("#message")?.getAttribute("role")).toBe("alert"));
  expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");expect(document.querySelector("#selected-path")?.textContent).toContain("日本: 100%");expect(document.body.textContent).not.toContain("/secret/config");expect(document.querySelector("img")).toBe(null);expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);expect(document.querySelector("#confirmation")).toBeNull();
 });
}
test("malformed complete preview schema never dispatches registration",async()=>{const f=await selected("existing",async()=>response({...previewResponse,read_only:true}));submit();await vi.waitFor(()=>expect(document.querySelector("#message")?.getAttribute("role")).toBe("alert"));expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);});
for(const change of ["label","folder-name","mode","picker","cancel"] as const){test(`${change} aborts and fences an older automatic validation`,async()=>{
 const late=deferred<Response>(),f=await selected("existing",()=>late.promise);vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});submit();const request=f.mock.calls.find(([u])=>u.endsWith("/preview"));
 if(change==="label")input("vault-name","Changed");else if(change==="folder-name")input("directory-name","Changed");else button(change==="mode"||change==="picker"?"Choose folder":"Cancel validation").click();
 late.resolve(response(previewResponse));await vi.advanceTimersByTimeAsync(0);expect(request?.[1]?.signal?.aborted).toBe(true);expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);expect(document.querySelector("#confirmation")).toBeNull();
});}
test("expired automatic preview cannot register and keeps exact fields",async()=>{
 const late=deferred<Response>(),f=await selected("existing",()=>late.promise);vi.useFakeTimers({toFake:["setTimeout","clearTimeout","performance"]});submit();await vi.advanceTimersByTimeAsync(120_001);late.resolve(response(previewResponse));await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector("#message")?.textContent).toContain("expired");expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");
});
for(const code of ["network","storage_unavailable","not_found","schema"] as const){test(`register ${code} stays uncertain without possibly committed write retry`,async()=>{
 const f=await selected("existing",async u=>{if(u.endsWith("/preview"))return response(previewResponse);if(code==="network")throw new Error("private diagnostic");return code==="schema"?response({committed:true},201):response({error:code},code==="not_found"?404:503);});submit();await vi.waitFor(()=>expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown"));expect(document.querySelector("#result-message")?.textContent).toContain("Do not retry");submit();button("Create vault").dispatchEvent(new Event("click"));expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(1);expect(document.body.textContent).not.toContain("private diagnostic");expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(" Project 日本 ");
});}
for(const [error,status] of [["invalid_request",400],["confirmation_conflict",409],["limit_exceeded",422],["busy",429]] as const){test(`verified precommit ${status} permits only a fresh explicit submission with stable slug`,async()=>{
 const f=await selected("existing",async u=>u.endsWith("/preview")?response(previewResponse):response({error},status));submit();await vi.waitFor(()=>expect(document.querySelector("#message")?.getAttribute("role")).toBe("alert"));expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(button("Create vault").disabled).toBe(false);submit();await vi.waitFor(()=>expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(2));const previews=f.mock.calls.filter(([u])=>u.endsWith("/preview"));expect(previews).toHaveLength(2);expect(previews[0]?.[1]?.body).toBe(previews[1]?.[1]?.body);
});}
test("selected target quotes exact whitespace before submission without a manual review stage",async()=>{
 const f=await selected("new",undefined,"  Project 日本  ");expect(document.querySelector("#selected-path")?.textContent).toContain('"  Project 日本  "');expect(f.mock.calls.filter(([u])=>u.endsWith("/preview")||u.endsWith("/register"))).toHaveLength(0);
});
test("BFCache remount retains verified administrative commit without content-access claims or replay",async()=>{
 await selected();submit();await vi.waitFor(()=>expect(document.querySelector("#content-access")?.textContent).toContain("does not grant content access"));destroy();const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);expect(document.querySelector("#outcomes")?.textContent).toBe("");expect(document.querySelector("#content-access")?.textContent).toBe("");expect(button("Create vault").disabled).toBe(true);expect(button("Choose folder").disabled).toBe(true);expect(document.querySelector("#result-heading")?.textContent).toBe("Vault registered");expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);
});
test("BFCache remount keeps typed values but resets stale selection and automatic validation",async()=>{
 const late=deferred<Response>(),f=await selected("new",()=>late.promise);input("vault-name","Exact kept label");submit();destroy();const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});late.resolve(response(previewResponse));await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector<HTMLDialogElement>("#picker")?.open).toBe(false);expect(document.querySelector("#confirmation")).toBeNull();expect(document.querySelector("#selected-path")?.textContent).toBe("No folder selected");expect(document.querySelector("[data-mode]")).toBeNull();expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe("Exact kept label");expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(0);
});
test("BFCache remount retains an authoritative denial and the possibly committed sent selection",async()=>{
 const f=await selected("existing",async u=>u.endsWith("/preview")?response(previewResponse):u.includes("/status?")?response({error:"not_found"},404):response({},503));submit();await vi.waitFor(()=>expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown"));button("Check registration status").click();await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable"));destroy();const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown");expect(document.querySelector("#outcomes")?.textContent).toContain(JSON.stringify("日本: 100%"));expect(document.querySelector("#result-message")?.textContent).toContain("Do not retry");expect([...document.querySelectorAll<HTMLButtonElement>("button")].every(b=>b.disabled)).toBe(true);submit();expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(1);
});
test("BFCache remount of an already-sent write retains unknown exact intent and cannot replay registration",async()=>{
 const late=deferred<Response>(),f=await selected("new",async u=>u.endsWith("/preview")?response(previewResponse):late.promise);
 submit();await vi.waitFor(()=>expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(1));const sent=JSON.parse(String(f.mock.calls.find(([u])=>u.endsWith("/register"))?.[1]?.body)) as {slug:string};
 destroy();const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy=mountFolderVault(root);
 expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown");expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);expect(document.querySelector("#result-message")?.textContent).toContain("Do not retry");expect(document.querySelector("#outcomes")?.textContent).toContain(JSON.stringify("Design: %2e%2e 日本"));expect(document.querySelector("#outcomes")?.textContent).toContain(JSON.stringify(sent.slug));expect(button("Create vault").disabled).toBe(true);expect(button("Choose folder").disabled).toBe(true);expect(document.querySelector("#content-access")?.textContent).toBe("");expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});const before=document.body.innerHTML;late.resolve(response({slug:sent.slug,committed:true,directory_synced:true,audit_recorded:false,watched:true,index_ready:true,index_storage:"memory_until_restart"},201));await vi.advanceTimersByTimeAsync(0);expect(document.body.innerHTML).toBe(before);submit();expect(f.mock.calls.filter(([u])=>u.endsWith("/register"))).toHaveLength(1);
});
test("teardown aborts pending preview, removes listeners and prevents detached publication",async()=>{
 const events=vi.spyOn(EventTarget.prototype,"addEventListener"),late=deferred<Response>(),f=await selected("existing",()=>late.promise);vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});submit();const request=f.mock.calls.find(([u])=>u.endsWith("/preview"));const anchor=document.querySelector<HTMLAnchorElement>("a");anchor?.focus();const focus=document.activeElement;destroy();const before=document.body.innerHTML;late.resolve(response(previewResponse));await vi.advanceTimersByTimeAsync(0);expect(request?.[1]?.signal?.aborted).toBe(true);expect(document.body.innerHTML).toBe(before);expect(document.activeElement).toBe(focus);
 const signals=events.mock.calls.flatMap((args,index)=>{const options=args[2];return events.mock.contexts[index] instanceof HTMLElement&&typeof options==="object"&&options!==null&&options.signal!==undefined?[options.signal]:[];});expect(signals.length).toBeGreaterThan(0);expect(signals.every(s=>s.aborted)).toBe(true);button("Choose folder").click();expect(f.mock.calls.filter(([u])=>u.endsWith("/vault-locations"))).toHaveLength(1);
});
