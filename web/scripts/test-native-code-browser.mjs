// Isolated ephemeral fixture, never the running application or a real note.
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const evidence=process.env.MB_CODE_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence)&&fs.statSync(evidence).isDirectory());
const web=process.cwd();const server=await createServer({root:web,configFile:false,cacheDir:path.join(evidence,'browser-vite'),server:{host:'127.0.0.1',port:0,fs:{allow:[web,path.resolve(web,'node_modules')]}},optimizeDeps:{noDiscovery:true,include:[]}});
let browser;const results=[];
try {
 await server.listen();const address=server.httpServer.address();assert(address&&typeof address==='object');
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.goto(`http://127.0.0.1:${address.port}/scripts/native-code-browser-fixture.ts`);
 // A module response is displayed as text; load the isolated fixture into a fresh document.
 await page.setContent('<html><body></body></html>');
 await page.evaluate(async()=>{window.fixture=await import('/scripts/native-code-browser-fixture.ts')});
 for(const [name,body] of [['strong','**`literal`**\n'],['em','*`literal`*\n'],['strikethrough','~~`literal`~~\n'],['highlight','==`literal`==\n'],['link','[`literal`](https://example.org "Authored title")\n']]) {
  const before=await page.evaluate(body=>window.fixture.mount(body),body);
  assert(before.focused&&before.nativeFocused&&before.selection===3);
  await page.keyboard.type('Z');
  await page.waitForFunction(()=>document.querySelector('.ProseMirror')?.textContent==='liZteral');
  const typed=await page.evaluate(()=>window.fixture.inspect());assert(typed.markdown.includes('liZteral'));
  assert(await page.evaluate(()=>window.fixture.history('undo')));
  const undone=await page.evaluate(()=>window.fixture.inspect());assert.deepEqual(undone.pm,before.pm);assert.equal(undone.markdown,before.markdown);
  assert(await page.evaluate(()=>window.fixture.history('redo')));
  const redone=await page.evaluate(()=>window.fixture.inspect());assert.equal(redone.markdown,typed.markdown);
  const reopened=await page.evaluate(()=>window.fixture.reopen());assert.equal(reopened.binaryMarkdown,typed.markdown);
  const formatted=await page.evaluate(()=>window.fixture.format());assert(formatted.capability&&formatted.result==='applied');
  assert(formatted.pm.content[0].content[0].marks.some(m=>m.type==='code'));
  if(name==='link')assert(formatted.markdown.includes('"Authored title"'));
  results.push({name,before,typed,undone,redone,reopened,formatted});
 }
 console.log(JSON.stringify({passed:true,cases:results.length,port:address.port}));
}finally{fs.writeFileSync(path.join(evidence,'browser-binding.json'),JSON.stringify(results,null,2));await browser?.close();await server.close();}
