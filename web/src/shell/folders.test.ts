import { describe, expect, it } from "vitest";
import { createFolder, fetchFolders, readFolders, validFolder } from "./folders.js";

describe("folder requests", () => {
  it("accepts Unicode and nested folders while rejecting unsafe paths", () => {
    expect(validFolder("Projects/Ideas 📓")).toBe(true);
    for (const path of ["", "../escape", "/absolute", ".hidden", "A//B", "A\\B", "A\u0000B"]) expect(validFolder(path)).toBe(false);
  });
  it("refuses malformed folder lists", () => {
    expect(readFolders({ folders: ["Projects/Empty"] })).toEqual(["Projects/Empty"]);
    for (const body of [null, {}, { folders: [1] }, { folders: ["../private"] }]) expect(readFolders(body)).toBeUndefined();
  });
  it("returns only the server's authorized list", async () => {
    const request: typeof fetch = async () => new Response(JSON.stringify({ folders: ["Shared/Empty"] }));
    expect(await fetchFolders("personal", request)).toEqual(["Shared/Empty"]);
  });
  it("clears unavailable folder lists on refusal, disconnection or malformed JSON", async () => {
    for (const request of [async () => new Response("", { status: 404 }), async () => new Response("bad json"), async () => { throw new Error("offline"); }]) {
      expect(await fetchFolders("personal", request)).toBeUndefined();
    }
  });
  it("creates the requested folder and validates the returned path", async () => {
    const requests: unknown[] = [];
    const request: typeof fetch = async (url, options) => {
      requests.push([url, options?.method, JSON.parse(String(options?.body))]);
      return new Response(JSON.stringify({ path: "Ideas" }));
    };
    expect(await createFolder("personal", "Ideas", request)).toEqual({ ok: { path: "Ideas" } });
    expect(requests).toEqual([["/api/v1/vaults/personal/folders", "POST", { path: "Ideas" }]]);
    expect(await createFolder("personal", "Different", request)).toHaveProperty("refused");
  });
  it("refuses bad names before sending and reports denied or failed writes", async () => {
    let calls = 0;
    const request: typeof fetch = async () => { calls += 1; return new Response("", { status: 404 }); };
    expect(await createFolder("personal", "../escape", request)).toHaveProperty("refused");
    expect(calls).toBe(0);
    expect(await createFolder("personal", "Ideas", request)).toHaveProperty("refused");
    expect(await createFolder("personal", "Ideas", async () => { throw new Error("offline"); })).toHaveProperty("refused");
  });
});

it("deletes folders with their exact confirmation through the authenticated endpoint", async () => {
  const { deleteFolder } = await import("./folders.js");
  const sent: unknown[] = [];
  const request: typeof fetch = async (url, options) => {
    sent.push([url, options?.method, JSON.parse(String(options?.body))]);
    return new Response(null, { status: 204 });
  };
  expect(await deleteFolder("my vault", "Parent/ملاحظات ✨", "ملاحظات ✨", request)).toBeUndefined();
  expect(sent).toEqual([["/api/v1/vaults/my%20vault/folders", "DELETE", { path: "Parent/ملاحظات ✨", confirmation: "ملاحظات ✨" }]]);
  expect(await deleteFolder("v", "Empty", undefined, request)).toBeUndefined();
  expect(sent[1]).toEqual(["/api/v1/vaults/v/folders", "DELETE", { path: "Empty" }]);
});

it("reports confirmation, permission and network failures and rejects unsafe folder deletion locally", async () => {
  const { deleteFolder } = await import("./folders.js");
  let calls = 0;
  const request: typeof fetch = async () => { calls += 1; return new Response(null, { status: 204 }); };
  expect(await deleteFolder("v", "../escape", undefined, request)).toBeDefined();
  expect(calls).toBe(0);
  for (const status of [200, 404, 409, 503]) {
    expect(await deleteFolder("v", "Folder", undefined, async () => new Response(null, { status }))).toBeDefined();
  }
  expect(await deleteFolder("v", "Folder", undefined, async () => { throw new Error("offline"); })).toContain("Refresh");
});
