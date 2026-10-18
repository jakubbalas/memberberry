import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Route } from "@playwright/test";
import { join } from "node:path";
import { expect,test } from "./fixtures.js";
import { folderServer,loginFolderServer } from "./folder-fixture.js";
import { chooseVaultFolder, activateFolderControl, createVaultFolder } from "./folder-actions.js";
function deferred<T>(){let resolve=(_v:T):void=>{throw new Error("uninitialized");};const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
for(const mode of ["existing","new"] as const){
 test(`F1 real preview denial never sent ${mode} resets selection across repeated persisted lifecycle events`,async({page,failures},info)=>{
  const server=await folderServer(),mobile=info.project.name==="mobile",path=mode==="new"?"Parent":"日本: 100%",directory="  New 日本: %2e%2e  ",name=" Exact label 日本 ";
  const requests:string[]=[];let previews=0,registers=0,contentReads=0;
  try {
  const configBefore=await readFile(server.config),canonicalPath=join(server.root,"projects/日本: 100%/README.md"),canonicalBefore=await readFile(canonicalPath),policyPath=join(server.root,"projects/日本: 100%/access.toml"),policyBefore=await readFile(policyPath);
   page.on("request",r=>{const p=new URL(r.url()).pathname;if(p.startsWith("/api/v1/vault-locations"))requests.push(`${r.method()} ${p}`);if(p.endsWith("/preview"))++previews;if(p.endsWith("/register"))++registers;if(p==="/api/v1/vaults")++contentReads;});
   await loginFolderServer(page,server.origin);await page.goto(`${server.origin}/vaults/add`);
   await activateFolderControl(page.getByRole("button",{name:"Choose folder",exact:true}),mobile);await activateFolderControl(page.getByRole("button",{name:path,exact:true}),mobile);
   if(mode==="new")await createVaultFolder(page,mobile,directory);else{await activateFolderControl(page.getByRole("button",{name:"Add folder here",exact:true}),mobile);await page.getByLabel("Folder name",{exact:true}).fill(directory);await activateFolderControl(page.getByRole("button",{name:"Cancel folder creation",exact:true}),mobile);}
   await activateFolderControl(page.getByRole("button",{name:"Use this folder",exact:true}),mobile);await page.getByLabel("Vault name",{exact:true}).fill(name);
   const activeSelection=await page.locator("#selected-path").textContent();expect(activeSelection).toContain(JSON.stringify(mode==="new"?`${path}/${directory}`:path));
   const signedOut=await page.request.get(`${server.origin}/logout`);expect(signedOut.ok()).toBe(true);
   failures.allow(/^HTTP 404 .*\/api\/v1\/vault-locations\/projects\/preview$/);failures.allow(/^console error: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/);
   let actualDenialBody:unknown;await page.route("**/api/v1/vault-locations/projects/preview",async route=>{const response=await route.fetch();expect(response.status()).toBe(404);expect(response.headers()["cache-control"]).toContain("no-store");actualDenialBody=await response.json();expect(actualDenialBody).toEqual({error:"not_found"});await route.fulfill({response});});
   const denial=page.waitForResponse(r=>r.url().endsWith("/preview")&&r.status()===404);await activateFolderControl(page.getByRole("button",{name:"Create vault",exact:true}),mobile);
   const refused=await denial;expect(actualDenialBody).toEqual({error:"not_found"});expect(refused.headers()["cache-control"]).toContain("no-store");
   const assertDenied=async():Promise<void>=>{
    await expect(page.locator("#message")).toContainText("Administration is unavailable");await expect(page.locator("#vault-name")).toHaveValue(name);await expect(page.locator("#directory-name")).toHaveValue(directory);
    for(const c of await page.locator("input,select,button").all())await expect(c).toBeDisabled();await expect(page.locator("#result")).toBeHidden();await expect(page.locator("#confirmation")).toHaveCount(0);await expect(page.locator("#cancel-validation")).toBeHidden();await expect(page.locator("#outcomes")).toBeEmpty();await expect(page.locator("#content-access")).toBeEmpty();await expect(page.locator("#open-vault")).toBeHidden();expect(await page.locator("#open-vault").getAttribute("href")).toBeNull();await expect(page.locator("body")).not.toContainText("Registration may already be committed");
   };
   await assertDenied();expect(await page.locator("#selected-path").textContent()).toBe(activeSelection);await expect(page.locator("[data-mode]")).toHaveCount(0);expect(previews).toBe(1);expect(registers).toBe(0);expect(contentReads).toBe(0);
   const boundaryRequests=requests.length,cycles:Record<string,unknown>[]=[];
   for(const cycle of [1,2,3]){
    // Explicitly exercise the shipped entry listeners; do not claim a native BFCache hit.
    await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));});
    await assertDenied();expect(await page.locator("#selected-path").textContent()).toBe("No folder selected");await expect(page.locator("[data-mode]")).toHaveCount(0);await expect(page.locator("#create-directory")).toBeHidden();
    await page.evaluate(()=>{for(const b of document.querySelectorAll("button"))b.dispatchEvent(new Event("click",{bubbles:true}));for(const i of document.querySelectorAll("input"))i.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#location")?.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await assertDenied();expect(requests).toHaveLength(boundaryRequests);expect(previews).toBe(1);expect(registers).toBe(0);expect(contentReads).toBe(0);
    cycles.push({cycle,selected_path:await page.locator("#selected-path").textContent(),mode_toggles_absent:true,denial_retained:true,typed_tokens_retained:true,all_controls_disabled:true,disabled_dispatch_extra_requests:requests.length-boundaryRequests});
   }
   const configAfter=await readFile(server.config),canonicalAfter=await readFile(canonicalPath),policyAfter=await readFile(policyPath);expect(configAfter).toEqual(configBefore);expect(canonicalAfter).toEqual(canonicalBefore);expect(policyAfter).toEqual(policyBefore);if(mode==="new"){expect((await stat(join(server.root,"projects",path,directory))).isDirectory()).toBe(true);await expect(stat(join(server.root,"projects",path,directory,"access.toml"))).rejects.toThrow();}else await expect(stat(join(server.root,"projects",path,directory))).rejects.toThrow();
   await page.screenshot({path:info.outputPath(`f1-never-sent-${mode}.png`)});
   await writeFile(info.outputPath("f1-never-sent-proof.json"),JSON.stringify({mode,path,directory,name,active_selection:activeSelection,transport_model:"Real server logout before Add vault; actual unmodified preview404 not_found, no external preview stub.",preview_refusal_status:refused.status(),preview_refusal_body:{error:"not_found"},preview_requests:previews,registration_requests:registers,application_content_reads:contentReads,requests,cycles,configuration_unchanged:true,canonical_markdown_unchanged:true,existing_policy_unchanged:true,new_child_absent:mode==="existing",mkdir_child_retained_without_acl:mode==="new",configuration_sha256:createHash("sha256").update(configAfter).digest("hex"),canonical_markdown_sha256:createHash("sha256").update(canonicalAfter).digest("hex"),existing_policy_sha256:createHash("sha256").update(policyAfter).digest("hex"),explicit_persisted_events:true,actual_browser_bfcache_hit_claimed:false},null,2));
  }finally{try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
 });
}
for(const completion of ["real-commit","stub-network-error"] as const){
 test(`older stub read denial retains sent-write uncertainty with ${completion}`,async({page,failures},info)=>{
  const server=await folderServer(),mobile=info.project.name==="mobile",old=deferred<Route>(),repeat=deferred<Route>(),posted=deferred<Route>(),release=deferred<void>(),transportDone=deferred<void>();
  const mkdirParent="日本: 100%",directory="  日本: %2e%2e  ";const intent={mode:"existing",path:`${mkdirParent}/${directory}`,name:"  Exact kept label  ",slug:""};
  let dirs=0,posts=0,contentReads=0,statusReads=0,committedStatus:number|undefined;const order:string[]=[];
  try {
  const before=await readFile(server.config),canonicalPath=join(server.root,"projects/日本: 100%/README.md"),canonical=await readFile(canonicalPath),policy=await readFile(join(server.root,"projects/日本: 100%/access.toml"));
   // why: deliberately ignore cancellation only at the external fetch boundary, matching a delayed transport; production controller/listeners remain real.
   await page.addInitScript(()=>{
    const original=window.fetch.bind(window);let reads=0;
    const signals:AbortSignal[]=[];(window as unknown as {r1Signals:AbortSignal[]}).r1Signals=signals;
    window.fetch=(input,init)=>{
     const url=String(input),heldRead=url.includes("/directories?") && ++reads<=2,write=url.endsWith("/register");
     if(heldRead || write){
      if(init?.signal)signals.push(init.signal);
      return original(input,{...init,signal:null}).finally(()=>{if(write)(window as unknown as {r1WriteFinished:boolean}).r1WriteFinished=true;});
     }
     return original(input,init);
    };
   });
   await page.route("**/api/v1/vault-locations/projects/directories?*",async route=>{
    if(++dirs===1){old.resolve(route);return;}if(dirs===2){repeat.resolve(route);return;}await route.continue();
   });
   await page.route("**/api/v1/vault-locations/projects/register",async route=>{
    ++posts;intent.slug=String((route.request().postDataJSON() as Record<string,unknown>)["slug"]);expect(intent.slug).toMatch(/^exact-kept-label-[a-f0-9]{12}$/);order.push("register-sent");posted.resolve(route);
    if(completion==="real-commit"){
     const response=await route.fetch();committedStatus=response.status();order.push("server-response-held");
     await release.promise;await route.fulfill({response});
    }else{await release.promise;await route.abort("failed");}
    order.push("write-transport-completed");transportDone.resolve();
   });
   page.on("request",request=>{const url=new URL(request.url());if(url.pathname==="/api/v1/vaults")++contentReads;if(url.pathname.endsWith("/status"))++statusReads;});
   failures.allow(/HTTP 404 .*\/directories\?/);failures.allow(/console error: Failed to load resource: the server responded with a status of 404/);
   if(completion==="stub-network-error"){failures.allow(/request failed: POST .*\/register — net::ERR_FAILED/);failures.allow(/console error: Failed to load resource: net::ERR_FAILED/);}
   await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
   const press=async(name:string):Promise<void>=>{const b=page.getByRole("button",{name,exact:true});if(mobile)await b.tap();else await b.click();};
   await press("Choose folder");await old.promise;await page.locator("#refresh").dispatchEvent("click");await repeat.promise;await press("Cancel");await press("Choose folder");
   await press(mkdirParent);await createVaultFolder(page,mobile,directory);await press("Use this folder");await page.getByLabel("Vault name",{exact:true}).fill(intent.name);
   await press("Create vault");
   const sent=(await posted.promise).request().postDataJSON() as Record<string,unknown>;expect(sent).toEqual({...intent,confirmation:expect.stringMatching(/^[a-f0-9]{64}$/)});
   if(completion==="real-commit")await expect.poll(()=>committedStatus).toBe(201);
   order.push("old-stub-denial");await (await old.promise).fulfill({status:404,contentType:"application/json",body:JSON.stringify({error:"not_found"})});
   const assertUnknown=async():Promise<void>=>{
    await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();await expect(page.locator("#result-message")).toContainText("Registration may already be committed");await expect(page.locator("#result-message")).toContainText("Do not retry");await expect(page.locator("#message")).toContainText("Administration is unavailable");
    for(const literal of [intent.path,intent.name,intent.slug,"projects","Projects"])await expect(page.locator("#outcomes")).toContainText(JSON.stringify(literal));
    expect(await page.locator("#outcomes").evaluate(e=>getComputedStyle(e).whiteSpace)).toBe("pre-wrap");
    await expect(page.getByLabel("Folder name",{exact:true})).toHaveValue(directory);await expect(page.getByLabel("Vault name",{exact:true})).toHaveValue(intent.name);await expect(page.getByLabel("Vault address (optional)",{exact:true})).toHaveValue("");await expect(page.locator("#location")).toHaveValue("projects");await expect(page.locator("#selected-path")).toContainText(intent.path);
    for(const c of await page.locator("input,select,button").all())await expect(c).toBeDisabled();await expect(page.locator("#confirmation")).toBeHidden();await expect(page.locator("#open-vault")).toBeHidden();await expect(page.locator("#content-access")).toBeEmpty();expect(posts).toBe(1);
   };
   await assertUnknown();release.resolve();await transportDone.promise;await page.waitForFunction(()=>(window as unknown as {r1WriteFinished:boolean}).r1WriteFinished);
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await assertUnknown();
   order.push("repeat-stub-denial");await (await repeat.promise).fulfill({status:404,contentType:"application/json",body:JSON.stringify({error:"not_found"})});await assertUnknown();
   expect(await page.evaluate(()=>((window as unknown as {r1Signals:AbortSignal[]}).r1Signals).every(s=>s.aborted))).toBe(true);
   // Deliberately dispatch events too: disabled controls and stale receipts cannot send another POST or content query.
   await page.locator("#preview").dispatchEvent("click");await page.locator("#details").dispatchEvent("submit");await page.locator("#check-outcome").dispatchEvent("click");await assertUnknown();expect(contentReads).toBe(0);expect(statusReads).toBe(0);
   const currentConfig=await readFile(server.config),canonicalAfter=await readFile(canonicalPath),policyAfter=await readFile(join(server.root,"projects/日本: 100%/access.toml"));expect(canonicalAfter).toEqual(canonical);expect(policyAfter).toEqual(policy);
   let canonicalProof:Record<string,unknown>={actual_server_commit:false,config_unchanged:currentConfig.equals(before)};
   if(completion==="real-commit"){
    const projectPath=join(server.root,"projects",intent.path);expect((await stat(projectPath)).isDirectory()).toBe(true);await expect(stat(join(projectPath,"notes"))).rejects.toThrow();
    expect(currentConfig.toString()).toContain(`slug = "${intent.slug}"`);expect(currentConfig.toString()).toContain(projectPath);expect(currentConfig.toString()).toContain(intent.name);
    const vaults=await page.request.get(`${server.origin}/api/v1/vaults`);expect(vaults.ok()).toBe(true);expect(await vaults.json()).toContainEqual({slug:intent.slug,name:intent.name});
    const notes=await page.request.get(`${server.origin}/api/v1/vaults/${intent.slug}/notes`);expect(notes.ok()).toBe(true);expect(await notes.json()).toEqual({notes:[],truncated:false});
    canonicalProof={actual_server_commit:true,register_http_status:201,config_contains_exact_registration:true,missing_only_child_present:true,no_implicit_notes:true,normal_server_catalog_contains_registration:true,normal_server_notes_catalog_empty:true,new_policy_sha256:createHash("sha256").update(await readFile(join(projectPath,"access.toml"))).digest("hex")};
   }else expect(currentConfig).toEqual(before);
   await page.screenshot({path:info.outputPath(`r1-${completion}.png`)});
   await writeFile(info.outputPath("r1-proof.json"),JSON.stringify({transport_model:"First two directory denials are stub 404s, not real revocation; external delayed fetch intentionally ignores cancellation. Actual shipped UI controls/generation fences run unchanged.",completion,intent,order,registration_posts:posts,all_observed_application_signals_aborted:true,visible_uncertainty_and_no_retry:true,authority_fence_and_literal_intent_retained:true,...canonicalProof,canonical_markdown_sha256:createHash("sha256").update(canonicalAfter).digest("hex"),existing_policy_sha256:createHash("sha256").update(policyAfter).digest("hex"),configuration_sha256:createHash("sha256").update(currentConfig).digest("hex")},null,2));
  }finally{release.resolve();try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
 });
}
for(const order of ["active-denial","denial-first","success-first"] as const){
 test(`outcome status stub denial fences sent uncertainty: ${order}`,async({page,failures},info)=>{
  const server=await folderServer(),mobile=info.project.name==="mobile",held=[deferred<Route>(),deferred<Route>(),deferred<Route>()] as const;
  const mkdirParent="日本: 100%",directory="  日本: %2e%2e  ";const intent={mode:"existing",path:`${mkdirParent}/${directory}`,name:"  Exact kept label  ",slug:""},statusPath=intent.path;
  let posts=0,statusReads=0,contentReads=0,adminRequests=0;const events:string[]=[];
  try {
  const before=await readFile(server.config),canonicalPath=join(server.root,"projects/日本: 100%/README.md"),canonical=await readFile(canonicalPath),policyPath=join(server.root,"projects/日本: 100%/access.toml"),policy=await readFile(policyPath);
   // why: stub status responses must finish even when a real UI AbortSignal is fenced; no registration is forwarded by this adapter.
   await page.addInitScript(()=>{
    const original=window.fetch.bind(window),signals:AbortSignal[]=[];
    const probe={signals,settled:0};(window as unknown as {r2Status:typeof probe}).r2Status=probe;
    window.fetch=(input,init)=>{
     if(String(input).includes("/status?")){if(init?.signal)signals.push(init.signal);return original(input,{...init,signal:null}).finally(()=>{++probe.settled;});}
     return original(input,init);
    };
   });
   await page.route("**/api/v1/vault-locations/projects/register",async route=>{++posts;intent.slug=String((route.request().postDataJSON() as Record<string,unknown>)["slug"]);expect(intent.slug).toMatch(/^exact-kept-label-[a-f0-9]{12}$/);expect(route.request().postDataJSON()).toEqual({...intent,confirmation:expect.stringMatching(/^[a-f0-9]{64}$/)});events.push("stub-register-network-loss-no-forward");await route.abort("failed");});
   await page.route("**/api/v1/vault-locations/projects/status?*",route=>{const own=statusReads++;expect(new URL(route.request().url()).searchParams.get("path")).toBe(statusPath);const target=held[own];if(!target)throw new Error("unexpected extra status request");target.resolve(route);});
   page.on("request",request=>{const path=new URL(request.url()).pathname;if(path==="/api/v1/vaults")++contentReads;if(path.startsWith("/api/v1/vault-locations"))++adminRequests;});
   failures.allow(/request failed: POST .*\/api\/v1\/vault-locations\/projects\/register — net::ERR_FAILED$/);failures.allow(/^console error: Failed to load resource: net::ERR_FAILED$/);
   failures.allow(/^HTTP 404 .*\/api\/v1\/vault-locations\/projects\/status\?/);failures.allow(/^console error: Failed to load resource: the server responded with a status of 404 \(Not Found\)$/);
   await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
   const press=async(name:string):Promise<void>=>{const b=page.getByRole("button",{name,exact:true});if(mobile)await b.tap();else await b.click();};
   await press("Choose folder");await press(mkdirParent);await createVaultFolder(page,mobile,directory);await press("Use this folder");await page.getByLabel("Vault name",{exact:true}).fill(intent.name);
   await press("Create vault");await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();expect(posts).toBe(1);
   await press("Check registration status");const old=await held[0].promise;
   const deny=async(route:Route):Promise<void>=>{events.push("stub-status-404");await route.fulfill({status:404,contentType:"application/json",body:JSON.stringify({error:"not_found"})});};
   const success=async(route:Route):Promise<void>=>{events.push("stub-registered-status-not-real-commit");await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({path:statusPath,state:{location_root:false,registration:"already_registered",selectable:false,browsable:false}})});};
   const assertFenced=async():Promise<void>=>{
    await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();await expect(page.locator("#result-message")).toContainText("Registration may already be committed");await expect(page.locator("#result-message")).toContainText("Do not retry");await expect(page.locator("#result-message")).not.toContainText("now administratively registered");await expect(page.locator("#message")).toContainText("Administration is unavailable");
    for(const literal of [intent.path,intent.name,intent.slug,"projects","Projects"])await expect(page.locator("#outcomes")).toContainText(JSON.stringify(literal));expect(await page.locator("#outcomes").evaluate(e=>getComputedStyle(e).whiteSpace)).toBe("pre-wrap");
    await expect(page.getByLabel("Folder name",{exact:true})).toHaveValue(directory);await expect(page.getByLabel("Vault name",{exact:true})).toHaveValue(intent.name);await expect(page.getByLabel("Vault address (optional)",{exact:true})).toHaveValue("");await expect(page.locator("#location")).toHaveValue("projects");await expect(page.locator("#selected-path")).toContainText(intent.path);
    for(const c of await page.locator("input,select,button").all())await expect(c).toBeDisabled();await expect(page.locator("#content-access")).toBeEmpty();await expect(page.locator("#open-vault")).toBeHidden();expect(await page.locator("#open-vault").getAttribute("href")).toBeNull();await expect(page.locator("#confirmation")).toBeHidden();
    expect(await page.evaluate(()=>((window as unknown as {r2Status:{signals:AbortSignal[]}}).r2Status).signals.every(s=>s.aborted))).toBe(true);
   };
   if(order==="active-denial"){await deny(old);await assertFenced();}
   else {
    await press("Check registration status");const repeat=await held[1].promise;await press("Check registration status");const newer=await held[2].promise;
    if(order==="denial-first"){await deny(old);await assertFenced();await success(newer);}
    else {await success(newer);await expect(page.locator("#result-message")).toContainText("not a content grant or proof of which request completed");await deny(old);}
    await page.waitForFunction(()=>(window as unknown as {r2Status:{settled:number}}).r2Status.settled===2);await assertFenced();await deny(repeat);
   }
   const expected=order==="active-denial"?1:3;await page.waitForFunction(n=>(window as unknown as {r2Status:{settled:number}}).r2Status.settled===n,expected);
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await assertFenced();
   // Deliberate disabled dispatch cannot issue another status GET, preview, write or content read.
   const requestsBeforeDispatch=adminRequests;
   await page.evaluate(()=>{for(const b of document.querySelectorAll("button"))b.dispatchEvent(new Event("click",{bubbles:true}));for(const i of document.querySelectorAll("input"))i.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#location")?.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
   await assertFenced();expect(posts).toBe(1);expect(statusReads).toBe(expected);expect(contentReads).toBe(0);expect(adminRequests).toBe(requestsBeforeDispatch);
   const after=await readFile(server.config),canonicalAfter=await readFile(canonicalPath),policyAfter=await readFile(policyPath);expect(after).toEqual(before);expect(canonicalAfter).toEqual(canonical);expect(policyAfter).toEqual(policy);expect((await stat(join(server.root,"projects",intent.path))).isDirectory()).toBe(true);await expect(stat(join(server.root,"projects",intent.path,"access.toml"))).rejects.toThrow();
   await page.screenshot({path:info.outputPath(`r2-status-${order}.png`)});
   await writeFile(info.outputPath("r2-status-proof.json"),JSON.stringify({order,intent,events,transport_model:"Register network loss forwards no server write. Status 404/200 are stubs, not real revocation/commit; only external status fetch ignores cancellation. Real shipped controller and abort signals are exercised.",actual_server_commit:false,registration_posts:posts,status_gets:statusReads,application_content_reads:contentReads,disabled_dispatch_no_extra_requests:true,latest_status_signal_aborted:true,visible_unknown_no_retry_prewrapped_exact_intent:true,configuration_unchanged:true,canonical_markdown_unchanged:true,existing_policy_unchanged:true,mkdir_child_retained_without_acl:true,configuration_sha256:createHash("sha256").update(after).digest("hex"),canonical_markdown_sha256:createHash("sha256").update(canonicalAfter).digest("hex"),existing_policy_sha256:createHash("sha256").update(policyAfter).digest("hex")},null,2));
  }finally{try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
 });
}
test("verified real201 commit survives repeated lifecycle remount without receipt, content claim or replay",async({page},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile",name=" Exact committed 日本 ";let posts=0,contentReads=0,adminReads=0,slug="";
 try {
 const canonicalPath=join(server.root,"projects/日本: 100%/README.md"),policyPath=join(server.root,"projects/日本: 100%/access.toml"),canonicalBefore=await readFile(canonicalPath),policyBefore=await readFile(policyPath);
  page.on("request",r=>{const p=new URL(r.url()).pathname;if(p.endsWith("/register")){++posts;slug=String((r.postDataJSON() as Record<string,unknown>)["slug"]);}if(p==="/api/v1/vaults")++contentReads;if(p.startsWith("/api/v1/vault-locations"))++adminReads;});
  await loginFolderServer(page,server.origin);await page.goto(`${server.origin}/vaults/add`);await chooseVaultFolder(page,"existing",mobile,"日本: 100%");await page.getByLabel("Vault name",{exact:true}).fill(name);
  const committedResponse=page.waitForResponse(r=>r.url().endsWith("/register")&&r.status()===201);await activateFolderControl(page.getByRole("button",{name:"Create vault",exact:true}),mobile);expect((await (await committedResponse).json() as {committed:boolean}).committed).toBe(true);
  await expect(page.locator("#content-access")).toContainText("Your current session can discover");await expect(page.locator("#open-vault")).toBeVisible();const configCommitted=await readFile(server.config);expect(configCommitted.toString()).toContain(`slug = "${slug}"`);expect(configCommitted.toString()).toContain(name);
  const selection=await page.locator("#selected-path").textContent(),before={posts,contentReads,adminReads};
  for(const cycle of [1,2,3]){
   await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));});
   await expect(page.locator("#result-heading")).toHaveText("Vault registered");await expect(page.locator("#result")).toBeVisible();await expect(page.locator("#result-message")).toContainText("Administrative registration is committed");await expect(page.locator("#result-message")).not.toContainText("may already");expect(await page.locator("#selected-path").textContent()).toBe(selection);await expect(page.locator("#vault-name")).toHaveValue(name);
   await expect(page.locator("#outcomes")).toBeEmpty();await expect(page.locator("#secondary-outcomes")).toBeEmpty();await expect(page.locator("#content-access")).toBeEmpty();await expect(page.locator("#open-vault")).toBeHidden();expect(await page.locator("#open-vault").getAttribute("href")).toBeNull();await expect(page.locator("#confirmation")).toHaveCount(0);for(const c of await page.locator("input,select,button").all())await expect(c).toBeDisabled();
   await page.evaluate(()=>{for(const b of document.querySelectorAll("button"))b.dispatchEvent(new Event("click",{bubbles:true}));for(const i of document.querySelectorAll("input"))i.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#location")?.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#details")?.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));expect({posts,contentReads,adminReads},`cycle ${cycle}`).toEqual(before);
  }
  expect(posts).toBe(1);expect(await readFile(server.config)).toEqual(configCommitted);expect(await readFile(canonicalPath)).toEqual(canonicalBefore);expect(await readFile(policyPath)).toEqual(policyBefore);
  await page.screenshot({path:info.outputPath("verified-commit-remount.png")});await writeFile(info.outputPath("verified-commit-remount-proof.json"),JSON.stringify({actual_server_commit_status:201,slug,name,registration_requests:posts,committed_fact_retained:true,uncertainty_not_fabricated:true,sent_selection_retained:true,remount_cycles:3,disabled_dispatch_no_extra_requests:true,receipts_and_content_claims_cleared:true,committed_configuration_unchanged_on_remount:true,canonical_markdown_unchanged:true,existing_policy_unchanged:true,configuration_sha256:createHash("sha256").update(configCommitted).digest("hex"),explicit_persisted_events:true,actual_browser_bfcache_hit_claimed:false},null,2));
 }finally{try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});
test("persisted page lifecycle events retain a real possibly committed write and never replay it",async({page,browser},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile",held=deferred<void>(),release=deferred<void>();let registrations=0,slug="";
 try {
  await page.route("**/api/v1/vault-locations/projects/register",async route=>{++registrations;slug=String((route.request().postDataJSON() as Record<string,unknown>)["slug"]);const actual=await route.fetch();expect(actual.status()).toBe(201);held.resolve();await release.promise;await route.fulfill({response:actual});});
  await loginFolderServer(page,server.origin);await page.goto(`${server.origin}/vaults/add`);await chooseVaultFolder(page,"existing",mobile,"日本: 100%");await page.getByLabel("Vault name",{exact:true}).fill(" Exact remounted label ");await activateFolderControl(page.getByRole("button",{name:"Create vault",exact:true}),mobile);await held.promise;
  // Exercise the shipped entry listeners with explicit persisted lifecycle events; this is not a claim of an actual browser-cache hit.
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}));});
  await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();await expect(page.locator("#result-message")).toContainText("Do not retry");await expect(page.locator("#outcomes")).toContainText(JSON.stringify(" Exact remounted label "));await expect(page.locator("#outcomes")).toContainText(JSON.stringify(slug));await expect(page.getByRole("button",{name:"Create vault",exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeDisabled();await expect(page.getByRole("link",{name:"Open vault",exact:true})).toBeHidden();
  release.resolve();await page.locator("#details").dispatchEvent("submit");const fresh=await browser.newContext();try{const other=await fresh.newPage();await loginFolderServer(other,server.origin);const catalog=await other.request.get(`${server.origin}/api/v1/vaults`);expect(await catalog.json()).toEqual([{slug,name:" Exact remounted label "}]);}finally{await fresh.close();}
  expect(registrations).toBe(1);await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();await expect(page.getByRole("link",{name:"Open vault",exact:true})).toBeHidden();
  await writeFile(info.outputPath("persisted-lifecycle-write-proof.json"),JSON.stringify({actual_server_commit_status:201,registration_requests:registrations,actual_slug:slug,unknown_retained:true,replay_disabled:true,content_access_claims_cleared:true,fresh_authenticated_catalog_verified:true,explicit_persisted_events:true,actual_browser_bfcache_hit_claimed:false},null,2));
 }finally{release.resolve();try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});
test("cancel and label edits fence real delayed validation without duplicate or stale registration",async({page},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile",held=[deferred<Route>(),deferred<Route>()] as const,releases=[deferred<void>(),deferred<void>()] as const;
 const config=await readFile(server.config),canonicalPath=join(server.root,"projects/日本: 100%/README.md"),canonical=await readFile(canonicalPath);let previews=0,registers=0;
 try {
  // External delayed fetch ignores cancellation only to exercise late server success against the real controller.
  await page.addInitScript(()=>{
   const original=window.fetch.bind(window),probe={signals:[] as AbortSignal[],settled:0};(window as unknown as {validationProbe:typeof probe}).validationProbe=probe;
   window.fetch=(input,init)=>{if(String(input).endsWith("/preview")){if(init?.signal)probe.signals.push(init.signal);return original(input,{...init,signal:null}).finally(()=>{++probe.settled;});}return original(input,init);};
  });
  await page.route("**/api/v1/vault-locations/projects/preview",async route=>{
   const index=previews++,target=held[index],release=releases[index];if(target===undefined||release===undefined)throw new Error("duplicate preview");
   const response=await route.fetch();expect(response.status()).toBe(200);target.resolve(route);await release.promise;await route.fulfill({response});
  });
  page.on("request",r=>{if(r.url().endsWith("/register"))++registers;});
  await loginFolderServer(page,server.origin);await page.goto(`${server.origin}/vaults/add`);await chooseVaultFolder(page,"existing",mobile,"日本: 100%");await page.getByLabel("Vault name",{exact:true}).fill(" Exact label ");
  for(const index of [0,1] as const){
   await activateFolderControl(page.getByRole("button",{name:"Create vault",exact:true}),mobile);await held[index].promise;
   await page.locator("#details").dispatchEvent("submit");expect(previews).toBe(index+1);
   if(index===0)await activateFolderControl(page.getByRole("button",{name:"Cancel validation",exact:true}),mobile);else await page.getByLabel("Vault name",{exact:true}).fill(" Changed label ");
   releases[index].resolve();await page.waitForFunction(n=>(window as unknown as {validationProbe:{settled:number}}).validationProbe.settled===n,index+1);
   await expect(page.getByRole("button",{name:"Create vault",exact:true})).toBeEnabled();expect(registers).toBe(0);await expect(page.locator("#selected-path")).toContainText("日本: 100%");
  }
  expect(await page.evaluate(()=>(window as unknown as {validationProbe:{signals:AbortSignal[]}}).validationProbe.signals.every(s=>s.aborted))).toBe(true);
  await expect(page.getByLabel("Vault name",{exact:true})).toHaveValue(" Changed label ");expect(await readFile(server.config)).toEqual(config);expect(await readFile(canonicalPath)).toEqual(canonical);
  await writeFile(info.outputPath("automatic-validation-cancellation-proof.json"),JSON.stringify({actual_server_preview_successes:previews,registration_requests:registers,double_submit_fenced:true,cancel_and_label_edit_fenced_late_success:true,configuration_unchanged:true,canonical_markdown_unchanged:true,external_transport_only_ignores_cancellation:true},null,2));
 }finally{for(const release of releases)release.resolve();try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});
test("real sign-out during automatic validation keeps intent and fences a possibly committed registration",async({page,failures},info)=>{
 const server=await folderServer(),mobile=info.project.name==="mobile",validated=deferred<Route>(),release=deferred<void>();
 let posts=0,slug="";
 try {
 const before=await readFile(server.config,"utf8"),bytes=await readFile(join(server.root,"projects/日本: 100%/README.md"));
  await page.route("**/api/v1/vault-locations/projects/preview",async route=>{
   const response=await route.fetch();expect(response.status()).toBe(200);validated.resolve(route);await release.promise;await route.fulfill({response});
  });
  page.on("request",r=>{if(r.url().endsWith("/register")){++posts;slug=String((r.postDataJSON() as Record<string,unknown>)["slug"]);}});
  await loginFolderServer(page,server.origin);await page.getByRole("link",{name:"New vault",exact:true}).click();
  for(const name of ["Choose folder","日本: 100%","Use this folder"]){const b=page.getByRole("button",{name,exact:true});if(mobile)await b.tap();else await b.click();}
  await page.getByLabel("Vault name",{exact:true}).fill(" Exact kept label ");await page.getByRole("button",{name:"Create vault",exact:true}).click();await validated.promise;
  const signedOut=await page.request.get(`${server.origin}/logout`);expect(signedOut.ok()).toBe(true);
  failures.allow(/HTTP 404 .*\/register$/);failures.allow(/console error: Failed to load resource: the server responded with a status of 404/);
  let actualDenialBody:unknown;await page.route("**/api/v1/vault-locations/projects/register",async route=>{const actual=await route.fetch();expect(actual.status()).toBe(404);expect(actual.headers()["cache-control"]).toContain("no-store");actualDenialBody=await actual.json();expect(actualDenialBody).toEqual({error:"not_found"});await route.fulfill({response:actual});});
  const denial=page.waitForResponse(r=>r.url().endsWith("/register")&&r.status()===404);release.resolve();await denial;expect(actualDenialBody).toEqual({error:"not_found"});
  await expect(page.locator("#result-message")).toContainText("Administration is unavailable");await expect(page.getByRole("heading",{name:"Registration outcome unknown",exact:true})).toBeVisible();await expect(page.getByLabel("Vault name",{exact:true})).toHaveValue(" Exact kept label ");await expect(page.getByLabel("Vault address (optional)",{exact:true})).toHaveValue("");await expect(page.locator("#selected-path")).toContainText("日本: 100%");expect(slug).toMatch(/^exact-kept-label-[a-f0-9]{12}$/);expect(posts).toBe(1);
  await expect(page.getByRole("button",{name:"Choose folder",exact:true})).toBeDisabled();await expect(page.locator("#confirmation")).toHaveCount(0);expect(await readFile(server.config,"utf8")).toBe(before);expect(await readFile(join(server.root,"projects/日本: 100%/README.md"))).toEqual(bytes);
  await page.screenshot({path:info.outputPath("current-session-denial.png")});await writeFile(info.outputPath("revocation-proof.json"),JSON.stringify({registration_refused:404,actual_slug:slug,registration_posts:posts,configuration_unchanged:true,canonical_markdown_unchanged:true,intent_preserved:true},null,2));
  failures.allow(/HTTP 404 .*\/vaults\/add$/);const response=await page.goto(`${server.origin}/vaults/add`);expect(response?.status()).toBe(404);await expect(page.getByRole("heading",{name:"Create vault",exact:true})).toHaveCount(0);await expect(page.locator("body")).not.toContainText(server.root);
 }finally{release.resolve();try{if(!page.isClosed())await page.goto("about:blank");}finally{await server.stop();}}
});
