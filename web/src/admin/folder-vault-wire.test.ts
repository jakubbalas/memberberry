import { afterEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { catalogContains, committed, preview, requestJson, statusRegistered, validateSelection, type Selection } from "./folder-vault-api.js";
import { directoryName, listing, locations } from "./folder-vault-wire.js";
const selection:Selection={mode:"existing",path:"日本: 100%",name:" Project ",slug:"project"};
const p={confirmation:"a".repeat(64),expires_in_seconds:120,mode:"existing",notes_root:"root",read_only:false,storage_check:"bounded_service_identity_probes",scope:"existing-project",recursive_markdown:true};
const done={slug:"project",committed:true,directory_synced:false,audit_recorded:false,watched:true,index_ready:true,index_storage:"memory_until_restart"};
afterEach(()=>vi.unstubAllGlobals());
for(const [field,value] of Object.entries({confirmation:"A".repeat(64),expires_in_seconds:121,mode:"new",notes_root:"unknown",read_only:true,storage_check:"other",scope:"existing-parent",recursive_markdown:false,extra:"private"}))test(`preview rejects schema drift in ${field}`,()=>{expect(()=>preview({...p,[field]:value},selection)).toThrow();});
for(const [field,value] of Object.entries({slug:"other",committed:false,directory_synced:"false",audit_recorded:null,watched:false,index_ready:false,index_storage:"disk",extra:"private"}))test(`commit rejects schema drift in ${field}`,()=>{expect(()=>committed({...done,[field]:value},"project")).toThrow();});
test("exact schemas accept truthful false postcommit flags and new parent-only checks",()=>{expect(committed(done,"project")).toEqual({slug:"project",directory_synced:false,audit_recorded:false});expect(preview({...p,mode:"new",scope:"existing-parent",recursive_markdown:false},{mode:"new",path:"",directory:"日本: %2e%2e",name:"Project",slug:"project"})).toMatchObject({scope:"existing-parent",recursive_markdown:false});});
test("metadata refuses extra server paths, duplicate ids and unexpected literal child paths",()=>{
 expect(()=>locations({locations:[{id:"projects",name:"Projects",path:"/private"}]})).toThrow();expect(()=>locations({locations:[{id:"projects",name:"Projects"},{id:"projects",name:"Other"}]})).toThrow();
 const state={location_root:true,registration:"available",selectable:false,browsable:true};expect(()=>listing({path:"",state,children:[{name:"%2e%2e",path:"..",state:{...state,location_root:false,selectable:true}}]},"")).toThrow();expect(()=>listing({path:"",state:{...state,selectable:true},children:[]},"")).toThrow();
});
test("filtered content navigation requires exact catalog schema and status needs a registered boundary",()=>{expect(catalogContains([{slug:"project",name:"Name"}],"project")).toBe(true);expect(catalogContains([],"project")).toBe(false);expect(()=>catalogContains([{slug:"project",name:"Name",path:"/private"}],"project")).toThrow();expect(statusRegistered({path:"日本: 100%",state:{location_root:false,registration:"already_registered",selectable:false,browsable:false}},"日本: 100%")).toBe(true);expect(()=>statusRegistered({path:"other",state:{}},"日本: 100%")).toThrow();});
test("literal Unicode colon and percent names survive JSON and HTTP query once-only codecs (seed 003)",async()=>{
 const names=fc.array(fc.oneof(fc.integer({min:0x4e00,max:0x9fff}).map(n=>String.fromCodePoint(n)),fc.constantFrom("%2e%2e","%252e%252e","%2f","%5c","%","+",":"," ","📚","مشروع","פרויקט","é","e\u0301")),{maxLength:12}).map(parts=>`日本: ${parts.join("")}`);
 await fc.assert(fc.asyncProperty(names,async name=>{
  expect(directoryName(name)).toBe(true);const s:Selection={mode:"new",path:"",directory:name,name:" Label ",slug:"project"};expect(validateSelection(s)).toBe(true);expect(JSON.parse(JSON.stringify(s))).toEqual(s);expect(new URLSearchParams(new URLSearchParams({path:name}).toString()).get("path")).toBe(name);
  const f=vi.fn(async(_url:string,init?:RequestInit)=>{expect(JSON.parse(String(init?.body))).toEqual(s);expect(init?.headers).toEqual({"Content-Type":"application/json"});expect(init?.credentials).toBe("same-origin");return new Response(JSON.stringify({...p,mode:"new",scope:"existing-parent",recursive_markdown:false}),{headers:{"Content-Type":"application/json"}});});vi.stubGlobal("fetch",f);await requestJson("/api/v1/vault-locations/projects/preview",new AbortController().signal,s);expect(f).toHaveBeenCalledTimes(1);
 }),{seed:3,numRuns:200});
});
for(const name of ["../bad",".hidden","/absolute","C:drive","a/b","a\\b"," ","\u0085", "a\u0000b"]){test(`invalid child ${JSON.stringify(name)} is refused without repairing`,()=>{expect(directoryName(name)).toBe(false);});}
test("JSON boundary rejects non-JSON, mismatched statuses and over-64KiB UTF-8 metadata",async()=>{
 const signal=new AbortController().signal;
 for(const r of [new Response("private HTML path",{headers:{"Content-Type":"text/html"}}),new Response(JSON.stringify({error:"not_found"}),{status:503,headers:{"Content-Type":"application/json"}}),new Response(JSON.stringify("日".repeat(22000)),{headers:{"Content-Type":"application/json"}})]){vi.stubGlobal("fetch",vi.fn(async()=>r));await expect(requestJson("/api/v1/vault-locations",signal)).rejects.toThrow();}
});
test("valid label and directory BOM are not silently narrowed by JavaScript trim",()=>{expect(directoryName("\ufeff")).toBe(true);expect(validateSelection({mode:"new",path:"",directory:"\ufeff",name:"\ufeff",slug:"project"})).toBe(true);});
