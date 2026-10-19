import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import { folderServer, loginFolderServer } from "./folder-fixture.js";
async function activatePickerControl(b:Locator,mobile:boolean):Promise<void>{if(mobile)await b.tap();else{await expect(b).toBeEnabled();await b.focus();await b.press("Enter");}}
test("compact configured-folder dialog supports keyboard, cancel, exact selection and mobile tapping",async({page},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile";
 const activate=async(name:string):Promise<void>=>activatePickerControl(page.getByRole("button",{name,exact:true}),mobile);
 try {
  await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
  let posts=0;page.on("request",r=>{if(r.method()==="POST")++posts;});
  await expect(page.getByLabel("Vault name",{exact:true})).toBeVisible();await expect(page.getByLabel("Vault address (optional)",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Check storage and review",exact:true})).toHaveCount(0);
  await activate("Choose folder");const dialog=page.locator("#picker");await expect(dialog).toBeVisible();
  await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeDisabled();await expect(page.locator("#directories")).not.toContainText("Available");await expect(page.getByRole("button",{name:"Registered",exact:true})).toBeDisabled();await expect(page.locator("#directories")).not.toContainText("PrivateChild");
  if(!mobile){
   await page.getByRole("button",{name:"Use this folder",exact:true}).evaluate(e=>{e.setAttribute("data-focus-probe","true");});
   await page.getByRole("button",{name:"Cancel",exact:true}).focus();await page.keyboard.press("Tab");await expect(page.getByRole("button",{name:"Close folder picker",exact:true})).toBeFocused();await page.keyboard.press("Shift+Tab");await expect(page.getByRole("button",{name:"Cancel",exact:true})).toBeFocused();expect(await page.evaluate(()=>document.querySelector("dialog")?.contains(document.activeElement))).toBe(true);
   await page.keyboard.press("Escape");await expect(dialog).toBeHidden();await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();await activate("Choose folder");
  }
  await page.screenshot({path:info.outputPath("folder-dialog.png")});
  await activate("日本: 100%");await activate("Use this folder");await expect(dialog).toBeHidden();await expect(page.locator("#selected-path")).toContainText('Projects / "日本: 100%"');await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();
  await activate("Choose folder");await activate("Go to parent folder");await activate("Cancel");await expect(page.locator("#selected-path")).toContainText('"日本: 100%"');
  await activate("Choose folder");await activate("Go to parent folder");await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeDisabled();await activate("Add folder here");await page.getByLabel("Folder name",{exact:true}).fill("  Design: 日本 100%  ");await activate("Cancel folder creation");await activate("Cancel");expect(await page.locator("#selected-path").evaluate(e=>getComputedStyle(e).whiteSpace)).toBe("pre-wrap");
  for(const width of mobile?[412,320]:[1280]){
   await page.setViewportSize({width,height:mobile?915:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   await activate("Choose folder");expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeEnabled();const visibleControls=await dialog.locator("button:visible,select:visible").all();expect(visibleControls.length).toBeGreaterThan(4);for(const control of visibleControls)expect((await control.boundingBox())?.height??0).toBeGreaterThanOrEqual(44);
   await page.screenshot({path:info.outputPath(`folder-dialog-${width}.png`)});await activate("Close folder picker");await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();
   await page.screenshot({path:info.outputPath(`compact-form-${width}.png`)});
  }
  expect(posts).toBe(0);
 }finally{try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});

function deferred<T>(){let resolve=(_value:T):void=>{throw new Error("uninitialized");};const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
for(const action of ["child selection","reopen parent"] as const){
 test(`held valid directory response preserves ${action} activation`,async({page},info)=>{
  const server=await folderServer(),mobile=info.project.name==="mobile",path="日本: 100%";
  const canonicalPath=join(server.root,"projects",path,"README.md"),policyPath=join(server.root,"projects",path,"access.toml");
  const held=deferred<void>(),release=deferred<void>(),published=deferred<void>(),order:string[]=[],requests:string[]=[];
  let armed=false,heldCount=0,actualStatus:number|undefined,actualBodySha:string|undefined;
  const activate=async(name:string):Promise<void>=>activatePickerControl(page.getByRole("button",{name,exact:true}),mobile);
  try {
   const configBefore=await readFile(server.config),canonicalBefore=await readFile(canonicalPath),policyBefore=await readFile(policyPath);
   await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
   page.on("request",r=>requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
   await activate("Choose folder");await expect(page.getByRole("button",{name:path,exact:true})).toBeEnabled();
   if(action==="reopen parent"){
    await activate(path);await expect(page.getByRole("button",{name:"Use this folder",exact:true})).toBeEnabled();await activate("Use this folder");
    await expect(page.locator("#picker")).toBeHidden();await expect(page.locator("#selected-path")).toHaveText('Projects / "日本: 100%"');
   }
   await page.route("**/api/v1/vault-locations/projects/directories?*",async route=>{
    if(!armed||new URL(route.request().url()).searchParams.get("path")!==path){await route.continue();return;}
    armed=false;++heldCount;order.push("directory-get");
    // Network gate: fetch the unmodified server's valid reply, holding only its publication.
    const response=await route.fetch(),body=await response.body();actualStatus=response.status();actualBodySha=createHash("sha256").update(body).digest("hex");
    expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toContain("no-store");expect((await response.json() as {path:string}).path).toBe(path);
    order.push("valid-server-response-held");held.resolve();await release.promise;order.push("directory-release");await route.fulfill({response});order.push("directory-published");published.resolve();
   });
   armed=true;await activate(action==="child selection"?path:"Choose folder");await held.promise;
   const dialog=page.locator("#picker"),control=page.getByRole("button",{name:action==="child selection"?"Use this folder":"Go to parent folder",exact:true});
   await expect(dialog).toBeVisible();await expect(control).toBeDisabled();await expect(page.locator("#current-path")).toHaveText(path);order.push("target-disabled");
   // Observe framework calls, not production code or input dispatch. The first real
   // enabled poll/tap starts while disabled, then releases the valid network reply.
   // A helper without readiness instead sends its native Enter while still disabled;
   // release only after that press completes, so the behavioral assertion goes red.
   // `_expect` is Playwright's Locator protocol entry: fail explicitly if it changes.
   expect(typeof Reflect.get(control,"_expect")).toBe("function");
   await page.evaluate(()=>{
    const observations:{kind:string;name:string;trusted:boolean;detail:number;pointerType:string}[]=[];
    (window as unknown as {pickerInputs:typeof observations}).pickerInputs=observations;
    for(const kind of ["keydown","click","pointerdown"])document.addEventListener(kind,event=>{
     const target=event.target as HTMLElement|null;
     observations.push({kind,name:target?.textContent??"",trusted:event.isTrusted,detail:event instanceof MouseEvent?event.detail:0,pointerType:event instanceof PointerEvent?event.pointerType:""});
    },{capture:true});
   });
   const observed=new Proxy(control,{get(target,key){
    const method:unknown=Reflect.get(target,key);
    if(typeof method!=="function"||!["_expect","focus","press","tap"].includes(String(key)))return method;
    return async(...args:unknown[]):Promise<unknown>=>{
     if(key==="focus")order.push(`native-focus-start:${await target.isEnabled()?"enabled":"disabled"}`);
     if(key==="press")order.push(`native-enter-start:${await target.isEnabled()?"enabled":"disabled"}`);
     const pending:Promise<unknown>=method.apply(target,args);
     if((key==="_expect"&&args[0]==="to.be.enabled")||key==="tap"){order.push(key==="tap"?"native-tap-wait-start":"enabled-wait-start");release.resolve();}
     try{return await pending;}finally{if(key==="press"){order.push("native-enter-complete");release.resolve();}}
    };
   }});
   await activatePickerControl(observed,mobile);await published.promise;
   await expect(page.locator("#message")).not.toContainText("Loading server folders");
   const inputEvents=await page.evaluate(()=>(window as unknown as {pickerInputs:{kind:string;name:string;trusted:boolean;detail:number;pointerType:string}[]}).pickerInputs);
   const beforeOutcome={action,mobile,transport_model:"Network-gate: actual disposable server 200/no-store body fetched unchanged; publication held at page.route. Locator protocol observation releases on real enabled-poll/tap start, or after original native Enter completes; no timers or production mocks.",actual_status:actualStatus,actual_body_sha256:actualBodySha,held_count:heldCount,order:[...order],input_events:inputEvents,dialog_open:await dialog.isVisible(),current_path:await page.locator("#current-path").textContent(),selected_path:await page.locator("#selected-path").textContent()};
   // Observation, including a failing outcome, is not a post-assertion success proof.
   await writeFile(info.outputPath("readiness-observation.json"),JSON.stringify(beforeOutcome,null,2),{flag:"wx"});
   if(action==="child selection"){
    await expect(dialog).toBeHidden();await expect(page.locator("#selected-path")).toHaveText('Projects / "日本: 100%"');await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();
   }else{
    await expect(page.locator("#current-path")).toHaveText("Location root");await expect(page.getByRole("button",{name:path,exact:true})).toBeEnabled();await expect(dialog).toBeVisible();await activate("Cancel");await expect(dialog).toBeHidden();await expect(page.locator("#selected-path")).toHaveText('Projects / "日本: 100%"');await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeFocused();
   }
   expect(heldCount).toBe(1);
   const targetName=action==="child selection"?"Use this folder":"Go to parent folder",targetClicks=inputEvents.filter(e=>e.kind==="click"&&e.name===targetName&&e.trusted);expect(targetClicks).toHaveLength(1);
   if(mobile)expect(inputEvents.some(e=>e.kind==="pointerdown"&&e.name===targetName&&e.pointerType==="touch"&&e.trusted)).toBe(true);
   else{expect(targetClicks[0]?.detail).toBe(0);expect(order).not.toContain("native-focus-start:disabled");expect(order).not.toContain("native-enter-start:disabled");}
   expect(requests.filter(r=>r.startsWith("POST "))).toEqual([]);expect(requests.filter(r=>/^GET \/api\/v1\/vaults(?:\/|$)/.test(r))).toEqual([]);
   const configAfter=await readFile(server.config),canonicalAfter=await readFile(canonicalPath),policyAfter=await readFile(policyPath);expect(configAfter).toEqual(configBefore);expect(canonicalAfter).toEqual(canonicalBefore);expect(policyAfter).toEqual(policyBefore);
   await writeFile(info.outputPath("readiness-proof.json"),JSON.stringify({...beforeOutcome,order,selected_path:await page.locator("#selected-path").textContent(),dialog_closed:true,intended_native_activation:true,activation:mobile?"native touch tap":"native focus/Enter",post_requests:0,content_reads:0,requests,configuration_unchanged:true,canonical_markdown_unchanged:true,policy_unchanged:true,configuration_sha256:createHash("sha256").update(configAfter).digest("hex"),canonical_sha256:createHash("sha256").update(canonicalAfter).digest("hex"),policy_sha256:createHash("sha256").update(policyAfter).digest("hex")},null,2),{flag:"wx"});
  }finally{release.resolve();try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
 });
}
