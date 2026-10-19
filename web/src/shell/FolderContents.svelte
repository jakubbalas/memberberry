<script lang="ts">
 import { untrack, tick } from "svelte";
 import Icon from "./Icon.svelte";
 import NamePrompt from "./NamePrompt.svelte";
 import { FolderBrowser } from "./folder-browser.svelte.js";
 import { createFolder } from "./folders.js";
 import { directoryName, relativePath } from "../admin/folder-vault-wire.js";
 interface Props {
  readonly path:string;
  readonly vault:string;
  readonly vaultLabel?:string;
  readonly browser?:FolderBrowser;
  readonly oncreate?:()=>void;
  readonly onopen:(path:string)=>void;
  readonly onfolder:(path:string)=>void;
  readonly onclose:()=>void;
 }
 const {path,vault,vaultLabel,browser:suppliedBrowser,oncreate,onopen,onfolder,onclose}:Props=$props();
 const browser=untrack(()=>suppliedBrowser??new FolderBrowser());
 let heading=$state<HTMLHeadingElement|undefined>(),opener=$state<HTMLButtonElement|undefined>();
 let prompt=$state(false),busy=$state(false),creationError=$state<string|undefined>(),promptIdentity=$state(0);
 let generation=0,creation:AbortController|undefined,creationAuthority=0;
 const name=$derived(path===""?(vaultLabel??vault):path.slice(path.lastIndexOf("/")+1));
 const parent=$derived(path.split("/").slice(0,-1).join("/"));
 $effect(()=>{
  ++generation;prompt=false;busy=false;creationError=undefined;creation?.abort();void browser.navigate(vault,path);
  return ()=>{++generation;creation?.abort();browser.dispose();};
 });
 $effect(()=>{if(browser.listing!==undefined)heading?.focus();});
 $effect(()=>{if(browser.denialRevision!==creationAuthority){creation?.abort();busy=false;prompt=false;}});
 async function dismiss(identity:number,cancel=true):Promise<void>{
  // why: native Escape/close cancels publication, not the already-sent filesystem operation.
  // Programmatic success closes with prompt=false; its delayed onclose must not cancel a newer prompt.
  if(identity!==promptIdentity||!prompt)return;
  if(cancel){creation?.abort();busy=false;}
  prompt=false;await tick();if(identity===promptIdentity)opener?.focus();
 }
 async function submit(name:string,identity:number):Promise<void>{
  if(identity!==promptIdentity||!prompt||busy||browser.listing===undefined)return;
  const full=path===""?name:`${path}/${name}`,own=generation,folderPath=path,folderVault=vault;
  if(!directoryName(name)||!relativePath(full)){creationError="Enter one usable folder name.";return;}
  busy=true;creationError=undefined;creationAuthority=browser.denialRevision;creation=new AbortController();const signal=creation.signal;
  const current=():boolean=>identity===promptIdentity&&own===generation&&!signal.aborted&&creationAuthority===browser.denialRevision&&path===folderPath&&vault===folderVault;
  const request:typeof fetch=async(input,init)=>{const response=await fetch(input,{...init,signal,credentials:"same-origin",cache:"no-store"});if([401,403,404].includes(response.status))browser.deny();return response;};
  const result=await createFolder(vault,full,request);
  if(!current())return;busy=false;
  if("refused" in result){creationError=result.refused;return;}
  await dismiss(identity,false);
  // why: tick/native focus handlers can change authority or navigation after the first guard.
  if(current())onfolder(full);
 }
</script>
<section class="workspace-home folder-contents" aria-labelledby="folder-heading">
 <header><h1 id="folder-heading" tabindex="-1" bind:this={heading}>{name}</h1><button type="button" class="icon-button" aria-label="Close folder view" title="Close folder view" onclick={onclose}><Icon name="close" /></button></header>
 <section class="home-notes" aria-label="Folder contents">
  <button type="button" disabled={browser.listing===undefined||busy} class="folder-row" bind:this={opener} onclick={()=>{++promptIdentity;prompt=true;creationError=undefined;}}><Icon name="folder-plus" /><span>Add folder here</span></button>
  {#if oncreate!==undefined}<button type="button" class="folder-row" disabled={browser.listing===undefined} onclick={oncreate}><Icon name="plus" /><span>New note</span></button>{/if}
  {#if path!==""}<button type="button" class="folder-row" aria-label="Go to parent folder" onclick={()=>onfolder(parent)}><span aria-hidden="true">↑</span><span>Go to parent folder</span></button>{/if}
  {#if browser.loading}<p role="status">Loading folder contents…</p>
  {:else if browser.error!==""}<p role="alert">{browser.error}</p><button type="button" onclick={()=>{void browser.navigate(vault,path);}}>Refresh folder</button>
  {:else if browser.listing!==undefined}
   {#if browser.listing.folders.length===0}<p>0 folders found</p>{/if}
   <ul>{#each browser.listing.folders as entry (entry.path)}<li><button type="button" aria-label={`Open folder ${entry.name}`} onclick={()=>onfolder(entry.path)}><Icon name="folder" /><span>{entry.name}</span></button></li>{/each}
   {#each browser.listing.files as entry (entry.path)}<li><button type="button" onclick={()=>onopen(entry.path)}><Icon name="note" /><span>{entry.name}</span></button></li>{/each}</ul>
  {/if}
 </section>
</section>
{#key promptIdentity}
 {@const identity=promptIdentity}
 <NamePrompt open={prompt} title="Add folder here" subject={name} label="Folder name" initial="" {busy} error={creationError} confirm="Create" confirming="Creating…" onsubmit={(name)=>{void submit(name,identity);}} ondismiss={()=>{void dismiss(identity);}} />
{/key}
