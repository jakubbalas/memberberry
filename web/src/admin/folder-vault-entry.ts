import { mountFolderVault } from "./folder-vault.js";
const root=document.querySelector<HTMLElement>("#folder-vault");
if(root!==null){
  let destroy=mountFolderVault(root);
  window.addEventListener("pagehide",()=>{destroy();});
  window.addEventListener("pageshow",event=>{if(event.persisted)destroy=mountFolderVault(root);});
}
