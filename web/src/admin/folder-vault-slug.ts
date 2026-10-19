/** Builds a route identifier only; the caller's label/path bytes are never changed. */
export function composeVaultSlug(label:string,suffix:string):string {
  if(!/^[a-f0-9]{12}$/.test(suffix))throw new Error("invalid slug entropy");
  const base=label.normalize("NFKD").replace(/\p{Mark}/gu,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  return `${(base || "vault").slice(0,51).replace(/-+$/g,"")}-${suffix}`;
}
/** Gets independent secure entropy without a catalog lookup or nonsecure fallback. */
export function generateVaultSlug(label:string):string {
  const bytes=crypto.getRandomValues(new Uint8Array(6));
  return composeVaultSlug(label,[...bytes].map(b=>b.toString(16).padStart(2,"0")).join(""));
}
