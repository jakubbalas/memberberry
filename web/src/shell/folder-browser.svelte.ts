import { fetchFolderListing, FolderDenied, type FolderListing } from "./folder-listing.js";
/** A workspace-owned shallow read fence surviving temporary view remounts. */
export class FolderBrowser {
 listing:FolderListing|undefined=$state();
 loading=$state(false);
 error=$state("");
 /** Incremented on every authoritative refusal, independently of navigation generations. */
 denialRevision=$state(0);
 #version=0;
 #deniedThrough=0;
 #requests=new Set<AbortController>();
 /** Clears names immediately and fences every already-started read, including disposed requests. */
 deny():void {++this.denialRevision;this.#deniedThrough=this.#version;this.listing=undefined;this.loading=false;this.error="This folder is unavailable. Return to its parent or refresh after signing in.";for(const r of this.#requests)r.abort();}
 /** Every navigation issues a new E30 read; no offline/catalog fallback. */
 async navigate(vault:string,path:string):Promise<void>{
  const own=++this.#version;for(const r of this.#requests)r.abort();const controller=new AbortController();this.#requests.add(controller);
  this.listing=undefined;this.error="";this.loading=true;
  try{const next=await fetchFolderListing(vault,path,controller.signal);if(own===this.#version&&own>this.#deniedThrough){this.listing=next;this.loading=false;}}
  catch(error){if(error instanceof FolderDenied){this.deny();return;}if(own!==this.#version||own<=this.#deniedThrough)return;this.listing=undefined;this.loading=false;this.error=error instanceof Error&&error.message==="This folder exceeds the server listing limit."?error.message:"The folder listing could not be verified. Refresh to try again.";}
  finally{this.#requests.delete(controller);}
 }
 /** Aborts publication and I/O while retaining authoritative denial facts for a remount. */
 dispose():void{++this.#version;for(const r of this.#requests)r.abort();this.listing=undefined;this.loading=false;}
}
