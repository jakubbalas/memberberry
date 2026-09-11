import { readCreated, type CreateResult } from "./create.js";

/** A lexical check for a relative folder name; the server still authorizes every operation. */
export function validFolder(path: string): boolean {
  return path !== "" && !/[\\\u0000-\u001f]/.test(path) && path.split("/").every((part) => part !== "" && !part.startsWith("."));
}

/** Validates the server's permission-filtered empty-directory list. */
export function readFolders(body: unknown): readonly string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const folders: unknown = (body as Record<string, unknown>)["folders"];
  return Array.isArray(folders) && folders.every((path: unknown) => typeof path === "string" && validFolder(path))
    ? folders as string[] : undefined;
}

/** Fetches only authorized empty folders; unavailable lists are never cached as permissions. */
export async function fetchFolders(vault: string, request: typeof fetch = globalThis.fetch): Promise<readonly string[] | undefined> {
  try {
    const response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/folders`);
    return response.ok ? readFolders(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

/** Creates a folder through the authenticated endpoint and validates its response. */
export async function createFolder(vault: string, path: string, request: typeof fetch = globalThis.fetch): Promise<CreateResult> {
  if (!validFolder(path)) return { refused: "That is not a usable folder name." };
  try {
    const response = await request(`/api/v1/vaults/${encodeURIComponent(vault)}/folders`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
    });
    if (!response.ok) return { refused: "The folder could not be created. Check the name and your write access." };
    const created = readCreated(await response.json());
    return created !== undefined && created.path === path ? { ok: created } : { refused: "The server returned an invalid folder." };
  } catch {
    return { refused: "The server could not be reached." };
  }
}
