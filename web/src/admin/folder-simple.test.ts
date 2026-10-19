// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { mountFolderVault } from "./folder-vault.js";
import { installDialogShim } from "./folder-dialog-test.js";
installDialogShim();
let dispose=():void=>{};
afterEach(()=>{dispose();vi.unstubAllGlobals();document.body.replaceChildren();});
test("simple picker names the current root, hides one location and obsolete registration modes",async()=>{
 document.body.innerHTML=new DOMParser().parseFromString(readFileSync("add-vault.html","utf8"),"text/html").body.innerHTML;
 vi.stubGlobal("fetch",vi.fn(async(u:RequestInfo|URL)=>new Response(JSON.stringify(String(u).endsWith("/vault-locations")?{locations:[{id:"projects",name:" Projects 日本 "}]}:{path:"",state:{location_root:true,registration:"available",selectable:false,browsable:true},children:[]}),{headers:{"content-type":"application/json"}})));
 const root=document.querySelector<HTMLElement>("#folder-vault");if(root===null)throw new Error("fixture");dispose=mountFolderVault(root);
 document.querySelector<HTMLButtonElement>("#choose-folder")?.click();
 await vi.waitFor(()=>expect(document.querySelector("#picker-heading")?.textContent).toBe(" Projects 日本 "));
 expect(document.querySelector("[data-mode]")).toBeNull();expect(document.querySelector("#location-switch")?.hasAttribute("hidden")).toBe(true);
 expect(document.querySelector<HTMLElement>("#up")?.hidden).toBe(true);
 expect(document.querySelector("#picker")?.textContent).toContain("Add folder here");
 expect(document.querySelector("#picker-message")?.textContent).toBe("0 folders found");
});
