import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  deletePendingShare,
  pendingShareFrom,
  readPendingShare,
  receiveShareTarget,
  storePendingShare,
} from "./share-inbox.js";

describe("share target inbox", () => {
  it("stores text and bounded image shares until successful submission", async () => {
    const factory = new IDBFactory();
    const form = new FormData();
    form.set("title", "Photo");
    form.set("text", "From the camera");
    form.append("files", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "photo.png");
    const share = await pendingShareFrom(form, "share-1");
    if (share === undefined) throw new Error("valid share was rejected");

    await storePendingShare(share, factory);
    expect(await readPendingShare("share-1", factory)).toMatchObject({
      title: "Photo",
      text: "From the camera",
      files: [{ name: "photo.png", type: "image/png" }],
    });
    await deletePendingShare("share-1", factory);
    expect(await readPendingShare("share-1", factory)).toBeUndefined();
  });

  it("redirects a multipart POST to the durable share id", async () => {
    const factory = new IDBFactory();
    const form = new FormData();
    form.set("text", "Remember this");
    const request = new Request("https://notes.example/share", { method: "POST", body: form });

    const response = await receiveShareTarget(request, factory, () => "share-2");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://notes.example/share?share=share-2");
    expect(await readPendingShare("share-2", factory)).toMatchObject({ text: "Remember this" });
  });

  it("rejects non-image and oversized file shares", async () => {
    const form = new FormData();
    form.append("files", new Blob(["text"], { type: "text/plain" }), "note.txt");
    expect(await pendingShareFrom(form, "bad")).toBeUndefined();
  });
});
