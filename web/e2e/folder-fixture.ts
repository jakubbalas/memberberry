import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chown, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, E2E_WEB_ROOT, E2E_USER } from "./environment.js";
import type { Page } from "@playwright/test";
/** An isolated loopback-only service, with explicit fresh-process restart and guaranteed cleanup. */
/**
 * A loopback port the OS reports free, held for this fixture's lifetime.
 *
 * why: the fixture used to bind 9012, which is the main E2E server's port (AGENTS.md §5.1), so
 * under `make e2e` every folder spec failed with "exited before readiness". One port per
 * fixture rather than port 0 per start, because `restart()` must come back on the same
 * origin: the page, its storage and its cookies stay pointed at it.
 */
async function freePort(): Promise<number> {
 return new Promise<number>((resolve,reject)=>{
  const probe=createServer();
  probe.once("error",reject);
  probe.listen(0,"127.0.0.1",()=>{
   const address=probe.address();
   const port=typeof address==="object"&&address!==null?address.port:0;
   probe.close(()=>port>0?resolve(port):reject(new Error("the OS reported no free port")));
  });
 });
}

/**
 * Every folder server this worker has started and not yet seen exit.
 *
 * why: a spec stops its server in `finally`, which never runs when the test times out — the
 * test body is abandoned mid-await. The worker then exits and the server, a child with no
 * parent left, kept running: 71 of them accumulated on one Mac from the folder specs that
 * fail on macOS by design. A signal sent from `exit` is synchronous, so it still lands.
 */
const running=new Set<ChildProcess>();
process.once("exit",()=>{for(const child of running)child.kill("SIGTERM");});

export async function folderServer(locations:"configured"|"empty"|"none"|"multiple"="configured",unprivileged=false): Promise<{root:string;config:string;serviceUid:number;serviceGid:number;readonly origin:string;readonly pid:number|undefined;restart:()=>Promise<void>;stop:()=>Promise<void>}> {
 const root=await mkdtemp(join(tmpdir(),"memberberry-folders-")),projects=join(root,"projects"),config=join(root,"server.toml");
 const binary=process.env["FOLDER_BINARY"]??join(REPO,"target/debug/memberberry");
 const serviceUid=unprivileged&&process.getuid?.()===0?65534:(process.getuid?.()??0),serviceGid=unprivileged&&process.getuid?.()===0?65534:(process.getgid?.()??0);
 const identity=unprivileged?{uid:serviceUid,gid:serviceGid}:{};
 let child:ChildProcess|undefined,stopped:Promise<void>=Promise.resolve(),origin="";
 async function halt():Promise<void>{if(child!==undefined&&child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM");await stopped;child=undefined;}
 async function start():Promise<void>{
  child=spawn(binary,["serve","--config",config],{cwd:REPO,...identity});const current=child;running.add(current);current.once("exit",()=>running.delete(current));stopped=new Promise<void>(resolve=>current.once("close",()=>resolve()));
  // Drain diagnostics without publishing fixture identity/authentication material.
  current.stderr?.on("data",()=>undefined);
  origin=await new Promise<string>((resolve,reject)=>{
   let output="";const timer=setTimeout(()=>reject(new Error("Disposable folder service readiness timed out")),15000);
   current.once("error",()=>{clearTimeout(timer);reject(new Error("Disposable folder service could not start"));});
   current.once("exit",()=>{clearTimeout(timer);reject(new Error("Disposable folder service exited before readiness"));});
   current.stdout?.on("data",(b:Buffer)=>{output+=b.toString();const address=/listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];if(address!==undefined){clearTimeout(timer);resolve(address);}});
  });
 }
 try{
  await mkdir(projects);
  const files:Readonly<Record<string,string>>=locations!=="configured"?{}:{
   "日本: 100%/README.md":"# Project\n\nA disposable Markdown project.\n",
   "日本: 100%/build/Generated.md":"# Build note\n\nBuild Markdown is not excluded.\n",
   "日本: 100%/node_modules/pkg/Guide.md":"# Dependency guide\n\nDependency Markdown is not excluded.\n",
   "日本: 100%/main.ts":"export const fixture = true;\n",
   "日本: 100%/blob.bin":"literal non-Markdown binary fixture\u0000\u0001",
   "日本: 100%/access.toml":'[[members]]\nuser = "alice"\nrole = "owner"\n',
   "Restrictive/notes/Secret.md":"# Disposable private title\n\nDisposable private body.\n",
   "Restrictive/access.toml":'[[members]]\nuser = "bob"\nrole = "owner"\n',
   "Registered/PrivateChild/Secret.md":"# Existing private title\n\nPrivate fixture bytes.\n",
   "Registered/access.toml":'[[members]]\nuser = "bob"\nrole = "owner"\n',
   "Parent/Nested/Secret.md":"# Nested registered private fixture\n",
   "Parent/Nested/access.toml":'[[members]]\nuser = "bob"\nrole = "owner"\n',
  };
  for(const [path,body] of Object.entries(files)){await mkdir(join(projects,path,".."),{recursive:true});await writeFile(join(projects,path),body);}
  if(locations==="configured")await mkdir(join(projects,"Empty"));
  if(locations==="multiple")await mkdir(join(root,"other"));
  const port=await freePort();
  await writeFile(config,`bind = "127.0.0.1:${port}"\nweb_root = ${JSON.stringify(E2E_WEB_ROOT)}\n`+(locations==="none"?"":`[[vault_locations]]\nid = "projects"\nname = "Projects"\npath = ${JSON.stringify(projects)}\n`)+(locations==="multiple"?`[[vault_locations]]\nid = "other"\nname = "Other 日本"\npath = ${JSON.stringify(join(root,"other"))}\n`:"")+(locations!=="configured"?"":`[[vaults]]\nslug = "registered"\npath = ${JSON.stringify(join(projects,"Registered"))}\n[[vaults]]\nslug = "nested"\npath = ${JSON.stringify(join(projects,"Parent/Nested"))}\n`));
  if(unprivileged&&process.getuid?.()===0)for(const path of [root,projects,config])await chown(path,serviceUid,serviceGid);
  execFileSync(binary,["user","setup","--username",E2E_USER.username,"--password-stdin","--config",config],{...identity,input:`${E2E_USER.password}\n`});
  await start();
  return {root,config,serviceUid,serviceGid,get origin(){return origin;},get pid(){return child?.pid;},restart:async()=>{await halt();await start();},stop:async()=>{await halt();await rm(root,{recursive:true,force:true});}};
 }catch(error){await halt();await rm(root,{recursive:true,force:true});throw error;}
}
/** Authenticates only against this disposable fixture; never prints credentials. */
export async function loginFolderServer(page:Page,origin:string):Promise<void> {
 await page.goto(origin);
 await page.getByLabel("Username",{exact:true}).fill(E2E_USER.username);
 await page.getByLabel("Password",{exact:true}).fill(E2E_USER.password);
 await page.getByRole("button",{name:"Sign in"}).click();
 await page.getByRole("link",{name:"New vault",exact:true}).waitFor();
}
