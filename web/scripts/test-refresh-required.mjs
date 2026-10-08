import {hostileFrame} from './refresh-hostile-fixtures.mjs';
import {chromium,expect} from '@playwright/test';
import {build} from 'esbuild';
import {E2E_USER} from '../e2e/environment.ts';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,mkdtempSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join,resolve,isAbsolute} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';
const scripts=dirname(fileURLToPath(import.meta.url)),repo=resolve(scripts,'../..');
const requested=process.env.MB_REFRESH_EVIDENCE;
if(requested!==undefined&&(!isAbsolute(requested)||existsSync(requested)))throw Error('MB_REFRESH_EVIDENCE must be a new absolute path');
const root=requested??mkdtempSync(join(tmpdir(),'memberberry-refresh-'));
if(requested!==undefined)mkdirSync(root);
const evidence=join(root,'evidence');mkdirSync(evidence);
const save=(n,v)=>writeFileSync(join(evidence,n),JSON.stringify(v,null,2)+'\n');
const sha=b=>createHash('sha256').update(b).digest('hex');
const binary=process.env.MB_REFRESH_BINARY??join(repo,'target/debug/memberberry'),vault=join(root,'vault-focused'),config=join(root,'data-focused/server.toml');mkdirSync(vault);mkdirSync(dirname(config));
const initial='# Title\n\n:mb-style[[Later](https://example.org "")]{underline="true" color="red"} words\n';
for(const name of ['source','link','inbound','reload','apply','link-controls','inbound-unknown-attribute','inbound-unknown-mark','inbound-code-namespace-pair','inbound-pending-struct'])writeFileSync(join(vault,name+'.md'),initial);
writeFileSync(join(vault,'access.toml'),`[[members]]\nuser = "${E2E_USER.username}"\nrole = "owner"\n`);
writeFileSync(config,`bind = "127.0.0.1:0"\nweb_root = ${JSON.stringify(join(repo,'web/dist'))}\n`);
const rows=[],wire=[],assets=[],cleanup=[],errors=[],selector='.editor-surface .tiptap';let server,browser,context,origin,gate=false,proxy,client,held=[];
const disk=n=>readFileSync(join(vault,n+'.md'),'utf8');
function inventory(path,prefix=''){const rows={};for(const item of readdirSync(path,{withFileTypes:true})){const p=join(path,item.name),rel=prefix+item.name;if(item.isDirectory())Object.assign(rows,inventory(p,rel+'/'));else if(/\.(md|bin|last-write)$/.test(rel)){const b=readFileSync(p);rows[rel]={sha256:sha(b),bytes:b.length,hex:b.toString('hex')};}}return rows;}
async function stop(){if(server&&server.exitCode===null){const p=server;const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('shutdown timeout')),15000);p.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});p.kill('SIGTERM');});let absent=false;try{process.kill(p.pid,0);}catch(e){if(e.code==='ESRCH')absent=true;else throw e;}cleanup.push({pid:p.pid,result,absent});expect(result.code).toBe(0);expect(absent).toBe(true);}}
const snap=p=>p.evaluate(async()=>await (await import('/__test_readonly_observer.js')).snapshot());
function journal(direction,msg,extra={}){wire.push({direction,...(typeof msg==='string'?{text:msg}:{bytes:msg.length,hex:Buffer.from(msg).toString('hex'),sha256:sha(msg)}),...extra});save('wire.json',wire);}
try{
 await build({entryPoints:[join(scripts,'refresh-readonly-observer.mjs')],bundle:true,format:'esm',outfile:join(root,'observer-bundle.js'),platform:'browser'});
 for(const args of [['user','setup','--username',E2E_USER.username,'--password-stdin'],['vault','create','--slug','personal','--name','Personal','--path',vault,'--actor',E2E_USER.username,'--password-stdin']])execFileSync(binary,[...args,'--config',config],{input:E2E_USER.password+'\n',env:process.env,stdio:['pipe','pipe','pipe']});
 server=spawn(binary,['serve','--config',config],{env:process.env,stdio:['ignore','pipe','pipe']});
 origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server readiness timeout')),30000);for(const s of [server.stdout,server.stderr])s.on('data',c=>{writeFileSync(join(evidence,'server.log'),c,{flag:'a'});const m=c.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.once('exit',code=>{clearTimeout(timer);reject(Error('server exit '+code));});});
 save('runtime.json',{origin,pid:server.pid,serverSHA256:sha(readFileSync(binary)),wasmSHA256:sha(readFileSync(join(repo,'web/src/wasm/mb_bg.wasm'))),runtimeMode:'Fresh production frontend built from repair source; frozen source-bound native server and WASM reused, not recompiled.'});
 browser=await chromium.launch({headless:true});context=await browser.newContext({baseURL:origin,viewport:{width:1280,height:800}});expect(await context.storageState()).toEqual({cookies:[],origins:[]});
 expect((await context.request.post('/login',{form:{username:E2E_USER.username,password:E2E_USER.password},maxRedirects:0})).status()).toBe(303);
 await context.route('**/__test_readonly_observer.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(join(root,'observer-bundle.js'))}));
 const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('response',async r=>{if(new URL(r.url()).pathname.includes('mb_bg')&&new URL(r.url()).pathname.endsWith('.wasm')){assets.push({path:new URL(r.url()).pathname,sha256:sha(await r.body())});save('served-wasm.json',assets);}});
 await p.routeWebSocket('**/*',async ws=>{
  if(!ws.url().includes('/api/v1/sync')){ws.connectToServer();return;}
  journal('socket-attempt',ws.url());client=ws;proxy=ws.connectToServer();
  ws.onMessage(msg=>{journal('client-to-server',msg,{held:gate&&typeof msg!=='string'});if(gate&&typeof msg!=='string')held.push(Buffer.from(msg));else proxy.send(msg);});
  proxy.onMessage(msg=>{journal('server-to-client',msg);ws.send(msg);});
 });
 await p.goto('/v/personal/source.md');await expect(p.locator(selector)).toHaveAttribute('contenteditable','true');await expect(p.locator(selector)).toContainText('Later words');
 await p.waitForFunction(sel=>{const el=document.querySelector(sel),v=el?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{return v.hasFocus()&&v.posAtDOM(n.anchorNode,n.anchorOffset)===v.state.selection.anchor&&v.posAtDOM(n.focusNode,n.focusOffset)===v.state.selection.head;}catch{return false;}},selector);
 expect(proxy,'Actual declared /api/v1/sync transport seam installed').toBeTruthy();expect(wire.some(r=>r.direction==='server-to-client'&&r.text?.includes('\"schema_version\":3')),'Actual schema-3 admission received').toBe(true);
 // Real schema-3 native typing; exact durable server save is a positive control.
 await p.keyboard.press('Control+End');await p.keyboard.press('Home');for(let step=1;step<=11;step++){await p.keyboard.press('ArrowRight');await p.waitForFunction(({sel,step})=>{const v=document.querySelector(sel)?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{const wanted=v.state.doc.content.size-1-11+step;return v.hasFocus()&&v.state.selection.empty&&v.state.selection.head===wanted&&v.posAtDOM(n.anchorNode,n.anchorOffset)===wanted&&v.posAtDOM(n.focusNode,n.focusOffset)===wanted;}catch{return false;}},{sel:selector,step});}await p.waitForFunction(sel=>{const v=document.querySelector(sel)?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode)return false;try{return v.hasFocus()&&v.state.selection.empty&&v.state.selection.head===v.state.doc.content.size-1&&v.posAtDOM(n.anchorNode,n.anchorOffset)===v.state.selection.head;}catch{return false;}},selector);
 await p.keyboard.type('P');await expect.poll(()=>disk('source'),{timeout:15000}).toBe(initial.replace(/\n$/,'P\n'));
 await expect.poll(()=>p.locator('.connection-status').textContent()).toBe('');
 const positive=await snap(p);save('ordinary-positive.json',positive);expect(positive.pm.content[1].content[0].marks.find(m=>m.type==='link').attrs.title).toBe('');
 rows.push({name:'ordinary-schema3-native-autosave',passed:true,disk:disk('source'),actualAdmitted:wire.filter(r=>r.direction==='server-to-client'&&r.text?.includes('"admitted"'))});save('progress.json',{rows});
 // Gate ONLY future outgoing binary frames; actual client, binding and IndexedDB remain real.
 gate=true;await p.keyboard.type('Q');await expect.poll(()=>held.length).toBeGreaterThan(0);await expect(p.locator('.connection-status')).toContainText('unsent');
 await p.getByRole('button',{name:'Toggle Markdown source view',exact:true}).click();const source=p.getByRole('textbox',{name:'Markdown source',exact:true});await expect(source).toBeVisible();
 const draft='  \n# Title\n\n  independent source DRAFT  \n\tkeep whitespace\n';await source.fill(draft);await expect(source).toHaveValue(draft);
 // Read twice through the SAME persistent readonly IndexedDB observer until setup writes settle.
 const first=await snap(p);await expect.poll(async()=>JSON.stringify((await snap(p)).storage)).toBe(JSON.stringify(first.storage));
 const before=await snap(p);save('source-before.json',before);const beforeDisk=inventory(vault);save('source-disk-before.json',beforeDisk);await p.screenshot({path:join(evidence,'source-before.png'),fullPage:true});
 const attemptsBefore=wire.filter(r=>r.direction==='socket-attempt').length;
 // TEST ONLY: extra stale-revision subscribe on genuine authenticated socket. Actual unmodified server performs authorization/version refusal.
 const stale=JSON.stringify({type:'subscribe',vault:'personal',note:'source.md',schema_version:2});journal('TEST_ONLY_PROXY_STALE_SUBSCRIBE',stale);proxy.send(stale);
 await expect.poll(()=>wire.some(r=>r.direction==='server-to-client'&&r.text?.includes('schema_refresh_required'))).toBe(true);
 await expect(p.locator('.connection-status')).toContainText('Refresh required');
 const after=await snap(p);save('source-after.json',after);save('source-disk-after.json',inventory(vault));await p.screenshot({path:join(evidence,'source-after.png'),fullPage:true});writeFileSync(join(evidence,'source-after.html'),await p.content());
 save('source-observations.json',{draftBefore:before.source,draftAfter:after.source,yjsSame:before.yjsUpdateHex===after.yjsUpdateHex,pmSame:JSON.stringify(before.pm)===JSON.stringify(after.pm),indexeddbSame:JSON.stringify(before.storage)===JSON.stringify(after.storage),diskSame:JSON.stringify(beforeDisk)===JSON.stringify(inventory(vault)),heldOutgoingFrames:held.length,attemptsBefore,attemptsAfter:wire.filter(r=>r.direction==='socket-attempt').length,connectionBefore:before.connection,connectionAfter:after.connection,refreshMentions:after.bodyText.match(/.{0,60}(?:refresh|reload|schema).{0,60}/gi),refreshButtons:after.buttons.filter(b=>/refresh|reload/i.test((b.text??'')+' '+(b.label??''))),qualification:'TEST_ONLY proxy sends one extra schema_version:2 subscribe; genuine server schema refusal. Outgoing binary pending edit Q intentionally undelivered, client-pending only; P separately confirmed on disk. No mocked UI/storage/binding/WASM.'});
 expect(after.yjsUpdateHex).toBe(before.yjsUpdateHex);expect(after.pm).toEqual(before.pm);expect(after.storage).toEqual(before.storage);expect(after.source).toEqual(before.source);expect(inventory(vault)).toEqual(beforeDisk);
 // Acceptance requires explicit terminal refresh banner plus a user-visible refresh action, not generic Offline.
 expect(after.bodyText,'Terminal schema refusal must visibly require Refresh/Reload rather than report generic Offline').toMatch(/refresh|reload/i);
 expect(after.buttons.some(b=>/refresh|reload/i.test((b.text??'')+' '+(b.label??''))),'Missing user-visible refresh action').toBe(true);
 rows.push({name:'routed-source-stale-schema-terminal-banner',passed:true});save('result.json',{verdict:'PASS',rows});
// Supplemental focused scenarios appended to the unchanged GREEN assertions.
const appendRow=(name,extra={})=>{rows.push({name,passed:true,...extra});save('progress.json',{rows});};
const unchanged=(a,b)=>{expect(b.yjsUpdateHex).toBe(a.yjsUpdateHex);expect(b.pm).toEqual(a.pm);expect(b.storage).toEqual(a.storage);expect(b.source).toEqual(a.source);expect(b.linkInputs).toEqual(a.linkInputs);};
const nativeEnd=async page=>{
 await page.keyboard.press('Control+End');await page.keyboard.press('Home');
 for(let step=1;step<=11;step++){await page.keyboard.press('ArrowRight');await page.waitForFunction(({sel,step})=>{const v=document.querySelector(sel)?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{const wanted=v.state.doc.content.size-1-11+step;return v.hasFocus()&&v.state.selection.empty&&v.state.selection.head===wanted&&v.posAtDOM(n.anchorNode,n.anchorOffset)===wanted&&v.posAtDOM(n.focusNode,n.focusOffset)===wanted;}catch{return false;}},{sel:selector,step});}
};
const newFixture=async name=>{
 gate=false;held=[];proxy=undefined;client=undefined;
 context=await browser.newContext({baseURL:origin,viewport:{width:1280,height:800}});expect(await context.storageState()).toEqual({cookies:[],origins:[]});
 expect((await context.request.post('/login',{form:{username:E2E_USER.username,password:E2E_USER.password},maxRedirects:0})).status()).toBe(303);
 await context.route('**/__test_readonly_observer.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(join(root,'observer-bundle.js'))}));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('response',async r=>{if(new URL(r.url()).pathname.includes('mb_bg')&&r.url().endsWith('.wasm')){assets.push({path:new URL(r.url()).pathname,sha256:sha(await r.body())});save('served-wasm.json',assets);}});
 await page.routeWebSocket('**/*',ws=>{if(!ws.url().includes('/api/v1/sync')){ws.connectToServer();return;}journal('socket-attempt',ws.url());client=ws;proxy=ws.connectToServer();ws.onMessage(msg=>{journal('client-to-server',msg,{held:gate&&typeof msg!=='string'});if(gate&&typeof msg!=='string')held.push(Buffer.from(msg));else proxy.send(msg);});proxy.onMessage(msg=>{journal('server-to-client',msg);ws.send(msg);});});
 await page.goto('/v/personal/'+name+'.md');await expect(page.locator(selector)).toHaveAttribute('contenteditable','true');await expect(page.locator(selector)).toContainText('Later words');
 await page.waitForFunction(sel=>{const v=document.querySelector(sel)?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{return v.hasFocus()&&v.posAtDOM(n.anchorNode,n.anchorOffset)===v.state.selection.anchor&&v.posAtDOM(n.focusNode,n.focusOffset)===v.state.selection.head;}catch{return false;}},selector);
 const observed=await snap(page);await expect.poll(async()=>JSON.stringify((await snap(page)).storage)).toBe(JSON.stringify(observed.storage));
 return page;
};
const refuseVersion=async (page,name)=>{const start=wire.length,stale=JSON.stringify({type:'subscribe',vault:'personal',note:name+'.md',schema_version:2});journal('TEST_ONLY_PROXY_STALE_SUBSCRIBE',stale);proxy.send(stale);await expect.poll(()=>wire.slice(start).some(r=>r.direction==='server-to-client'&&r.text?.includes('schema_refresh_required'))).toBe(true);await expect(page.locator('.connection-status')).toContainText('Refresh required');};
const boundedTerminal=async(page,name,before,attempts)=>{
 const wireStart=wire.length;
 // Actual Chromium network toggles plus separately labelled browser event delivery.
 await context.setOffline(true);await context.setOffline(false);
 await page.evaluate(()=>{window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));});
 // A bounded observation window, not sleep-based setup synchronization; over initial reconnect delay.
 await page.evaluate(()=>new Promise(resolve=>{const start=performance.now();const check=()=>performance.now()-start>=1500?resolve():requestAnimationFrame(check);requestAnimationFrame(check);}));
 expect(wire.filter(r=>r.direction==='socket-attempt').length).toBe(attempts);
 expect(wire.slice(wireStart).filter(r=>r.direction==='client-to-server'&&r.hex)).toEqual([]);
 const after=await snap(page);unchanged(before,after);expect(after.connection[0].text).toMatch(/refresh required/i);save(name+'-bounded-events.json',{before,after,attempts,actualNetworkToggles:2,syntheticNetworkEvents:['offline','online'],boundedMilliseconds:1500,wireStart,wireEnd:wire.length});
};
// Existing Source scenario: retained direct handler refuses instead of hiding a draft.
await expect(p.getByRole('button',{name:'Reload editor',exact:true})).toBeDisabled();
await expect(p.getByRole('button',{name:'Toggle Markdown source view',exact:true})).toBeDisabled();
const refusedSource=await snap(p),diskSource=inventory(vault);
await p.evaluate(()=>{const button=document.querySelector('[aria-label="Toggle Markdown source view"]');button.disabled=false;button.click();});
await expect(source).toHaveValue(draft);await expect(source).toBeVisible();unchanged(refusedSource,await snap(p));expect(inventory(vault)).toEqual(diskSource);
appendRow('terminal-source-retained-handler-no-discard');
await boundedTerminal(p,'source',await snap(p),wire.filter(r=>r.direction==='socket-attempt').length);expect(inventory(vault)).toEqual(diskSource);appendRow('terminal-source-no-reconnect-or-flush');await context.close();
// Independent link destination only; authored empty title is never a new title field.
{
 const page=await newFixture('link');await page.keyboard.press('Control+End');await page.keyboard.press('Home');for(let i=0;i<5;i++)await page.keyboard.press('Shift+ArrowRight');
 await expect.poll(()=>page.evaluate(()=>document.getSelection()?.toString())).toBe('Later');const tools=page.getByRole('toolbar',{name:'Selected text formatting'});await expect(tools).toBeVisible();await tools.getByRole('button',{name:'Link',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Link destination',exact:true}),linkDraft='  https://example.net/independent?x=1  ';await input.fill(linkDraft);await expect(input).toHaveValue(linkDraft);expect(await page.locator('.selection-link-editor input').count()).toBe(1);
 const before=await snap(page),beforeDisk=inventory(vault);save('link-before.json',before);await refuseVersion(page,'link');const after=await snap(page);save('link-after.json',after);unchanged(before,after);expect(inventory(vault)).toEqual(beforeDisk);expect(after.pm.content[1].content[0].marks.find(m=>m.type==='link').attrs.title).toBe('');
 await expect(page.getByRole('button',{name:'Apply link',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Reload editor',exact:true})).toBeDisabled();
 await page.locator('.selection-link-editor').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await input.press('Tab');await expect(input).toBeVisible();await expect(input).toHaveValue(linkDraft);unchanged(after,await snap(page));expect(inventory(vault)).toEqual(beforeDisk);await page.screenshot({path:join(evidence,'link-refusal.png'),fullPage:true});appendRow('terminal-independent-link-draft-and-title-retained');
 await boundedTerminal(page,'link',await snap(page),wire.filter(r=>r.direction==='socket-attempt').length);expect(inventory(vault)).toEqual(beforeDisk);appendRow('terminal-link-no-reconnect-or-flush');await context.close();
}
// Hostile inbound shapes are TEST ONLY, not server publication. The real server refuses them separately in inherited67 checks.
for(const kind of ['unknown-attribute','unknown-mark','code-namespace-pair','pending-struct']){
 const name='inbound-'+kind,page=await newFixture(name);await nativeEnd(page);gate=true;await page.keyboard.type('Q');await expect.poll(()=>held.length).toBe(1);await expect(page.locator('.connection-status')).toContainText('1 unsent change');
 await page.getByRole('button',{name:'Toggle Markdown source view',exact:true}).click();const field=page.getByRole('textbox',{name:'Markdown source',exact:true});await field.fill('  \n# Title\n\n inbound independent draft '+kind+'  \n');
 const settled=await snap(page);await expect.poll(async()=>JSON.stringify((await snap(page)).storage)).toBe(JSON.stringify(settled.storage));const before=await snap(page),beforeDisk=inventory(vault);save(name+'-before.json',before);
 const incoming=hostileFrame(before,kind,name);journal('TEST_ONLY_HOSTILE_INBOUND',incoming,{kind});client.send(incoming);
 await expect(page.locator('.connection-status')).toContainText('Refresh required');const after=await snap(page);save(name+'-after.json',after);unchanged(before,after);expect(inventory(vault)).toEqual(beforeDisk);await expect(page.getByRole('button',{name:'Reload editor',exact:true})).toBeDisabled();
 // Actual installed guarded editor refuses direct PM writes after terminal admission loss.
 await page.locator(selector).evaluate(el=>{const editor=el.editor;editor.view.dispatch(editor.state.tr.insertText('must-not-write ',editor.state.doc.child(0).nodeSize+1));});unchanged(after,await snap(page));expect(inventory(vault)).toEqual(beforeDisk);
 appendRow(name+'-pre-binding-refusal',{hostileInjection:true,heldFrames:held.length});await context.close();
}
// Non-dirty explicit Reload must re-admit, without deleting/migrating any resident cache.
{
 const page=await newFixture('reload'),before=await snap(page),beforeDisk=inventory(vault);await refuseVersion(page,'reload');const refused=await snap(page);unchanged(before,refused);const reload=page.getByRole('button',{name:'Reload editor',exact:true});await expect(reload).toBeEnabled();
 const attempts=wire.filter(r=>r.direction==='socket-attempt').length;await Promise.all([page.waitForNavigation(),reload.click()]);await expect(page.locator(selector)).toHaveAttribute('contenteditable','true');await expect(page.locator(selector)).toContainText('Later words');await expect(page.locator('.connection-status')).toHaveText('');
 const after=await snap(page);save('safe-explicit-reload-observations.json',{before,refused,after});expect(after.pm).toEqual(before.pm);// Reload creates a NEW observer/lifecycle: opening time and an empty update may be appended.
 // Every preexisting key/value must survive; no wipe, replacement or migration is allowed.
 for(const [dbName,oldDB]of Object.entries(before.storage)){
  const next=after.storage[dbName];expect(next.version).toBe(oldDB.version);expect(Object.keys(next.stores)).toEqual(Object.keys(oldDB.stores));
  for(const [storeName,oldStore]of Object.entries(oldDB.stores)){
   const nextStore=next.stores[storeName];
   for(let i=0;i<oldStore.keys.length;i++){
    const at=nextStore.keys.findIndex(key=>JSON.stringify(key)===JSON.stringify(oldStore.keys[i]));expect(at).toBeGreaterThanOrEqual(0);
    const prior=oldStore.rows[i],current=nextStore.rows[at];
    if(storeName==='bodies'&&dbName==='memberberry:offline:schema:3'&&prior&&typeof prior==='object'&&'openedAt'in prior){expect({...current,openedAt:prior.openedAt}).toEqual(prior);expect(current.openedAt).toBeGreaterThanOrEqual(prior.openedAt);}
    else expect(current).toEqual(prior);
   }
   if(storeName==='updates')for(let i=oldStore.keys.length;i<nextStore.keys.length;i++)expect(nextStore.rows[i]).toEqual({typed:'Uint8Array',hex:'0000'});
   else expect(nextStore.keys).toEqual(oldStore.keys);
  }
 }
 expect(inventory(vault)).toEqual(beforeDisk);expect(wire.filter(r=>r.direction==='socket-attempt').length).toBe(attempts+1);save('safe-explicit-reload.json',{before,refused,after});appendRow('safe-nondirty-explicit-reload');await context.close();
}
// Ordinary accepted Source and link workflow controls remain production/WASM/server/disk real.
{
 const page=await newFixture('apply');await page.getByRole('button',{name:'Toggle Markdown source view',exact:true}).click();const field=page.getByRole('textbox',{name:'Markdown source',exact:true});await field.fill(initial.replace(' words\n',' changed\n'));await page.getByRole('button',{name:'Toggle Markdown source view',exact:true}).click();await expect(field).toBeHidden();await expect.poll(()=>disk('apply'),{timeout:15000}).toBe(initial.replace(' words\n',' changed\n'));appendRow('ordinary-source-apply-durable-positive');await context.close();
}
{
 const page=await newFixture('link-controls');
 await page.keyboard.press('Control+End');await page.keyboard.press('Home');for(let i=0;i<5;i++)await page.keyboard.press('Shift+ArrowRight');await expect.poll(()=>page.evaluate(()=>document.getSelection()?.toString())).toBe('Later');
 const tools=page.getByRole('toolbar',{name:'Selected text formatting'});await expect(tools).toBeVisible();await tools.getByRole('button',{name:'Link',exact:true}).click();const destination=page.getByRole('textbox',{name:'Link destination',exact:true});await destination.fill('javascript:alert(1)');const beforeLink=await snap(page),beforeLinkDisk=inventory(vault);
 await page.getByRole('button',{name:'Apply link',exact:true}).click();await expect(page.locator('.selection-link-editor [role=status]')).toHaveText('Enter a safe URL or note reference.');const refusedLink=await snap(page);unchanged(beforeLink,refusedLink);expect(inventory(vault)).toEqual(beforeLinkDisk);appendRow('ordinary-invalid-link-refused-no-write');
 await destination.fill('https://example.net/accepted');await page.getByRole('button',{name:'Apply link',exact:true}).click();const expected=initial.replace('https://example.org','https://example.net/accepted');await expect.poll(()=>disk('link-controls'),{timeout:15000}).toBe(expected);const acceptedLink=await snap(page);expect(acceptedLink.pm.content[1].content[0].marks.find(m=>m.type==='link').attrs.title).toBe('');save('ordinary-link-controls.json',{beforeLink,refusedLink,acceptedLink,markdown:disk('link-controls')});appendRow('ordinary-link-accepted-durable-title-preserved');await context.close();
}
// Same vault, new PID, genuinely fresh Chromium and empty context.
await context.close();await browser.close();browser=undefined;const firstPID=server.pid;await stop();const retained=inventory(vault);save('retained-before-restart.json',retained);
server=spawn(binary,['serve','--config',config],{env:process.env,stdio:['ignore','pipe','pipe']});origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('restart readiness timeout')),30000);for(const stream of [server.stdout,server.stderr])stream.on('data',c=>{writeFileSync(join(evidence,'restart-server.log'),c,{flag:'a'});const m=c.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.once('exit',code=>{clearTimeout(timer);reject(Error('restart exited '+code));});});expect(server.pid).not.toBe(firstPID);browser=await chromium.launch({headless:true});
for(const name of ['source','link','reload']){const page=await newFixture(name),state=await snap(page);expect(disk(name)).toBe(name==='source'?initial.replace(/\n$/,'P\n'):initial);expect(state.pm.content[1].content[0].marks.find(m=>m.type==='link').attrs.title).toBe('');expect(state.source[0].hidden).toBe(true);expect(state.connection[0].text).toBe('');save('reopen-'+name+'.json',{state,markdown:disk(name),pid:server.pid,emptyInitialBrowserContext:true});appendRow('restart-fresh-browser-'+name);await context.close();}
await browser.close();browser=undefined;await stop();expect(inventory(vault)).toEqual(retained);save('retained-after-restart.json',inventory(vault));expect(errors).toEqual([]);for(const asset of assets)expect(asset.sha256).toBe(sha(readFileSync(join(repo,'web/src/wasm/mb_bg.wasm'))));
save('result.json',{verdict:'PASS',rows,errors,assets,cleanup});

}catch(e){if(context){for(const page of context.pages()){try{save('failed-state.json',await snap(page));await page.screenshot({path:join(evidence,'failed-state.png'),fullPage:true});}catch(observe){save('failed-observer.json',{message:observe.message});}}}save('failure.json',{verdict:'FAIL',message:e.message,stack:e.stack,rows,errors,assets,heldOutgoingFrames:held.length,unexecuted:['see progress rows and planned scenarios; later rows may be unexecuted'],transportQualification:'TEST_ONLY extra stale subscribe, actual authenticated server refusal; held outgoing binary timing gate'});process.exitCode=1;}
finally{await context?.close();await browser?.close();await stop();save('final-disk.json',inventory(vault));save('cleanup.json',cleanup);save('wire.json',wire);save('STATUS.json',{phase:'completed stop-first gate',rows,cleanup,exitCode:process.exitCode??0});}
