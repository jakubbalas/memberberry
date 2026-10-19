import { directoryName, object, relativePath } from "./folder-vault-wire.js";
/** Exact user intent sent to the real registration API; never carries a client actor. */
export type Selection = ({ mode:"existing"; path:string; slug:string; name:string } | { mode:"new"; path:string; directory:string; slug:string; name:string }) & { ignore_non_writable_folders?:boolean };
/** Server-issued, short-lived preview. It grants no content authority. */
export interface Preview { confirmation:string; notes_root:"root"|"notes"; scope:"existing-parent"|"existing-project"; recursive_markdown:boolean }
/** Postcommit outcomes are independent of the successful registration. */
export interface Committed { slug:string; directory_synced:boolean; audit_recorded:boolean }
/** Validates literal input without trimming, decoding, normalizing or auto-adopting. */
export function validateSelection(s:Selection):boolean {
  return (s.ignore_non_writable_folders===undefined || typeof s.ignore_non_writable_folders==="boolean") && relativePath(s.path) && (s.mode==="new" ? directoryName(s.directory) && relativePath(s.path === "" ? s.directory : `${s.path}/${s.directory}`) : s.path!=="")
    && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s.slug)
    && !/^\p{White_Space}*$/u.test(s.name) && !/[\u0000-\u001f\u007f-\u009f]/u.test(s.name) && new TextEncoder().encode(s.name).length<=256;
}
/** Validates the complete preview schema and selected mode before enabling confirmation. */
export function preview(value:unknown,s:Selection):Preview {
  if(!object(value,["confirmation","expires_in_seconds","mode","notes_root","read_only","storage_check","scope","recursive_markdown"])
    || typeof value["confirmation"]!=="string" || !/^[a-f0-9]{64}$/.test(value["confirmation"])
    || value["expires_in_seconds"]!==120 || value["mode"]!==s.mode || value["read_only"]!==false
    || value["storage_check"]!=="bounded_service_identity_probes" || (value["notes_root"]!=="root" && value["notes_root"]!=="notes")
    || value["scope"]!==(s.mode==="new"?"existing-parent":"existing-project")
    || value["recursive_markdown"]!==(s.mode==="existing") || (s.mode==="new" && value["notes_root"]!=="root")) throw new Error("schema");
  return {confirmation:value["confirmation"],notes_root:value["notes_root"],scope:s.mode==="new"?"existing-parent":"existing-project",recursive_markdown:s.mode==="existing"};
}
/** Refuses ambiguous/malformed success; it never turns postcommit false flags into rollback. */
export function committed(value:unknown,slug:string):Committed {
  if(!object(value,["slug","committed","directory_synced","audit_recorded","watched","index_ready","index_storage"])
    || value["slug"]!==slug || value["committed"]!==true || typeof value["directory_synced"]!=="boolean"
    || typeof value["audit_recorded"]!=="boolean" || value["watched"]!==true || value["index_ready"]!==true || value["index_storage"]!=="memory_until_restart") throw new Error("schema");
  return {slug,directory_synced:value["directory_synced"],audit_recorded:value["audit_recorded"]};
}
/** Reads only filtered catalog membership, not content, to decide whether to offer navigation. */
export function catalogContains(value:unknown,slug:string):boolean {
  if(!Array.isArray(value) || !value.every((v:unknown)=>object(v,["slug","name"]) && typeof v["slug"]==="string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v["slug"]) && typeof v["name"]==="string")) throw new Error("schema");
  return value.some((v:unknown)=>object(v,["slug","name"]) && v["slug"]===slug);
}
/** Validates a status read for a possibly committed selection without enumerating children. */
export function statusRegistered(value:unknown,path:string):boolean {
  if(!object(value,["path","state"]) || value["path"]!==path || !object(value["state"],["location_root","registration","selectable","browsable"])) throw new Error("schema");
  const s=value["state"];
  if(s["location_root"]!==false || typeof s["selectable"]!=="boolean" || typeof s["browsable"]!=="boolean"
    || !["available","already_registered","inside_registered_vault","contains_registered_vault"].includes(String(s["registration"]))) throw new Error("schema");
  return s["registration"]==="already_registered" && s["selectable"]===false && s["browsable"]===false;
}
const refusals = {not_found:404,invalid_request:400,confirmation_conflict:409,limit_exceeded:422,busy:429,storage_unavailable:503,cleanup_incomplete:503};
/** A known neutral refusal, never an untrusted server/OS diagnostic. */
export class Refusal extends Error {
  constructor(readonly code:keyof typeof refusals|"permission_layout_conflict"){super(code);}
}
/** Performs one same-origin API request; callers own cancellation and publication fences. */
export async function requestJson(url:string,signal:AbortSignal,selection?:Selection,confirmation?:string):Promise<unknown> {
  const response=await fetch(url,{signal,credentials:"same-origin",cache:"no-store", ...(selection===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...selection,...(confirmation===undefined?{}:{confirmation})})})});
  // why: authority-first refusal fences newer requests even if its body cannot be parsed.
  if(response.status===404)throw new Refusal("not_found");
  if(response.headers.get("content-type")?.split(";",1)[0]!=="application/json")throw new Error("schema");
  const text=await response.text();if(new TextEncoder().encode(text).length>65536)throw new Error("schema");
  const value:unknown=JSON.parse(text);
  if(!response.ok){
    // why: the approved layout guard has an exact two-key 409 schema; arbitrary guidance is never trusted.
    if(response.status===409 && object(value,["error","guidance"])
      && value["error"]==="permission_layout_conflict"
      && value["guidance"]==="Select the intended note root or resolve the policy layout outside Memberberry before adopting this folder.")throw new Refusal("permission_layout_conflict");
    if(object(value,["error"])) for(const [code,status] of Object.entries(refusals)){
      if(response.status===status && value["error"]===code)throw new Refusal(code as keyof typeof refusals);
    }
    throw new Error("unrecognized refusal");
  }
  if(response.status!==(selection===undefined || confirmation===undefined?200:201))throw new Error("schema");
  return value;
}
/** Safe, useful local guidance for exact backend errors; no error message reflection. */
export function refusalMessage(error:unknown):string {
  if(!(error instanceof Refusal))return "The server response could not be verified. Your details are kept. Refresh folders before trying again.";
  switch(error.code){
    case "not_found":return "Administration is unavailable for this session or location. Return to your vaults and sign in again.";
    case "invalid_request":return "Check the selected folder, new folder name and vault label. Your details are kept.";
    case "permission_layout_conflict":return "Select the intended note root or resolve the policy layout outside Memberberry before adopting this folder. Your details are kept.";
    case "confirmation_conflict":return "The selection changed, validation expired, or there is a registration collision or overlap. Nothing is overwritten or auto-adopted. Refresh folders and try again.";
    case "limit_exceeded":return "This selection exceeds the server's bounded discovery or storage checks. Choose a smaller project; your details are kept.";
    case "busy":return "The server is busy or its bounded request budget is exhausted. Your details are kept; try again later.";
    case "storage_unavailable":return "Storage, policy or the server lifecycle is unavailable. No permissions are repaired. Your details are kept; ask the server operator.";
    case "cleanup_incomplete":return "The operation could not complete its owned-artifact cleanup. Your details are kept. Ask the server operator to inspect residuals before retrying; do not delete the project.";
  }
}
