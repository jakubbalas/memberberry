import { listing, locations, type Listing, type Location } from "./folder-vault-wire.js";
import { catalogContains, committed, preview, Refusal, refusalMessage, requestJson, statusRegistered, validateSelection, type Preview, type Selection } from "./folder-vault-api.js";
import { generateVaultSlug } from "./folder-vault-slug.js";
import { createLocationFolder, type FolderCreateIntent } from "./folder-create.js";
import { directoryName, relativePath } from "./folder-vault-wire.js";
const labels={available:"",already_registered:"Already registered — cannot browse or select",inside_registered_vault:"Inside a registered vault — unavailable",contains_registered_vault:"Contains a registered vault — browse only"};
type Stage="idle"|"previewing"|"registering"|"registered"|"uncertain"|"denied";
type ChosenFolder={id:string;label:string;path:string};
type SentWrite={selection:Selection;locationId:string;locationLabel:string;outcome:"unverified"|"uncertain"|"committed"};
// why: a BFCache remount must not erase an already-sent write or revive content access; retain terminal facts only, never receipts.
const terminalContexts=new WeakMap<HTMLElement,{mode:"existing"|"new";selected:ChosenFolder|undefined;sentWrite:SentWrite|undefined;authorityDenied:boolean}>();
type SentMkdir={intent:FolderCreateIntent;locationId:string;locationLabel:string};
const mkdirContexts=new WeakMap<HTMLElement,SentMkdir>();
const activeDenials=new WeakMap<HTMLElement,()=>void>();
/** Mounts a read-only folder dialog and single-submit registration; tears down every effect. */
export function mountFolderVault(root:HTMLElement):()=>void {
  function el<T extends HTMLElement>(selector:string):T {
    const value=root.querySelector<T>(selector);
    if(value===null)throw new Error("missing folder control");
    return value;
  }
  const message=el("#message"),picker=el<HTMLDialogElement>("#picker"),rows=el("#directories"),details=el<HTMLFormElement>("#details"),result=el("#result");
  const location=el<HTMLSelectElement>("#location"),select=el<HTMLButtonElement>("#select-folder"),up=el<HTMLButtonElement>("#up"),choose=el<HTMLButtonElement>("#choose-folder");
  const directory=el<HTMLInputElement>("#directory-name"),name=el<HTMLInputElement>("#vault-name"),add=el<HTMLButtonElement>("#preview"),cancelValidation=el<HTMLButtonElement>("#cancel-validation");
  const address=el<HTMLInputElement>("#vault-slug"),managed=root.dataset["managedStorage"]==="true";
  const ignoreNonWritable=el<HTMLInputElement>("#ignore-non-writable-folders");
  const retained=terminalContexts.get(root);
  if(retained?.sentWrite!==undefined)ignoreNonWritable.checked=retained.sentWrite.selection.ignore_non_writable_folders===true;
  const mode:"existing"|"new"="existing";
  let stage:Stage="idle",managedSubmitting=false;
  let known:Location[]=[],current:Listing|undefined,browsingPath="";
  let selected:ChosenFolder|undefined=retained?.selected;
  let generated:{key:string;slug:string}|undefined;
  let receipt:{selection:Selection;preview:Preview;deadline:number}|undefined;
  // why: aborting a publication generation cannot prove an already-sent write rolled back.
  let sentWrite:SentWrite|undefined=retained?.sentWrite;
  let authorityDenied=retained?.authorityDenied??false,version=0,disposed=false;
  let request:AbortController|undefined,rowListeners=new AbortController();
  let mkdirBusy=false;
  const mkdirRequests=new Set<AbortController>();
  const listeners=new AbortController();
  const terminal=():boolean=>stage==="registering"||stage==="registered"||stage==="uncertain"||stage==="denied";
  function rememberTerminal():void {
    // why: denial survives remount independently, but only a dispatched write may retain folder context.
    terminalContexts.set(root,{mode:sentWrite===undefined?"existing":mode,selected:sentWrite===undefined?undefined:selected,sentWrite,authorityDenied});
  }
  function status(text:string,error=false):void {
    for(const target of [message,el("#picker-message")]){target.textContent=text;target.setAttribute("role",error?"alert":"status");}
  }
  function focusMessage():void {(picker.open?el("#picker-message"):message).focus();}
  function clearReceipt():void {receipt=undefined;cancelValidation.hidden=true;}
  function begin():{own:number;signal:AbortSignal} {++version;request?.abort();request=new AbortController();return {own:version,signal:request.signal};}
  const active=(own:number):boolean=>!disposed&&own===version;
  function disableAll():void {root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button").forEach(c=>{c.disabled=true;});}
  const cannotSubmit=():boolean=>(!managed&&selected===undefined)||mkdirContexts.has(root);
  function invalidate():void {begin();clearReceipt();stage="idle";add.disabled=cannotSubmit();}
  function showMkdirUnknown():void {
    const sent=mkdirContexts.get(root);if(sent===undefined)return;
    el("#mkdir-outcome").hidden=false;el("#mkdir-heading").textContent="Folder creation outcome unknown";
    el("#mkdir-message").textContent="The folder may already exist. Do not retry this creation. Fresh discovery cannot prove which request created it; ask the server operator before starting again.";
    el("#mkdir-intent").textContent=`Sent folder intent: location ${JSON.stringify(sent.locationLabel)} (${JSON.stringify(sent.locationId)}); parent ${JSON.stringify(sent.intent.path)}; name ${JSON.stringify(sent.intent.directory)}.`;
    add.disabled=true;el<HTMLButtonElement>("#add-folder").disabled=true;el<HTMLButtonElement>("#create-folder").disabled=true;
  }
  function closePicker(restore=true):void {if(picker.open)picker.close();picker.hidden=true;if(restore)choose.focus();}
  function authorizationLost():void {
    if(disposed){
      const context=terminalContexts.get(root);if(context!==undefined)context.authorityDenied=true;
      activeDenials.get(root)?.();return;
    }
    ++version;request?.abort();clearReceipt();authorityDenied=true;stage="denied";disableAll();closePicker(false);
    rows.replaceChildren();rowListeners.abort();for(const r of mkdirRequests)r.abort();showMkdirUnknown();
    rememberTerminal();
    if(sentWrite!==undefined&&sentWrite.outcome!=="committed")showOutcome(true);
    el("#content-access").textContent="";el<HTMLAnchorElement>("#open-vault").hidden=true;el<HTMLAnchorElement>("#open-vault").removeAttribute("href");
    status("Administration is unavailable for this session or location. Return to your vaults and sign in again. Your typed details have not been changed.",true);message.focus();
  }
  function failure(error:unknown,own:number):void {
    // why: authoritative read denial fences newer requests, even if this generation is old.
    if(error instanceof Refusal&&error.code==="not_found"){authorizationLost();return;}
    if(disposed)return;
    if(!active(own))return;
    clearReceipt();stage="idle";add.disabled=cannotSubmit();up.disabled=browsingPath==="";el<HTMLButtonElement>("#refresh").hidden=false;status(refusalMessage(error),true);focusMessage();
  }
  function selectedRoot(s:Selection):string {return s.mode==="new"?(s.path===""?s.directory:`${s.path}/${s.directory}`):s.path;}
  function intent():Selection|undefined {
    if(selected===undefined)return undefined;
    const explicit=address.value.trim(),ignored=ignoreNonWritable.checked?{ignore_non_writable_folders:true}:{};
    if(explicit!=="")return {mode:"existing",path:selected.path,slug:explicit,name:name.value,...ignored};
    const key=JSON.stringify([selected.id,selected.path,name.value]);
    if(generated?.key!==key)generated={key,slug:generateVaultSlug(name.value)};
    const common={path:selected.path,slug:generated.slug,name:name.value};
    return {mode:"existing",...common,...ignored};
  }
  function showSelection():void {
    el("#folder-selection").hidden=selected===undefined;
    ignoreNonWritable.disabled=selected===undefined||terminal();
    el("#selected-path").textContent=selected===undefined?"No folder selected":`${selected.label} / ${JSON.stringify(selected.path)}`;
  }
  async function browse(path:string,loadLocations=false):Promise<void> {
    if(terminal()||disposed||mkdirBusy||!picker.open)return;
    invalidate();add.disabled=true;
    const {own,signal}=begin();browsingPath=path;current=undefined;select.disabled=true;up.disabled=true;
    rows.replaceChildren();rowListeners.abort();rowListeners=new AbortController();el<HTMLButtonElement>("#add-folder").disabled=true;el("#create-directory").hidden=true;
    el("#current-path").textContent=path||"Location root";el("#folder-state").textContent="";status("Loading server folders…");
    try {
      if(loadLocations){
        const nextLocations=locations(await requestJson("/api/v1/vault-locations",signal));
        if(!active(own))return;
        const previousLocation=location.value;known=nextLocations;location.replaceChildren(...known.map(l=>new Option(l.name,l.id)));
        if(known.some(l=>l.id===previousLocation))location.value=previousLocation;
        if(selected!==undefined&&known.some(l=>l.id===selected?.id))location.value=selected.id;
      }
      if(known.length===0){closePicker();add.disabled=cannotSubmit();status("No server locations are configured. You can create this vault in the default folder, or ask your server operator to configure another location.");return;}
      const next=listing(await requestJson(`/api/v1/vault-locations/${location.value}/directories?${new URLSearchParams({path})}`,signal),path);
      if(!active(own))return;
      current=next;el("#folder-state").textContent=next.state.location_root?"Choose a subfolder; this location is browse-only.":labels[next.state.registration];
      el("#picker-heading").textContent=path===""?(known.find(l=>l.id===location.value)?.name??""):path.slice(path.lastIndexOf("/")+1);
      el("#location-switch").hidden=known.length===1;
      up.hidden=path==="";up.disabled=path==="";select.disabled=!next.state.selectable;
      el<HTMLButtonElement>("#add-folder").disabled=mkdirContexts.has(root)||!next.state.browsable;
      for(const child of next.children){
        const row=document.createElement("li"),button=document.createElement("button"),text=document.createElement("span");
        const icon=document.createElementNS("http://www.w3.org/2000/svg","svg"),shape=document.createElementNS("http://www.w3.org/2000/svg","path");
        icon.setAttribute("viewBox","0 0 24 24");icon.setAttribute("aria-hidden","true");icon.setAttribute("class","folder-icon");
        shape.setAttribute("d","M3 7V5a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7");shape.setAttribute("fill","none");shape.setAttribute("stroke","currentColor");shape.setAttribute("stroke-width","1.5");icon.append(shape);
        button.type="button";text.textContent=child.name;button.append(icon,text);button.disabled=!child.state.browsable;
        button.addEventListener("click",()=>{void browse(child.path);},{signal:rowListeners.signal});row.append(button);
        if(child.state.registration!=="available"){
          const explanation=document.createElement("small");explanation.id=`folder-boundary-${rows.children.length}`;explanation.textContent=labels[child.state.registration];button.setAttribute("aria-describedby",explanation.id);row.append(explanation);
        }
        rows.append(row);
      }
      status(next.children.length===0?"0 folders found":"");
      el("#picker-heading").focus();
    }catch(error){failure(error,own);}
  }
  function changed():void {if(terminal()||disposed||mkdirBusy)return;invalidate();showSelection();status("Details changed.");}
  async function addVault():Promise<void> {
    if(terminal()||disposed||mkdirBusy||mkdirContexts.has(root)||stage==="previewing"||picker.open)return;
    let s:Selection|undefined;
    try{s=intent();}catch{status("A secure vault identifier could not be generated. Reload before trying again.",true);focusMessage();return;}
    if(s===undefined||!validateSelection(s)){status("Enter a vault name and a valid address, or leave the address blank to generate one. Your folder selection is kept.",true);focusMessage();return;}
    const locationId=selected?.id??"",locationLabel=selected?.label??"";
    clearReceipt();const {own,signal}=begin();stage="previewing";add.disabled=true;cancelValidation.hidden=false;
    status("Validating folder…");const started=performance.now();
    try {
      const p=preview(await requestJson(`/api/v1/vault-locations/${locationId}/preview`,signal,s),s);
      if(!active(own))return;
      const deadline=started+120000;
      if(performance.now()>=deadline)throw new Refusal("confirmation_conflict");
      receipt={selection:s,preview:p,deadline};
      await register(locationId,locationLabel,own,signal);
    }catch(error){failure(error,own);}
  }
  function showOutcome(uncertain:boolean):void {
    if(sentWrite!==undefined)sentWrite.outcome=uncertain?"uncertain":"committed";
    rememberTerminal();
    clearReceipt();stage=uncertain?"uncertain":"registered";disableAll();result.hidden=false;
    el("#result-heading").textContent=uncertain?"Registration outcome unknown":"Vault registered";
    el("#result-message").textContent=uncertain?(authorityDenied?"Administration is unavailable for this session or location. Registration may already be committed. Do not retry; return to your vaults and sign in again before fresh administrative discovery.":"The response was lost or could not be verified. Registration may already be committed. Do not retry this operation. Check administrative folder status or return to your vaults; starting again requires fresh discovery."):"Administrative registration is committed. Existing access.toml is unchanged; registration does not grant content access.";
    if(uncertain&&sentWrite!==undefined){
      const {selection:s,locationId,locationLabel}=sentWrite;
      el("#outcomes").style.whiteSpace="pre-wrap";
      el("#outcomes").textContent=`Sent ${s.mode} registration intent: server location ${JSON.stringify(locationLabel)} (${JSON.stringify(locationId)}); selected ${s.mode==="new"?"parent":"folder"} ${JSON.stringify(s.path)}; ${s.mode==="new"?`project folder name ${JSON.stringify(s.directory)}; `:""}project ${JSON.stringify(selectedRoot(s))}; label ${JSON.stringify(s.name)}; internal selection ${JSON.stringify(s.slug)}. Registration does not grant content access.`;
    }
    el<HTMLButtonElement>("#check-outcome").hidden=!uncertain;el<HTMLButtonElement>("#check-outcome").disabled=!uncertain||authorityDenied;
    status(uncertain?"Registration outcome could not be confirmed.":"Registration committed.",uncertain);el("#result-heading").focus();
  }
  async function contentAccess(s:Selection,own:number,signal:AbortSignal):Promise<void> {
    try {
      const canOpen=catalogContains(await requestJson("/api/v1/vaults",signal),s.slug);
      if(!active(own))return;
      el("#content-access").textContent=canOpen?"Your current session can discover this vault through its content policy. Access is checked again when opening.":"This vault is not in your readable vault catalog. Administrative registration does not grant content access. Return to your vaults or ask a policy owner.";
      const open=el<HTMLAnchorElement>("#open-vault");open.hidden=!canOpen;if(canOpen)open.href=`/v/${s.slug}`;
    }catch{if(active(own))el("#content-access").textContent="Content access could not be checked. Registration remains committed; return to your vaults. Administrative registration does not grant content access.";}
  }
  async function register(locationId:string,locationLabel:string,own:number,signal:AbortSignal):Promise<void> {
    if(!active(own)||stage!=="previewing"||receipt===undefined)return;
    const saved=receipt;
    if(performance.now()>=saved.deadline)throw new Refusal("confirmation_conflict");
    // why: consume before dispatch; no double-submit or automatic replay after uncertain transport.
    clearReceipt();stage="registering";disableAll();status("Adding vault…");
    sentWrite={selection:saved.selection,locationId,locationLabel,outcome:"unverified"};
    rememberTerminal();
    try {
      const outcome=committed(await requestJson(`/api/v1/vault-locations/${locationId}/register`,signal,saved.selection,saved.preview.confirmation),saved.selection.slug);
      if(!active(own))return;
      showOutcome(false);el("#outcome-details").hidden=false;el("#secondary-outcomes").textContent=`${outcome.directory_synced?"Directory sync confirmed":"Directory sync not confirmed"}. ${outcome.audit_recorded?"Audit append recorded":"Audit append not recorded (writer may be absent or unavailable)"}. Both are independent postcommit outcomes, not rollback. Watching and initial indexing are ready; index storage is in memory until restart.`;
      await contentAccess(saved.selection,own,signal);
    }catch(error){
      if(error instanceof Refusal&&error.code==="not_found"){authorizationLost();return;}
      if(!active(own))return;
      // why: 404/503 can follow commit; only verified precommit refusal permits a fresh user intent.
      if(error instanceof Refusal&&["invalid_request","confirmation_conflict","permission_layout_conflict","limit_exceeded","busy"].includes(error.code)){
        sentWrite=undefined;stage="idle";root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button").forEach(c=>{c.disabled=false;});
        terminalContexts.delete(root);
        select.disabled=current===undefined||(mode==="existing"?!current.state.selectable:!current.state.browsable);up.disabled=(current?.path??"")==="";failure(error,own);
      }else{if(error instanceof Refusal&&error.code==="not_found")authorizationLost();else showOutcome(true);}
    }
  }

  choose.addEventListener("click",()=>{
    if(terminal()||disposed||mkdirBusy||picker.open)return;
    invalidate();picker.hidden=false;picker.showModal();void browse(selected?.path??"",true);
  },{signal:listeners.signal});
  function cancelPicker():void {if(terminal()||disposed)return;if(mkdirBusy){for(const r of mkdirRequests)r.abort();mkdirBusy=false;showMkdirUnknown();}invalidate();closePicker();status(mkdirContexts.has(root)?"Folder creation outcome unknown. Do not retry.":"Folder selection cancelled.");}
  picker.addEventListener("keydown",event=>{
    if(event.key!=="Tab"||!picker.open)return;
    // why: native modal inertness still allows Tab to browser chrome; keep the dialog cycle explicit.
    const controls=[...picker.querySelectorAll<HTMLButtonElement|HTMLSelectElement|HTMLInputElement>("button,select,input")].filter(c=>!c.disabled&&!c.closest("[hidden]"));
    const first=controls[0],last=controls.at(-1);
    if(first===undefined||last===undefined)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  },{signal:listeners.signal});
  picker.addEventListener("cancel",event=>{event.preventDefault();cancelPicker();},{signal:listeners.signal});
  for(const id of ["#cancel-picker","#close-picker"])el(id).addEventListener("click",cancelPicker,{signal:listeners.signal});
  picker.addEventListener("click",event=>{
    if(event.target!==picker)return;
    const bounds=picker.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)cancelPicker();
  },{signal:listeners.signal});
  location.addEventListener("change",()=>{if(!terminal()&&!disposed&&picker.open)void browse("");},{signal:listeners.signal});
  up.addEventListener("click",()=>{void browse(browsingPath.split("/").slice(0,-1).join("/"));},{signal:listeners.signal});
  el("#refresh").addEventListener("click",()=>{void browse(browsingPath,true);},{signal:listeners.signal});
  select.addEventListener("click",()=>{
    if(current===undefined||select.disabled||terminal()||disposed||mkdirBusy||!picker.open)return;
    const l=known.find(l=>l.id===location.value);if(l===undefined)return;
    invalidate();selected={id:l.id,label:l.name,path:current.path};add.disabled=mkdirContexts.has(root);showSelection();closePicker();status("");
  },{signal:listeners.signal});
  el("#clear-folder").addEventListener("click",()=>{
    if(terminal()||disposed||mkdirBusy||picker.open)return;
    selected=undefined;generated=undefined;ignoreNonWritable.checked=false;invalidate();showSelection();status("");choose.focus();
  },{signal:listeners.signal});
  ignoreNonWritable.addEventListener("change",changed,{signal:listeners.signal});
  [directory,name,address].forEach(input=>input.addEventListener("input",changed,{signal:listeners.signal}));
  details.addEventListener("submit",event=>{
    if(managedSubmitting){event.preventDefault();return;}
    if(managed&&selected===undefined){
      if(terminal()||disposed||mkdirBusy||mkdirContexts.has(root)||stage==="previewing"||picker.open){event.preventDefault();return;}
      if(!details.reportValidity()||name.value.trim()===""){event.preventDefault();status("Enter a vault name.",true);name.focus();return;}
      const slug=address.value.trim();
      if(slug!==""&&!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)){event.preventDefault();status("Use lower-case letters, numbers and hyphens for the address, or leave it blank.",true);address.focus();return;}
      // why: keep the existing same-origin managed POST and its no-JavaScript fallback.
      managedSubmitting=true;add.disabled=true;choose.disabled=true;status("Creating vault…");return;
    }
    event.preventDefault();void addVault();
  },{signal:listeners.signal});
  cancelValidation.addEventListener("click",()=>{if(stage!=="previewing"||disposed)return;invalidate();status("Validation cancelled. Your details are kept.");add.focus();},{signal:listeners.signal});
  el("#check-outcome").addEventListener("click",()=>{
    if(stage!=="uncertain"||disposed||authorityDenied||sentWrite===undefined)return;
    const {selection:s,locationId:id}=sentWrite,{own,signal}=begin();
    void requestJson(`/api/v1/vault-locations/${id}/status?${new URLSearchParams({path:selectedRoot(s)})}`,signal).then(value=>{
      const registered=statusRegistered(value,selectedRoot(s));if(!active(own))return;
      el("#result-message").textContent=registered?"This exact folder is now administratively registered. This status is not a content grant or proof of which request completed. Do not retry registration; return to your vaults.":"Registration is still unconfirmed. No write is retried. Return to your vaults or ask the server operator before starting again.";
    }).catch(error=>{
      // why: status denial must precede ordinary generation filtering and retain write uncertainty.
      if(error instanceof Refusal&&error.code==="not_found"){authorizationLost();return;}
      if(disposed)return;
      if(active(own))el("#result-message").textContent="Registration status is unavailable for this session or location. Do not retry the possibly committed write; return to your vaults.";
    });
  },{signal:listeners.signal});
  // why: remount discards unsent selections/receipts and every content claim; terminal sent-write facts remain visible and non-replayable.
  root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button").forEach(c=>{c.disabled=false;});
  closePicker(false);result.hidden=true;clearReceipt();select.disabled=true;up.disabled=true;add.disabled=cannotSubmit();
  showSelection();rows.replaceChildren();location.replaceChildren();el("#outcomes").textContent="";el("#content-access").textContent="";
  el<HTMLDetailsElement>("#outcome-details").open=false;el("#outcome-details").hidden=true;el("#secondary-outcomes").textContent="";
  el<HTMLButtonElement>("#add-folder").disabled=true;
  el("#mkdir-outcome").hidden=true;showMkdirUnknown();activeDenials.set(root,authorizationLost);
  el<HTMLAnchorElement>("#open-vault").hidden=true;el<HTMLAnchorElement>("#open-vault").removeAttribute("href");status(root.dataset["serverError"]??"",Boolean(root.dataset["serverError"]));
  if(sentWrite!==undefined)showOutcome(sentWrite.outcome!=="committed");
  if(authorityDenied)authorizationLost();
  el("#add-folder").addEventListener("click",()=>{if(disposed||terminal()||mkdirBusy||mkdirContexts.has(root)||current===undefined)return;el("#create-directory").hidden=false;directory.focus();},{signal:listeners.signal});
  el("#cancel-create").addEventListener("click",()=>{if(disposed||mkdirBusy)return;el("#create-directory").hidden=true;el("#add-folder").focus();},{signal:listeners.signal});
  el<HTMLFormElement>("#create-directory").addEventListener("submit",event=>{event.preventDefault();void mkdir();},{signal:listeners.signal});
  async function mkdir():Promise<void>{
    if(disposed||terminal()||mkdirBusy||mkdirContexts.has(root)||current===undefined||!picker.open||el("#create-directory").hidden)return;
    const intent={path:current.path,directory:directory.value},l=known.find(l=>l.id===location.value);
    if(!directoryName(intent.directory)||!relativePath(intent.path===""?intent.directory:`${intent.path}/${intent.directory}`)){status("Enter one usable folder name (up to 255 UTF-8 bytes).",true);directory.focus();return;}
    if(l===undefined)return;const own=version,controller=new AbortController();mkdirRequests.add(controller);mkdirBusy=true;mkdirContexts.set(root,{intent,locationId:l.id,locationLabel:l.name});
    for(const control of picker.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button"))control.disabled=true;
    for(const id of ["#cancel-picker","#close-picker"])el<HTMLButtonElement>(id).disabled=false;add.disabled=true;status("Creating folder…");
    try{
      const created=await createLocationFolder(l.id,intent,controller.signal);if(!active(own)||!mkdirBusy)return;
      mkdirBusy=false;mkdirContexts.delete(root);el("#mkdir-outcome").hidden=true;
      for(const control of picker.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button"))control.disabled=false;
      await browse(created.path);if(!disposed&&!authorityDenied&&!created.directory_synced)status("Folder created. Directory sync was not confirmed; this is not rollback.");
    }catch(error){
      // why: only exact pre-mkdir refusal codes allow a new explicit intent. A final 404 may retain the child.
      if(active(own)&&mkdirBusy&&error instanceof Refusal&&["invalid_request","confirmation_conflict","limit_exceeded","busy"].includes(error.code)){
        mkdirBusy=false;mkdirContexts.delete(root);for(const control of picker.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button"))control.disabled=false;
        select.disabled=current===undefined||!current.state.selectable;up.disabled=browsingPath==="";failure(error,own);return;
      }
      if(error instanceof Refusal&&error.code==="not_found"){authorizationLost();return;}if(!active(own))return;
      mkdirBusy=false;showMkdirUnknown();closePicker();status("Folder creation outcome unknown. Do not retry.",true);
    }finally{mkdirRequests.delete(controller);}
  }
  return ()=>{if(disposed)return;if(sentWrite?.outcome==="unverified"){sentWrite.outcome="uncertain";rememberTerminal();}if(!terminalContexts.has(root))rememberTerminal();disposed=true;++version;request?.abort();for(const r of mkdirRequests)r.abort();closePicker(false);rowListeners.abort();listeners.abort();if(activeDenials.get(root)===authorizationLost)activeDenials.delete(root);};
}
