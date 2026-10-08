// Scratch-only routed durable acceptance. Fixture-only API auth, no secrets logged.
import {chromium,expect} from '@playwright/test';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,existsSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {combined,paletteWitness,paletteMarkdown} from './md-style-host-witness.mjs';
import {E2E_USER} from '../e2e/environment.ts';
// Run after building mb-cli and the production web bundle. All fixture data stays owned here.
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const requested=process.env['MB_STYLE_HOST_EVIDENCE'];
if(requested!==undefined&&(!isAbsolute(requested)||existsSync(requested)))throw Error('MB_STYLE_HOST_EVIDENCE must be a new absolute path');
const evidence=requested??mkdtempSync(join(tmpdir(),'memberberry-style-hosts-'));
if(requested!==undefined)mkdirSync(evidence);
const root=evidence;
const visual=[];
const vault=join(evidence,'vault'),config=join(evidence,'data/server.toml');mkdirSync(vault);mkdirSync(dirname(config));
const initial='# Title\n\nLater words\n';
for(const name of ['desktop','mobile','mixed','code','titles'])writeFileSync(join(vault,name+'.md'),name==='mixed'?'# Title\n\n:mb-style[Later]{color="red" background="yellow" size="large"} words\n':name==='code'?'# Title\n\n`Later` words\n':name==='titles'?'# Title\n\n[Later](https://example.org "") words\n':initial);
writeFileSync(join(vault,'palette.md'),paletteMarkdown+'\n![[Private/Secret]]\n');
mkdirSync(join(vault,'Private'));writeFileSync(join(vault,'Private/Secret.md'),'# Private token secret fixture\n\nPRIVATE-R3-NOT-FOR-PUBLIC\n');
writeFileSync(join(vault,'access.toml'),`[[members]]\nuser = "${E2E_USER.username}"\nrole = "owner"\n\n[[rules]]\npath = "Private"\ngrant = { ${E2E_USER.username} = "none" }\n`);
writeFileSync(config,`bind = "127.0.0.1:0"\nweb_root = ${JSON.stringify(join(repo,'web/dist'))}\n`);
const binary=process.env['MB_STYLE_HOST_BINARY']??join(repo,'target/debug/memberberry'),sha=b=>createHash('sha256').update(b).digest('hex');
const rows=[],reopens=[],assets=[],errors=[],cleanup=[],save=(name,value)=>writeFileSync(join(evidence,name),JSON.stringify(value,null,2)+'\n');
let server,browser,origin;const selector='.editor-surface .tiptap';
const disk=name=>readFileSync(join(vault,name+'.md'),'utf8');
function inventory(path,prefix='') {const files={};for(const name of readdirSync(path,{withFileTypes:true})){const rel=prefix+name.name;if(name.isDirectory())Object.assign(files,inventory(join(path,name.name),rel+'/'));else if(rel.endsWith('.bin')||rel.endsWith('.last-write')||rel.endsWith('.md')){const b=readFileSync(join(path,name.name));files[rel]={sha256:sha(b),bytes:b.length,hex:b.toString('hex')};}}return files;}
async function start(phase){server=spawn(binary,['serve','--config',config],{env:process.env,stdio:['ignore','pipe','pipe']});const pid=server.pid;origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('server readiness')),30000);const append=c=>writeFileSync(join(evidence,phase+'-server.log'),c,{flag:'a'});server.stderr.on('data',append);server.stdout.on('data',c=>{append(c);const m=c.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.once('exit',code=>{clearTimeout(timer);reject(Error('server exited '+code));});});return pid;}
async function stop(){if(server?.exitCode===null){const p=server;const exited=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned shutdown timeout')),15000);p.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});p.kill('SIGTERM');});let absent=false;try{process.kill(p.pid,0);}catch(e){if(e.code==='ESRCH')absent=true;else throw e;}expect(absent).toBe(true);expect(exited.code).toBe(0);cleanup.push({pid:p.pid,exited,absent});}}
async function context(mobile=false){const c=await browser.newContext({baseURL:origin,viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile});expect(await c.storageState()).toEqual({cookies:[],origins:[]});const login=await c.request.post('/login',{form:{username:E2E_USER.username,password:E2E_USER.password},maxRedirects:0});expect(login.status()).toBe(303);return c;}
async function open(c,name){const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('response',async r=>{if(new URL(r.url()).pathname.endsWith('.wasm'))assets.push({path:new URL(r.url()).pathname,sha256:sha(await r.body())});});await p.goto('/v/personal/'+name+'.md');await expect(p.locator(selector)).toHaveAttribute('contenteditable','true');await p.waitForFunction(sel=>{const el=document.querySelector(sel),v=el?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;const r=el.getBoundingClientRect();try{return v.hasFocus()&&document.activeElement===el&&r.top>=0&&r.bottom<=innerHeight&&v.posAtDOM(n.anchorNode,n.anchorOffset)===v.state.selection.anchor&&v.posAtDOM(n.focusNode,n.focusOffset)===v.state.selection.head;}catch{return false;}},selector);return p;}
async function selectLater(p,count=5){await p.keyboard.press('Control+End');await p.keyboard.press('Home');for(let i=0;i<count;i++)await p.keyboard.press('Shift+ArrowRight');await expect.poll(()=>p.evaluate(()=>document.getSelection()?.toString())).toBe(count===5?'Later':'Later words');const t=p.getByRole('toolbar',{name:'Selected text formatting'});await expect(t).toBeVisible();return t;}
const pm=p=>p.locator(selector).evaluate(el=>el.editor.getJSON());
const STYLE='Text color, background and size';
async function stylePanel(t){const toggle=t.getByRole('button',{name:STYLE,exact:true});if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();return t.getByRole('dialog',{name:STYLE,exact:true});}
async function styles(t){await t.getByRole('button',{name:'Underline',exact:true}).click();const panel=await stylePanel(t);for(const name of ['Red text','Yellow background','Large text size'])await panel.getByRole('button',{name,exact:true}).click();}
try{
for(const args of [['user','setup','--username',E2E_USER.username,'--password-stdin'],['vault','create','--slug','personal','--name','Personal','--path',vault,'--actor',E2E_USER.username,'--password-stdin']])execFileSync(binary,[...args,'--config',config],{input:E2E_USER.password+'\n',env:process.env,stdio:['pipe','pipe','pipe']});
const firstPID=await start('initial');browser=await chromium.launch({headless:true});
for(const name of ['desktop','mobile','titles']){
 const c=await context(name==='mobile'),p=await open(c,name),before=await pm(p);
 await p.keyboard.press('Control+End');await p.keyboard.press('Home');
 for(let i=0;i<11;i++){
  await p.keyboard.press('ArrowRight');
  await p.waitForFunction(({sel,step})=>{const el=document.querySelector(sel),v=el?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{const wanted=v.state.doc.content.size-1-11+step;return v.hasFocus()&&v.state.selection.empty&&v.state.selection.head===wanted&&v.posAtDOM(n.anchorNode,n.anchorOffset)===wanted&&v.posAtDOM(n.focusNode,n.focusOffset)===wanted;}catch{return false;}},{sel:selector,step:i+1});
 }
 await p.waitForFunction(sel=>{const el=document.querySelector(sel),v=el?.editor?.view,n=document.getSelection();if(!v||!n?.anchorNode||!n?.focusNode)return false;try{const end=v.state.doc.content.size-1;return v.hasFocus()&&v.state.selection.empty&&v.state.selection.head===end&&v.posAtDOM(n.anchorNode,n.anchorOffset)===end&&v.posAtDOM(n.focusNode,n.focusOffset)===end;}catch{return false;}},selector);
 await p.keyboard.type('Z');
 const typedDisk=disk(name).replace(/\n$/,'Z\n'); // expected below derives from immutable source, not observed post-save
 const expectedTyped=(name==='titles'?'# Title\n\n[Later](https://example.org "") words\n':initial).replace(/\n$/,'Z\n');
 await expect.poll(()=>disk(name),{timeout:15000}).toBe(expectedTyped);const typed=await pm(p);
 await p.keyboard.press('Meta+z');await expect.poll(()=>disk(name),{timeout:15000}).toBe(name==='titles'?'# Title\n\n[Later](https://example.org "") words\n':initial);expect(await pm(p)).toEqual(before);
 await p.keyboard.press('Meta+Shift+z');await expect.poll(()=>disk(name),{timeout:15000}).toBe(expectedTyped);expect(await pm(p)).toEqual(typed);
 await p.keyboard.press('Meta+z');await expect.poll(()=>disk(name),{timeout:15000}).toBe(name==='titles'?'# Title\n\n[Later](https://example.org "") words\n':initial);
 const t=await selectLater(p);await styles(t);
 const expected=name==='titles'?'# Title\n\n:mb-style[[Later](https://example.org "")]{underline="true" color="red" background="yellow" size="large"} words\n':'# Title\n\n:mb-style[Later]{underline="true" color="red" background="yellow" size="large"} words\n';
 await expect.poll(()=>disk(name),{timeout:15000}).toBe(expected);
 visual.push({host:'rich-editor',name,observed:await combined(p)});
 rows.push({name,pm:await pm(p),markdown:disk(name),history:true});await c.close();save('progress.json',{rows,reopens,assets,cleanup});
}
{
 const c=await context(),p=await open(c,'mixed'),t=await selectLater(p,11);
 const panel=await stylePanel(t);
 for(const name of ['Text color','Background','Size'])await expect(panel.getByRole('group',{name:`${name} · Mixed`,exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Default text color',exact:true}).click();
 await expect.poll(()=>disk('mixed'),{timeout:15000}).toBe('# Title\n\n:mb-style[Later]{background="yellow" size="large"} words\n');
 await panel.getByRole('button',{name:'No background',exact:true}).click();
 await expect.poll(()=>disk('mixed'),{timeout:15000}).toBe('# Title\n\n:mb-style[Later]{size="large"} words\n');
 await panel.getByRole('button',{name:'Normal size',exact:true}).click();
 await expect.poll(()=>disk('mixed'),{timeout:15000}).toBe(initial);
 for(const name of ['Default text color','No background','Normal size'])await expect(panel.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true');
 await styles(t);await expect.poll(()=>disk('mixed'),{timeout:15000}).toBe('# Title\n\n:mb-style[Later words]{underline="true" color="red" background="yellow" size="large"}\n');
 visual.push({host:'mixed-rich-editor',observed:await combined(p)});
 await t.getByRole('button',{name:'Clear formatting',exact:true}).click();await expect.poll(()=>disk('mixed'),{timeout:15000}).toBe(initial);
 rows.push({name:'mixed',pm:await pm(p),markdown:disk('mixed'),mixed:true,dimensionDefault:true,allDimensionsDefault:true,explicitClear:true});await c.close();
}
{
 const c=await context(),p=await open(c,'code'),t=await selectLater(p);const before=await pm(p),source=disk('code');
 await expect(t.getByRole('button',{name:'Underline',exact:true})).toBeDisabled();
 await expect(t.getByRole('button',{name:STYLE,exact:true})).toBeDisabled();
 expect(await pm(p)).toEqual(before);expect(disk('code')).toBe(source);rows.push({name:'code',pm:before,markdown:source,refused:true});await c.close();
}

{
 const c=await context(),p=await c.newPage();
 await p.addInitScript(()=>{window.print=()=>{document.documentElement.dataset.printCalled='true';};});
 await p.goto('/v/personal/palette.md');await expect(p.locator(selector)).toHaveAttribute('contenteditable','true');await expect(p.locator('.editor-surface .mb-color-gray')).toHaveText('gray');
 for(const theme of ['light','dark']){
  await p.emulateMedia({colorScheme:theme});await p.evaluate(theme=>{document.documentElement.dataset.theme='memberberry-'+theme;},theme);
  visual.push({host:'rich-palette',observed:await paletteWitness(p,'.editor-surface',theme)});
 }
 await p.locator('.editor-more > summary').click();
 const download=p.waitForEvent('download');await p.getByRole('button',{name:'Export note as self-contained HTML'}).click();const artifact=await download;
 const portable=join(evidence,'standalone.html');await artifact.saveAs(portable);
 const exported=readFileSync(portable,'utf8');expect(exported.slice(exported.indexOf('<body'))).not.toContain('contenteditable');expect(exported).toContain('.mb-underline');expect(exported).not.toContain('PRIVATE-R3-NOT-FOR-PUBLIC');
 const portableContext=await browser.newContext({javaScriptEnabled:false});const portablePage=await portableContext.newPage();await portablePage.goto('file://'+portable);
 for(const theme of ['light','dark']){await portablePage.emulateMedia({colorScheme:theme});visual.push({host:'standalone-js-disabled',observed:await paletteWitness(portablePage,'.standalone-note',theme)});}
 await portableContext.close();
 await p.getByRole('button',{name:'Print note or save it as PDF'}).click();await expect(p.locator('html')).toHaveAttribute('data-print-called','true');await expect(p.locator('.editor-panel[data-printing="true"]')).toHaveCount(1);
 await p.emulateMedia({media:'print',colorScheme:'light'});await p.evaluate(()=>{document.documentElement.dataset.theme='memberberry-light';});
 visual.push({host:'print-media-real-control',observed:await paletteWitness(p,'.editor-panel[data-printing="true"] .editor-surface','light')});
 await expect(p.locator('.editor-controls')).toBeHidden();await expect(p.locator('.editor-surface .mb-color-red')).toBeVisible();await p.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await p.emulateMedia({media:'screen'});
 const created=await c.request.post('/api/v1/vaults/personal/shares',{data:{note:'palette.md',include_embeds:true,password:null,expires_at:null,never_expires:true}});expect(created.status()).toBe(201);
 const share=await created.json();const anon=await browser.newContext({baseURL:origin,javaScriptEnabled:false});const publicPage=await anon.newPage();await publicPage.goto(share.url);
 expect(await publicPage.content()).not.toContain('PRIVATE-R3-NOT-FOR-PUBLIC');await expect(publicPage.locator('[contenteditable=true]')).toHaveCount(0);
 for(const theme of ['light','dark']){await publicPage.emulateMedia({colorScheme:theme});visual.push({host:'anonymous-safe-share',observed:await paletteWitness(publicPage,'main',theme)});}
 const denied=await anon.request.get('/v/personal/Private/Secret.md');expect(denied.status()).not.toBe(200);
 await anon.close();await c.close();save('visual-progress.json',visual);
}
execFileSync(binary,['export','--static-site',join(evidence,'static-site'),'--username',E2E_USER.username,'--slug','personal','--config',config],{env:process.env,stdio:['ignore','pipe','pipe']});
{
 const c=await browser.newContext({javaScriptEnabled:false}),p=await c.newPage();await p.goto('file://'+join(evidence,'static-site/notes/palette.html'));
 for(const theme of ['light','dark']){await p.emulateMedia({colorScheme:theme});visual.push({host:'static-export-js-disabled',observed:await paletteWitness(p,'main',theme,readFileSync(join(evidence,'static-site/site.css'),'utf8'))});}
 expect(readFileSync(join(evidence,'static-site/site-data.js'),'utf8')).not.toContain('PRIVATE-R3-NOT-FOR-PUBLIC');await c.close();save('visual-progress.json',visual);
}

await browser.close();browser=undefined;await stop();const retained=inventory(vault);save('retained-after-shutdown.json',retained);
const secondPID=await start('restart');expect(secondPID).not.toBe(firstPID);browser=await chromium.launch({headless:true});
for(const row of rows){const c=await context(row.name==='mobile'),p=await open(c,row.name);expect(await pm(p)).toEqual(row.pm);expect(disk(row.name)).toBe(row.markdown);if(['desktop','mobile','titles'].includes(row.name))visual.push({host:'restarted-rich-editor',name:row.name,observed:await combined(p)});reopens.push({name:row.name,pm:await pm(p),markdown:disk(row.name)});await c.close();}
await browser.close();browser=undefined;await stop();expect(inventory(vault)).toEqual(retained);
const expectedWasm=sha(readFileSync(join(repo,'web/src/wasm/mb_bg.wasm'))),codec=assets.filter(a=>a.path.includes('mb_bg'));
expect(codec.length).toBeGreaterThan(0);for(const a of codec)expect(a.sha256).toBe(expectedWasm);expect(errors).toEqual([]);

const fallbackConfig=join(dirname(config),'fallback.toml');writeFileSync(fallbackConfig,readFileSync(config,'utf8').replace(/^web_root = .*$/m,`web_root = ${JSON.stringify(join(evidence,'no-web-bundle'))}`));
server=spawn(binary,['serve','--config',fallbackConfig],{env:process.env,stdio:['ignore','pipe','pipe']});
origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fallback readiness')),30000);for(const pipe of [server.stdout,server.stderr])pipe.on('data',c=>{writeFileSync(join(evidence,'fallback-server.log'),c,{flag:'a'});const m=c.toString().match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});server.once('exit',code=>{clearTimeout(timer);reject(Error('fallback exit '+code));});});
browser=await chromium.launch({headless:true});
{
 const c=await context(),p=await c.newPage();await p.goto('/v/personal/palette.md');await expect(p.locator('main .mb-color-gray')).toHaveText('gray');await expect(p.locator('[contenteditable=true]')).toHaveCount(0);
 for(const theme of ['light','dark']){await p.emulateMedia({colorScheme:theme});visual.push({host:'asset-free-authenticated-fallback',observed:await paletteWitness(p,'main',theme)});}
 expect(await p.content()).not.toContain('PRIVATE-R3-NOT-FOR-PUBLIC');await c.close();
}
await browser.close();browser=undefined;await stop();expect(inventory(vault)).toEqual(retained);save('visual-result.json',{verdict:'SHARED_CSS_HOSTS_PASS',visual});

save('result.json',{verdict:'SCOPED_ROUTED_DURABLE_PASS',rows,reopens,assets,errors,cleanup,firstPID,secondPID,wasmSHA256:expectedWasm,binarySHA256:sha(readFileSync(binary))});
}catch(e){save('failure.json',{message:e.message,stack:e.stack,rows,reopens,assets,errors,cleanup,visual});process.exitCode=1;}
finally{await browser?.close();await stop();save('cleanup.json',cleanup);}
