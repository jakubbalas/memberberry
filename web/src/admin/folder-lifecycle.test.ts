// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
const html=readFileSync("add-vault.html","utf8"),state={location_root:true,registration:"available",selectable:false,browsable:true};
let destroy=():void=>{};
afterEach(()=>{destroy();vi.useRealTimers();vi.unstubAllGlobals();document.body.replaceChildren();});
function button(name:string):HTMLButtonElement {const b=[...document.querySelectorAll("button")].find(b=>b.textContent===name);if(!b)throw new Error(name);return b;}
function response(v:unknown,status=200):Response {return new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json"}});}
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");};let reject=(_e:Error):void=>{throw new Error("uninitialized");};const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function mount(fetcher:typeof fetch):void {document.body.innerHTML=new DOMParser().parseFromString(html,"text/html").body.innerHTML;vi.stubGlobal("fetch",fetcher);const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("fixture");destroy=mountFolderVault(root);}
test("older location success cannot replace newer selected server context",async()=>{
 const late=deferred<Response>();let count=0;
 mount(vi.fn(async u=>{if(String(u).endsWith("/vault-locations")){if(++count===1)return late.promise;return response({locations:[{id:"new-projects",name:"Current projects"}]});}return response({path:"",state,children:[]});}));
 button("Choose folder").click();button("Refresh folders").dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("0 folders found"));
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});late.resolve(response({locations:[{id:"old",name:"Old projects"}]}));await vi.advanceTimersByTimeAsync(0);expect(button("Use this folder").disabled).toBe(true);
 expect(document.querySelector<HTMLSelectElement>("#location")?.value).toBe("new-projects");expect(document.querySelector("#location")?.textContent).toBe("Current projects");
});
test("older directory denial fences a newer pending preview and current session controls",async()=>{
 const old=deferred<Response>(),latePreview=deferred<Response>();let dirs=0;
 mount(vi.fn(async u=>{const url=String(u);if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:"Projects"}]});if(url.includes("/directories?")){if(++dirs===1)return old.promise;const path=new URL(url,"http://localhost").searchParams.get("path")??"";return response({path,state:path===""?state:{...state,location_root:false,selectable:true},children:path===""?[{name:"Child",path:"Child",state:{...state,location_root:false,selectable:true}}]:[]});}return latePreview.promise;}));
 button("Choose folder").click();await vi.waitFor(()=>expect(dirs).toBe(1));button("Refresh folders").dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(button("Child")).toBeDefined());button("Child").click();await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Use this folder").click();
 for(const [id,value] of [["directory-name","日本: %2e%2e"],["vault-name","Exact label"]]){const input=document.querySelector<HTMLInputElement>(`#${id}`);if(!input)throw new Error("input");input.value=value??"";input.dispatchEvent(new Event("input",{bubbles:true}));}
 document.querySelector("form")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));old.resolve(response({error:"not_found"},404));await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable"));
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});latePreview.resolve(response({confirmation:"a".repeat(64),expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true}));await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector("#confirmation")).toBeNull();expect(button("Create vault").disabled).toBe(true);expect(button("Choose folder").disabled).toBe(true);expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe("Exact label");
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(document.body.textContent).not.toContain("Registration may already be committed");
});
for(const order of ["network-first","denial-first"]){test(`older denial wins newer network failure in ${order} order`,async()=>{
 const old=deferred<Response>(),newer=deferred<Response>();let dirs=0;
 mount(vi.fn(async u=>String(u).endsWith("/vault-locations")?response({locations:[{id:"projects",name:"Projects"}]}):++dirs===1?old.promise:newer.promise));
 button("Choose folder").click();await vi.waitFor(()=>expect(dirs).toBe(1));button("Refresh folders").dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(dirs).toBe(2));vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
 if(order==="network-first"){newer.reject(new Error("/private/config"));await vi.advanceTimersByTimeAsync(0);old.resolve(response({error:"not_found"},404));}else{old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);newer.reject(new Error("/private/config"));}await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable");expect(button("Choose folder").disabled).toBe(true);expect(document.body.textContent).not.toContain("/private/config");
});}
for(const mode of ["existing","new"] as const){
 for(const denial of ["preview","older-directory"] as const){
  test(`F1 never-sent ${mode} ${denial} denial resets selection at repeated remount, not active error`,async()=>{
   const path=" Parent 日本 ",directory="  New 日本: %2e%2e  ",name=" Exact label 日本 ",old=deferred<Response>(),validation=deferred<Response>();let dirs=0;
   const selectable={...state,location_root:false,selectable:true};
   const parent=mode==="new"?{...selectable,registration:"contains_registered_vault",selectable:false}:selectable;
   const f=vi.fn(async(u:RequestInfo|URL)=>{
    const url=String(u);
    if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:" Projects  "}]});
    if(url.includes("/directories?")){
     if(denial==="older-directory"&&++dirs===1)return old.promise;
     const requested=new URL(url,"http://localhost").searchParams.get("path")??"";
     return response({path:requested,state:requested===""?state:requested===path?parent:selectable,children:requested===""?[{name:path,path,state:parent}]:[]});
    }
    if(url.endsWith("/directories"))return response({path:`${path}/${directory}`,created:true,directory_synced:true},201);
    if(url.endsWith("/preview"))return validation.promise;
    throw new Error("unexpected request after never-sent denial");
   });
   mount(f);button("Choose folder").click();
   if(denial==="older-directory"){await vi.waitFor(()=>expect(dirs).toBe(1));button("Refresh folders").click();}
   await vi.waitFor(()=>expect(button(path)).toBeDefined());button(path).click();await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(path));if(mode==="new"){button("Add folder here").click();const i=document.querySelector<HTMLInputElement>("#directory-name");if(i===null)throw new Error("input");i.value=directory;document.querySelector("#create-directory")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(directory));}await vi.waitFor(()=>expect(button("Use this folder").disabled).toBe(false));button("Use this folder").click();
   for(const [id,value] of [["directory-name",directory],["vault-name",name]] as const){const i=document.querySelector<HTMLInputElement>(`#${id}`);if(!i)throw new Error("input");i.value=value;i.dispatchEvent(new Event("input",{bubbles:true}));}
   const selected=document.querySelector("#selected-path")?.textContent;
   expect(selected).toContain(path);expect(selected).toContain(JSON.stringify(mode==="new"?`${path}/${directory}`:path));
   document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(f.mock.calls.filter(([u])=>String(u).endsWith("/preview"))).toHaveLength(1));
   vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
   if(denial==="preview")validation.resolve(response({error:"not_found"},404));else old.resolve(response({error:"not_found"},404));
   await vi.advanceTimersByTimeAsync(0);
   const assertNeverSent=():void=>{
    expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable");
    expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(name);expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe(directory);
    expect(document.querySelector("#confirmation")).toBeNull();expect(document.querySelector<HTMLElement>("#cancel-validation")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(document.querySelector("#outcomes")?.textContent).toBe("");expect(document.querySelector("#content-access")?.textContent).toBe("");
    expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);expect(document.querySelector("#open-vault")?.hasAttribute("href")).toBe(false);expect(document.body.textContent).not.toContain("Registration may already be committed");
    for(const c of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button"))expect(c.disabled).toBe(true);
    expect(f.mock.calls.filter(([u])=>String(u).endsWith("/register")||String(u).endsWith("/vaults")||String(u).includes("/status?"))).toHaveLength(0);
   };
   assertNeverSent();expect(document.querySelector("#selected-path")?.textContent).toBe(selected);expect(document.querySelector("[data-mode]")).toBeNull();
   if(denial==="older-directory"){
    validation.resolve(response({confirmation:"a".repeat(64),expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true}));await vi.advanceTimersByTimeAsync(0);assertNeverSent();
   }
   const root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");
   for(const cycle of [1,2,3]){
    destroy();const count=f.mock.calls.length;destroy=mountFolderVault(root);
    assertNeverSent();expect(document.querySelector("#selected-path")?.textContent,`remount ${cycle}`).toBe("No folder selected");expect(document.querySelector("[data-mode]")).toBeNull();expect(document.querySelector<HTMLElement>("#create-directory")?.hidden).toBe(true);
    for(const b of document.querySelectorAll("button"))b.dispatchEvent(new Event("click",{bubbles:true}));
    for(const i of document.querySelectorAll("input"))i.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector("#location")?.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
    await vi.advanceTimersByTimeAsync(0);expect(f.mock.calls).toHaveLength(count);assertNeverSent();expect(document.querySelector("#selected-path")?.textContent).toBe("No folder selected");
   }
  });
 }
}
const exactParent=" Parent 日本 ",exactDirectory=" 日本: %2e%2e ";
const exact={mode:"existing" as const,path:`${exactParent}/${exactDirectory}`,name:" Exact label ",slug:""};
const commit={get slug(){return exact.slug;},committed:true,directory_synced:true,audit_recorded:false,watched:true,index_ready:true,index_storage:"memory_until_restart"};
async function pendingRegistration(){
 const old=deferred<Response>(),repeated=deferred<Response>(),write=deferred<Response>();let dirs=0;
 const posts:{url:string;body:unknown;signal:AbortSignal|null|undefined}[]=[];
 const statuses:{url:string;signal:AbortSignal|null|undefined;transport:ReturnType<typeof deferred<Response>>}[]=[];
 const f=vi.fn(async(u:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(u);
  if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:" Current projects "}]});
  if(url.includes("/directories?")){
   if(++dirs===1)return old.promise;if(dirs===2)return repeated.promise;
   const path=new URL(url,"http://localhost").searchParams.get("path")??"";
   return response({path,state:path===""?state:{...state,location_root:false,selectable:true},children:path===""?[{name:exactParent,path:exactParent,state:{...state,location_root:false,selectable:true}}]:[]});
  }
  if(url.endsWith("/directories"))return response({path:exact.path,created:true,directory_synced:true},201);
  if(url.endsWith("/preview")){exact.slug=(JSON.parse(String(init?.body)) as {slug:string}).slug;return response({confirmation:"a".repeat(64),expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true});}
  if(url.endsWith("/register")){posts.push({url,body:JSON.parse(String(init?.body)) as unknown,signal:init?.signal});return write.promise;}
  if(url.includes("/status?")){const transport=deferred<Response>();statuses.push({url,signal:init?.signal,transport});return transport.promise;}
  if(url.endsWith("/vaults"))return response([{slug:exact.slug,name:exact.name}]);
  throw new Error("unexpected route");
 });
 mount(f);button("Choose folder").click();await vi.waitFor(()=>expect(dirs).toBe(1));
 button("Refresh folders").dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(dirs).toBe(2));
 button("Refresh folders").dispatchEvent(new Event("click"));await vi.waitFor(()=>expect(button(exactParent)).toBeDefined());button(exactParent).click();await vi.waitFor(()=>expect(button("Add folder here").disabled).toBe(false));button("Add folder here").click();const child=document.querySelector<HTMLInputElement>("#directory-name");if(child===null)throw new Error("input");child.value=exactDirectory;document.querySelector("#create-directory")?.dispatchEvent(new Event("submit",{cancelable:true}));await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(exactDirectory));button("Use this folder").click();
 for(const [id,value] of [["directory-name",exactDirectory],["vault-name",exact.name]]){const i=document.querySelector<HTMLInputElement>(`#${id}`);if(!i)throw new Error("input");i.value=value??"";i.dispatchEvent(new Event("input",{bubbles:true}));}
 document.querySelector("form")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(posts).toHaveLength(1));
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});return {old,repeated,write,posts,statuses,f};
}
function assertFencedIntent(posts:{url:string;body:unknown;signal:AbortSignal|null|undefined}[]):void {
 expect(document.querySelector("#message")?.textContent).toContain("Administration is unavailable");
 expect(document.querySelector("#confirmation")).toBeNull();
 for(const b of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button"))expect(b.disabled).toBe(true);
 expect(document.querySelector<HTMLInputElement>("#directory-name")?.value).toBe(exactDirectory);expect(document.querySelector<HTMLInputElement>("#vault-name")?.value).toBe(exact.name);expect(document.querySelector<HTMLInputElement>("#vault-slug")?.value).toBe("");
 expect(document.querySelector<HTMLSelectElement>("#location")?.value).toBe("projects");expect(document.querySelector("#selected-path")?.textContent).toContain(exact.path);
 expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);
 button("Create vault").click();button("Refresh folders").dispatchEvent(new Event("click"));document.querySelector("form")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));button("Check registration status").click();
 expect(posts).toHaveLength(1);expect(posts[0]?.url).toBe("/api/v1/vault-locations/projects/register");expect(posts[0]?.body).toEqual({...exact,confirmation:"a".repeat(64)});expect(posts[0]?.signal?.aborted).toBe(true);
}
function assertUncertain():void {
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown");expect(document.querySelector("#result-message")?.textContent).toContain("Registration may already be committed");expect(document.querySelector("#result-message")?.textContent).toContain("Do not retry");
 const intent=document.querySelector("#outcomes")?.textContent;
 for(const value of [exact.path,exact.name," Current projects ","projects",exact.slug])expect(intent).toContain(JSON.stringify(value));
 expect(document.querySelector("#content-access")?.textContent).toBe("");
}
for(const completion of ["success","network","storage-error","authority-error","precommit-error","schema-error"] as const){
 for(const order of ["denial-first","completion-first"] as const){
  if(order==="completion-first" && (completion==="success" || completion==="precommit-error"))continue;
  test(`sent registration retains uncertainty after older denial: ${completion}, ${order}, repeated denial`,async()=>{
   const p=await pendingRegistration();
   const complete=():void=>{if(completion==="network")p.write.reject(new Error("private diagnostic"));else p.write.resolve(completion==="success"?response(commit,201):completion==="schema-error"?response({committed:true},201):completion==="storage-error"?response({error:"storage_unavailable"},503):completion==="authority-error"?response({error:"not_found"},404):response({error:"confirmation_conflict"},409));};
   if(order==="denial-first"){p.old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertUncertain();complete();}else{complete();await vi.advanceTimersByTimeAsync(0);p.old.resolve(response({error:"not_found"},404));}
   await vi.advanceTimersByTimeAsync(0);assertUncertain();assertFencedIntent(p.posts);
   p.repeated.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertUncertain();assertFencedIntent(p.posts);expect(document.body.textContent).not.toContain("private diagnostic");expect(p.f.mock.calls.filter(([u])=>String(u).endsWith("/vaults"))).toHaveLength(0);
  });
 }
}
test("verified committed response is not relabelled uncertain by later read denial",async()=>{
 const p=await pendingRegistration();p.write.resolve(response(commit,201));await vi.advanceTimersByTimeAsync(0);expect(document.querySelector("#result-heading")?.textContent).toBe("Vault registered");expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(false);
 p.old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);p.repeated.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);expect(document.querySelector("#result-heading")?.textContent).toBe("Vault registered");expect(document.querySelector("#result-message")?.textContent).toContain("committed");expect(document.querySelector("#result-message")?.textContent).not.toContain("may already");assertFencedIntent(p.posts);
});
test("verified precommit refusal before read denial is not possibly committed",async()=>{
 const p=await pendingRegistration();p.write.resolve(response({error:"confirmation_conflict"},409));await vi.advanceTimersByTimeAsync(0);p.old.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);
 expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(true);expect(document.body.textContent).not.toContain("Registration may already be committed");assertFencedIntent(p.posts);
});
test("teardown of sent registration fences late success and older denial without detached publication",async()=>{
 const p=await pendingRegistration();destroy();const before=document.body.innerHTML;p.old.resolve(response({error:"not_found"},404));p.write.resolve(response(commit,201));await vi.advanceTimersByTimeAsync(0);expect(document.body.innerHTML).toBe(before);expect(p.posts).toHaveLength(1);expect(p.posts[0]?.signal?.aborted).toBe(true);
});
const statusPath=exact.path;
const registeredStatus=()=>response({path:statusPath,state:{location_root:false,registration:"already_registered",selectable:false,browsable:false}});
async function uncertainRegistration(){
 const p=await pendingRegistration();p.write.reject(new Error("deliberate external transport loss; no actual server write"));await vi.advanceTimersByTimeAsync(0);
 assertUncertain();expect(button("Check registration status").disabled).toBe(false);return p;
}
function statusRequest(p:Awaited<ReturnType<typeof pendingRegistration>>){
 const before=p.statuses.length;button("Check registration status").click();expect(p.statuses).toHaveLength(before+1);
 const request=p.statuses[before];if(request===undefined)throw new Error("status request not dispatched");
 expect(new URL(request.url,"http://localhost").searchParams.get("path")).toBe(statusPath);return request;
}
function assertStatusFenced(p:Awaited<ReturnType<typeof pendingRegistration>>):void {
 assertUncertain();assertFencedIntent(p.posts);expect(document.querySelector<HTMLElement>("#outcomes")?.style.whiteSpace).toBe("pre-wrap");
 expect(document.querySelector<HTMLAnchorElement>("#open-vault")?.hasAttribute("href")).toBe(false);
 expect(document.querySelector("#result-message")?.textContent).not.toContain("now administratively registered");
 expect(p.statuses.every(r=>r.signal?.aborted)).toBe(true);
 const count=p.f.mock.calls.length,statusCount=p.statuses.length;
 // why: disabled controls alone do not fence script-dispatched handlers or stale receipts.
 for(const b of document.querySelectorAll("button"))b.dispatchEvent(new Event("click",{bubbles:true}));
 for(const i of document.querySelectorAll("input"))i.dispatchEvent(new Event("input",{bubbles:true}));
 document.querySelector("#location")?.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));
 expect(p.f.mock.calls).toHaveLength(count);expect(p.statuses).toHaveLength(statusCount);expect(p.posts).toHaveLength(1);
 expect(p.f.mock.calls.filter(([u])=>String(u).endsWith("/vaults"))).toHaveLength(0);
}
for(const order of ["active-denial","denial-first","success-first"] as const){
 test(`outcome status authoritative denial fences uncertainty: ${order}, repeated denial`,async()=>{
  const p=await uncertainRegistration(),old=statusRequest(p);
  if(order==="active-denial")old.transport.resolve(response({error:"not_found"},404));
  else {
   const repeat=statusRequest(p),newer=statusRequest(p);expect(old.signal?.aborted).toBe(true);expect(newer.signal?.aborted).toBe(false);
   if(order==="denial-first"){old.transport.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);newer.transport.resolve(registeredStatus());}
   else {newer.transport.resolve(registeredStatus());await vi.advanceTimersByTimeAsync(0);expect(document.querySelector("#result-message")?.textContent).toContain("not a content grant or proof of which request completed");old.transport.resolve(response({error:"not_found"},404));}
   await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);repeat.transport.resolve(response({error:"not_found"},404));
  }
  await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);
  // Repeated older directory denial composes with the status fence without erasing the sent intent.
  p.old.resolve(response({error:"not_found"},404));p.repeated.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);
 });
}
type StatusFailure="busy"|"network"|"schema";
function completeStatusFailure(request:ReturnType<typeof statusRequest>,kind:StatusFailure):void {
 if(kind==="network")request.transport.reject(new Error("private status diagnostic"));
 else request.transport.resolve(kind==="busy"?response({error:"busy"},429):response({path:statusPath,state:{registration:"already_registered"}}));
}
function assertSafeStatus(p:Awaited<ReturnType<typeof pendingRegistration>>):void {
 expect(document.querySelector("#result-heading")?.textContent).toBe("Registration outcome unknown");expect(document.querySelector<HTMLElement>("#result")?.hidden).toBe(false);
 expect(button("Check registration status").disabled).toBe(false);expect(button("Create vault").disabled).toBe(true);
 expect(document.querySelector("#outcomes")?.textContent).toContain(JSON.stringify(exact.path));expect(document.querySelector("#message")?.textContent).not.toContain("Administration is unavailable");
 expect(document.querySelector("#content-access")?.textContent).toBe("");expect(document.querySelector<HTMLElement>("#open-vault")?.hidden).toBe(true);
 expect(document.body.textContent).not.toContain("private status diagnostic");expect(p.posts).toHaveLength(1);expect(p.f.mock.calls.filter(([u])=>String(u).endsWith("/vaults"))).toHaveLength(0);
}
for(const kind of ["busy","network","schema"] as const){
 for(const order of ["denial-first","failure-first"] as const){
  test(`older outcome status denial wins newer ${kind} in ${order} order`,async()=>{
   const p=await uncertainRegistration(),old=statusRequest(p),newer=statusRequest(p);
   if(order==="denial-first"){old.transport.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);const before=document.body.innerHTML;completeStatusFailure(newer,kind);await vi.advanceTimersByTimeAsync(0);expect(document.body.innerHTML).toBe(before);}
   else {completeStatusFailure(newer,kind);await vi.advanceTimersByTimeAsync(0);assertSafeStatus(p);old.transport.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);}
   assertStatusFenced(p);const before=document.body.innerHTML;p.repeated.resolve(response({error:"not_found"},404));await vi.advanceTimersByTimeAsync(0);assertStatusFenced(p);expect(document.body.innerHTML).toBe(before);
  });
 }
 for(const order of ["failure-first","success-first"] as const){
  test(`stale nonauthoritative outcome status ${kind} is generation fenced in ${order} order`,async()=>{
   const p=await uncertainRegistration(),old=statusRequest(p),newer=statusRequest(p);
   if(order==="failure-first"){completeStatusFailure(old,kind);await vi.advanceTimersByTimeAsync(0);assertUncertain();newer.transport.resolve(registeredStatus());}
   else {newer.transport.resolve(registeredStatus());await vi.advanceTimersByTimeAsync(0);completeStatusFailure(old,kind);}
   await vi.advanceTimersByTimeAsync(0);expect(document.querySelector("#result-message")?.textContent).toContain("now administratively registered");expect(document.querySelector("#result-message")?.textContent).toContain("not a content grant or proof of which request completed");
   assertSafeStatus(p);expect(newer.signal?.aborted).toBe(false);expect(p.statuses).toHaveLength(2);
  });
 }
 test(`active nonauthoritative outcome status ${kind} retains uncertainty and explicit recovery against stale success`,async()=>{
  const p=await uncertainRegistration(),old=statusRequest(p),active=statusRequest(p);completeStatusFailure(active,kind);await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("#result-message")?.textContent).toContain("Do not retry the possibly committed write");assertSafeStatus(p);const before=document.body.innerHTML;
  old.transport.resolve(registeredStatus());await vi.advanceTimersByTimeAsync(0);expect(document.body.innerHTML).toBe(before);expect(active.signal?.aborted).toBe(false);
  const recovery=statusRequest(p);recovery.transport.resolve(registeredStatus());await vi.advanceTimersByTimeAsync(0);assertSafeStatus(p);expect(document.querySelector("#result-message")?.textContent).toContain("not a content grant or proof of which request completed");expect(p.statuses).toHaveLength(3);
 });
}
for(const completion of ["denial","network","success"] as const){
 test(`disposed outcome status ${completion} cannot mutate detached DOM`,async()=>{
  const p=await uncertainRegistration(),r=statusRequest(p),root=document.querySelector<HTMLElement>("#folder-vault");if(!root)throw new Error("root");destroy();root.remove();const before=root.outerHTML;
  if(completion==="denial")r.transport.resolve(response({error:"not_found"},404));else if(completion==="success")r.transport.resolve(registeredStatus());else r.transport.reject(new Error("late network rejection"));
  await vi.advanceTimersByTimeAsync(0);expect(root.outerHTML).toBe(before);expect(r.signal?.aborted).toBe(true);expect(p.posts).toHaveLength(1);expect(p.statuses).toHaveLength(1);
 });
}
test("browse error refresh preserves requested folder instead of silently changing to root",async()=>{
 let count=0;const urls:string[]=[];
 mount(vi.fn(async u=>{const url=String(u);urls.push(url);if(url.endsWith("/vault-locations"))return response({locations:[{id:"projects",name:"Projects"}]});if(++count===1)return response({path:"",state,children:[{name:"Child",path:"Child",state:{...state,location_root:false,selectable:true}}]});return response({error:"busy"},429);}));
 button("Choose folder").click();await vi.waitFor(()=>expect(button("Child")).toBeDefined());button("Child").click();await vi.waitFor(()=>expect(document.querySelector("#message")?.textContent).toContain("server is busy"));button("Refresh folders").click();await vi.waitFor(()=>expect(urls).toHaveLength(5));expect(urls[3]).toBe("/api/v1/vault-locations");expect(urls[4]).toContain("path=Child");expect(document.querySelector("#current-path")?.textContent).toBe("Child");
});
