import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { Refusal, refusalMessage, requestJson, validateSelection } from "./folder-vault-api.js";
import { directoryName, relativePath, listing } from "./folder-vault-wire.js";
import { readFolderListing, fetchFolderListing, compareFolderNames } from "../shell/folder-listing.js";
afterEach(()=>vi.unstubAllGlobals());
const selection={mode:"existing" as const,path:" 日本: %2e%2e ",slug:"repair",name:" Exact label "};
const body={error:"permission_layout_conflict",guidance:"Select the intended note root or resolve the policy layout outside Memberberry before adopting this folder."};
function response(value:unknown,status=409):Response{return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json","cache-control":"no-store"}});}
for(const phase of ["preview","register"] as const)test(`S2 exact approved two-key 409 is typed at ${phase}`,async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>response(body)));let error:unknown;
 try{await requestJson(`/api/v1/vault-locations/projects/${phase}`,new AbortController().signal,selection,phase==="register"?"a".repeat(64):undefined);}catch(e){error=e;}
 expect(error).toBeInstanceOf(Refusal);expect(error).toMatchObject({code:"permission_layout_conflict"});expect(refusalMessage(error)).toMatch(/intended note root|policy layout/);expect(refusalMessage(error)).not.toContain("could not be verified");
});
for(const [name,value,status] of [
 ["missing guidance",{error:body.error},409], ["extra",{...body,diagnostic:"/private"},409], ["spoof guidance",{...body,guidance:"/private OS diagnostic"},409], ["wrong guidance type",{...body,guidance:null},409], ["wrong code",{...body,error:"confirmation_conflict"},409], ["wrong status",body,503]
] as const)test(`S2 ${name} is not a trusted precommit refusal`,async()=>{
 vi.stubGlobal("fetch",vi.fn(async()=>response(value,status)));await expect(requestJson("/api/v1/vault-locations/projects/register",new AbortController().signal,selection,"a".repeat(64))).rejects.not.toBeInstanceOf(Refusal);
});
const root={location_root:true,registration:"available",selectable:false,browsable:true},child={...root,location_root:false,selectable:true};
for(const bad of ["\ud800","\udfff","a\ud800b","\udfff📚"]){
 test(`S3 rejects lone surrogate ${JSON.stringify(bad)} before path fetch or complete row publication`,async()=>{
  expect(directoryName(bad)).toBe(false);expect(relativePath(`Parent/${bad}`)).toBe(false);
  const request=vi.fn<typeof fetch>();await expect(fetchFolderListing("fixture",bad,new AbortController().signal,request)).rejects.toThrow("invalid path");expect(request).not.toHaveBeenCalled();
  const rows=[{name:"A",path:"A"},{name:bad,path:bad}].sort((a,b)=>compareFolderNames(a.name,b.name));
  expect(()=>readFolderListing({path:"",folders:rows,files:[]},"")).toThrow();expect(()=>readFolderListing({path:"",folders:[],files:[{name:`${bad}.md`,path:`${bad}.md`}]},"")).toThrow();
  expect(()=>listing({path:"",state:root,children:rows.map(v=>({...v,state:child}))},"")).toThrow();
  expect(validateSelection({...selection,path:bad})).toBe(false);
 });
}
test("S3 well-formed literal Unicode survives wire/form roundtrips (seed 630063)",()=>{
 console.info("property seed 630063; iterations 256 (one case)");
 const codepoint=fc.integer({min:0x20,max:0x10ffff}).filter(n=>!(n>=0xd800&&n<=0xdfff));
 fc.assert(fc.property(fc.array(codepoint,{minLength:1,maxLength:20}),points=>{
  const name=`Exact ${String.fromCodePoint(...points)} %2e%2e 📚 `;
  fc.pre(!/[\/\\\u007f-\u009f]/u.test(name));expect(directoryName(name)).toBe(true);
  const path=` 日本 /${name}`;expect(relativePath(path)).toBe(true);expect(new URLSearchParams(new URLSearchParams({path}).toString()).get("path")).toBe(path);
  expect(readFolderListing({path:" 日本 ",folders:[{name,path}],files:[]}," 日本 ").folders).toEqual([{name,path}]);
 }),{seed:630063,numRuns:256});
});
