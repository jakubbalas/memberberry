// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import FolderContents from "./FolderContents.svelte";
import { FolderBrowser } from "./folder-browser.svelte.js";
const apps:ReturnType<typeof mount>[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await unmount(app);vi.unstubAllGlobals();document.body.replaceChildren();});
function reply(path:string,files:readonly string[]=[],status=200):Response{return new Response(JSON.stringify(status===200?{path,folders:[],files:files.map(name=>({name,path:`${path}/${name}`}))}:{error:"not_found"}),{status,headers:{"content-type":"application/json"}});}
async function render(path="Projects",browser=new FolderBrowser()){
 const target=document.createElement("div");document.body.append(target);const onfolder=vi.fn(),onopen=vi.fn(),onclose=vi.fn();
 apps.push(mount(FolderContents,{target,props:{path,vault:"personal",vaultLabel:"Personal",browser,onfolder,onopen,onclose}}));await tick();return {target,onfolder,onopen,onclose,browser};
}
it("requests an uncached shallow listing and shows loading until its contents arrive",async()=>{
 let resolve=(_v:Response):void=>{throw new Error("uninitialized");};const pending=new Promise<Response>(r=>{resolve=r;});const request=vi.fn(()=>pending);vi.stubGlobal("fetch",request);const view=await render();
 expect(view.target.querySelector('[role="status"]')?.textContent).toBe("Loading folder contents…");expect(request).toHaveBeenCalledTimes(1);
 resolve(reply("Projects",["Plan.md"]));await vi.waitFor(()=>expect(view.target.textContent).toContain("Plan.md"));expect(view.target.querySelector('[role="status"]')).toBeNull();
});
it("removes listed filenames immediately after authoritative directory access denial",async()=>{
 let denied=false;vi.stubGlobal("fetch",vi.fn(async()=>reply("Projects",["Private.md"],denied?404:200)));const view=await render();
 await vi.waitFor(()=>expect(view.target.textContent).toContain("Private.md"));denied=true;await view.browser.navigate("personal","Projects");await tick();
 expect(view.target.textContent).not.toContain("Private.md");expect(view.target.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
});
it("renders an existing empty directory and conditional parent navigation without opening an editor",async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>reply("Projects/Empty")));const view=await render("Projects/Empty");await vi.waitFor(()=>expect(view.target.textContent).toContain("0 folders found"));
 expect(document.activeElement).toBe(view.target.querySelector("h1"));[...view.target.querySelectorAll("button")].find(b=>b.textContent?.includes("Go to parent folder"))?.click();expect(view.onfolder).toHaveBeenCalledWith("Projects");
 view.target.querySelector<HTMLButtonElement>('[aria-label="Close folder view"]')?.click();expect(view.onclose).toHaveBeenCalledTimes(1);expect(view.onopen).not.toHaveBeenCalled();
});
