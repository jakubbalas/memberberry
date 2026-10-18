import { object, directoryName, relativePath } from "../admin/folder-vault-wire.js";
/** A server-authorized immediate filesystem entry, not a catalog title or content grant. */
export interface FolderEntry { readonly name:string; readonly path:string }
/** E30 returns no descendant metadata or note bodies. */
export interface FolderListing { readonly path:string; readonly folders:readonly FolderEntry[]; readonly files:readonly FolderEntry[] }
/** Rust orders exact UTF-8 names; JavaScript's UTF-16 ordering differs for astral names. */
export function compareFolderNames(a:string,b:string):number {
 const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);
 for(let i=0;i<Math.min(x.length,y.length);i++){const l=x[i],r=y[i];if(l!==undefined&&r!==undefined&&l!==r)return l-r;}
 return x.length-y.length;
}
/** Validates the whole bounded literal wire contract without repairing/filtering entries. */
export function readFolderListing(value:unknown,path:string):FolderListing {
 if(!relativePath(path)||!object(value,["path","folders","files"])||value["path"]!==path||!Array.isArray(value["folders"])||!Array.isArray(value["files"])||value["folders"].length+value["files"].length>128)throw new Error("schema");
 const seen=new Set<string>();
 function entries(values:readonly unknown[],files:boolean):readonly FolderEntry[]{
  let previous:string|undefined;
  return values.map(v=>{
   if(!object(v,["name","path"])||!directoryName(v["name"])||(files&&!v["name"].endsWith(".md"))||v["path"]!==(path===""?v["name"]:`${path}/${v["name"]}`)||!relativePath(v["path"])||seen.has(v["path"])||(previous!==undefined&&compareFolderNames(previous,v["name"])>=0))throw new Error("schema");
   previous=v["name"];seen.add(v["path"]);return {name:v["name"],path:v["path"]};
  });
 }
 return {path,folders:entries(value["folders"],false),files:entries(value["files"],true)};
}
/** Neutral content denial; never implies whether the folder or vault exists. */
export class FolderDenied extends Error {}
/** One uncached, abortable shallow read. No note catalog, Tasks, search or body request. */
export async function fetchFolderListing(vault:string,path:string,signal:AbortSignal,request:typeof fetch=globalThis.fetch):Promise<FolderListing>{
 if(!relativePath(path))throw new Error("invalid path");
 const response=await request(`/api/v1/vaults/${encodeURIComponent(vault)}/directory?${new URLSearchParams({path})}`,{signal,credentials:"same-origin",cache:"no-store",headers:{accept:"application/json"}});
 if([401,403,404].includes(response.status))throw new FolderDenied();
 if(response.status===422)throw new Error("This folder exceeds the server listing limit.");
 if(response.status!==200||response.headers.get("content-type")?.split(";",1)[0]!=="application/json")throw new Error("The folder listing is unavailable.");
 const text=await response.text();if(new TextEncoder().encode(text).length>65536)throw new Error("schema");
 return readFolderListing(JSON.parse(text) as unknown,path);
}
