/** Read-side wire shapes from SPEC §6.1, validated before rendering. */
export interface FolderState {
  location_root: boolean;
  registration: "available" | "already_registered" | "inside_registered_vault" | "contains_registered_vault";
  selectable: boolean;
  browsable: boolean;
}
export interface Directory { name: string; path: string; state: FolderState }
export interface Listing { path: string; state: FolderState; children: Directory[] }
export interface Location { id: string; name: string }
export function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
}
/** Unicode-mode matching finds lone UTF-16 surrogates, but permits paired astral characters. */
export function wellFormedUnicode(value: string): boolean {
  // why: TextEncoder and URLSearchParams replace lone surrogates; never repair literal tokens.
  return !/[\ud800-\udfff]/u.test(value);
}
export function directoryName(value: unknown): value is string {
  return typeof value === "string" && wellFormedUnicode(value) && new TextEncoder().encode(value).length <= 255 && !/^\p{White_Space}*$/u.test(value)
    && !value.startsWith(".") && !/[/\\\u0000-\u001f\u007f-\u009f]/u.test(value) && !/^[a-z]:/i.test(value);
}
export function relativePath(value: unknown): value is string {
  return typeof value === "string" && wellFormedUnicode(value) && new TextEncoder().encode(value).length <= 1024
    && (value === "" || (value.split("/").length <= 16 && value.split("/").every(directoryName)));
}
function folderState(value: unknown, root: boolean): FolderState {
  if (!object(value,["location_root","registration","selectable","browsable"]) || value["location_root"] !== root
    || typeof value["selectable"] !== "boolean" || typeof value["browsable"] !== "boolean") throw new Error("schema");
  const registration = value["registration"];
  if (registration !== "available" && registration !== "already_registered" && registration !== "inside_registered_vault" && registration !== "contains_registered_vault") throw new Error("schema");
  if (value["selectable"] !== (!root && registration === "available")
    || value["browsable"] !== (registration === "available" || registration === "contains_registered_vault")) throw new Error("schema");
  return { location_root: root, registration, selectable: value["selectable"], browsable: value["browsable"] };
}
export function locations(value: unknown): Location[] {
  if (!object(value,["locations"]) || !Array.isArray(value["locations"]) || value["locations"].length > 32) throw new Error("schema");
  const ids = new Set<string>();
  return value["locations"].map((v: unknown) => {
    if (!object(v,["id","name"]) || typeof v["id"] !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(v["id"])
      || typeof v["name"] !== "string" || /^\p{White_Space}*$/u.test(v["name"]) || /[\u0000-\u001f\u007f-\u009f]/u.test(v["name"])
      || new TextEncoder().encode(v["name"]).length > 256 || ids.has(v["id"])) throw new Error("schema");
    ids.add(v["id"]);
    return { id: v["id"], name: v["name"] };
  });
}
export function listing(value: unknown, path: string): Listing {
  if (!object(value,["path","state","children"]) || value["path"] !== path || !relativePath(path)
    || !Array.isArray(value["children"]) || value["children"].length > 128) throw new Error("schema");
  const state = folderState(value["state"], path === "");
  if (!state.browsable) throw new Error("schema");
  const names = new Set<string>();
  const children = value["children"].map((v: unknown) => {
    if (!object(v,["name","path","state"]) || !directoryName(v["name"]) || names.has(v["name"])
      || v["path"] !== (path === "" ? v["name"] : `${path}/${v["name"]}`) || !relativePath(v["path"])) throw new Error("schema");
    names.add(v["name"]);
    return { name: v["name"], path: v["path"], state: folderState(v["state"],false) };
  });
  return { path, state, children };
}
