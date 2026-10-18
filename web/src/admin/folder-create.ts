import { directoryName, object, relativePath } from "./folder-vault-wire.js";
import { Refusal } from "./folder-vault-api.js";
/** One exact mkdir intent. A sent request is never replayed implicitly. */
export interface FolderCreateIntent { readonly path:string; readonly directory:string }
/** A verified created child, even when directory syncing failed. */
export interface FolderCreated { readonly path:string; readonly directory_synced:boolean }
/** Strict E31 success readback; no unknown fields or path repair. */
export function folderCreated(value:unknown,intent:FolderCreateIntent):FolderCreated {
 const path=intent.path===""?intent.directory:`${intent.path}/${intent.directory}`;
 if(!object(value,["path","created","directory_synced"])||value["path"]!==path||value["created"]!==true||typeof value["directory_synced"]!=="boolean")throw new Error("schema");
 return {path,directory_synced:value["directory_synced"]};
}
/** Explicit immediate mkdir through current signed administration, not registration. */
export async function createLocationFolder(id:string,intent:FolderCreateIntent,signal:AbortSignal):Promise<FolderCreated>{
 if(!directoryName(intent.directory)||!relativePath(intent.path)||!relativePath(intent.path===""?intent.directory:`${intent.path}/${intent.directory}`))throw new Refusal("invalid_request");
 const response=await fetch(`/api/v1/vault-locations/${id}/directories`,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"Content-Type":"application/json"},body:JSON.stringify(intent)});
 // why: a final authority denial may retain a successfully created child. It is not rollback.
 if(response.status===404)throw new Refusal("not_found");
 if(response.headers.get("content-type")?.split(";",1)[0]!=="application/json")throw new Error("schema");
 const text=await response.text();if(new TextEncoder().encode(text).length>65536)throw new Error("schema");
 const value:unknown=JSON.parse(text);
 if(!response.ok){
  if(object(value,["error"]))for(const [code,status] of Object.entries({invalid_request:400,confirmation_conflict:409,limit_exceeded:422,busy:429,storage_unavailable:503,cleanup_incomplete:503} as const))if(response.status===status&&value["error"]===code)throw new Refusal(code as "invalid_request"|"confirmation_conflict"|"limit_exceeded"|"busy"|"storage_unavailable"|"cleanup_incomplete");
  throw new Error("schema");
 }
 if(response.status!==201)throw new Error("schema");return folderCreated(value,intent);
}
