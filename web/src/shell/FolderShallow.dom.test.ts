// @vitest-environment jsdom
import { mount, unmount } from "svelte";
import { expect, test, vi } from "vitest";
import FolderContents from "./FolderContents.svelte";
for(const array of ["folders","files"] as const)test(`S3 one malformed ${array} entry fails the entire rendered listing closed`,async()=>{
 const malformed=array==="folders"?"\ud800":"\ud800.md",fetcher=vi.fn(async()=>new Response(JSON.stringify({path:"",folders:array==="folders"?[{name:"A",path:"A"},{name:malformed,path:malformed}]:[{name:"A",path:"A"}],files:array==="files"?[{name:malformed,path:malformed}]:[]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetcher);const target=document.createElement("div");document.body.append(target);const app=mount(FolderContents,{target,props:{path:"",vault:"fixture",onopen:vi.fn(),onfolder:vi.fn(),onclose:vi.fn()}});
 try{await vi.waitFor(()=>expect(target.querySelector('[role="alert"]')).not.toBeNull());expect(target.querySelectorAll("li")).toHaveLength(0);expect(target.querySelector<HTMLButtonElement>(".folder-row")?.disabled).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);}finally{await unmount(app);vi.unstubAllGlobals();target.remove();}
});
test("folder view fetches one shallow directory instead of enumerating the recursive catalog",async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({path:"",folders:[],files:[]}),{headers:{"content-type":"application/json"}}));
 vi.stubGlobal("fetch",fetcher);
 const target=document.createElement("div");document.body.append(target);
 const app=mount(FolderContents,{target,props:{path:"",vault:"fixture",vaultLabel:"Fixture",onopen:vi.fn(),onfolder:vi.fn(),onclose:vi.fn()}});
 try {
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledWith("/api/v1/vaults/fixture/directory?path=",expect.objectContaining({signal:expect.any(AbortSignal)})));
  expect(target.textContent).toContain("0 folders found");
 }finally{await unmount(app);vi.unstubAllGlobals();target.remove();}
});
