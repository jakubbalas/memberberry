import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import { createMediaUploader, openUploadQueue, type MediaUploaderOptions, type QueuedUpload, type UploadQueue } from "./media-upload.js";

const hash = "a".repeat(64);
const path = `media/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.png`;

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

function harness(): { readonly queue: UploadQueue; readonly options: MediaUploaderOptions } {
  const records = new Map<string, QueuedUpload>();
  const queue: UploadQueue = {
    put: async (upload) => { records.set(upload.id, upload); },
    all: async (vault) => [...records.values()].filter((upload) => upload.vault === vault),
    delete: async (id) => { records.delete(id); },
    close: vi.fn(),
  };
  let next = 0;
  return {
    queue,
    options: {
      queue: Promise.resolve(queue),
      uuid: () => `upload-${next++}`,
      createObjectURL: () => "blob:optimistic",
      revokeObjectURL: vi.fn(),
      online: new EventTarget(),
    },
  };
}

describe("media uploader", () => {
  it("posts the file and returns the validated content-addressed path", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ path }, { status: 201 }),
    );
    const file = new File(["image"], "screen shot.png", { type: "image/png" });
    const { options } = harness();
    const uploader = createMediaUploader("my vault", fetcher, options);
    await expect(uploader.upload(file)).resolves.toEqual({ path });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/vaults/my%20vault/media", {
      method: "POST",
      headers: { "X-Memberberry-Filename": "screen shot.png" },
      body: file,
    });
    uploader.destroy();
  });

  it("retains the original before uploading a client-downscaled image", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ path }, { status: 201 }),
    );
    const original = new File(["original"], "photo.png", { type: "image/png" });
    const display = new File(["small"], "photo.png", { type: "image/png" });
    const { options } = harness();
    const uploader = createMediaUploader("personal", fetcher, {
      ...options,
      maxDimension: 1200,
      prepare: async (file, maximum) => {
        expect(file).toBe(original);
        expect(maximum).toBe(1200);
        return { original, display };
      },
    });
    await expect(uploader.upload(original)).resolves.toEqual({ path });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(original);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(display);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      "X-Memberberry-Filename": "photo.png",
      "X-Memberberry-Original": path,
    });
    uploader.destroy();
  });

  it("uploads an edited display copy with its source path", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response({ path }, { status: 201 }),
    );
    const { options } = harness();
    const uploader = createMediaUploader("personal", fetcher, options);
    await expect(uploader.uploadDerived?.(
      new File(["edited"], "edited.png", { type: "image/png" }),
      path,
    )).resolves.toEqual({ path });
    expect(fetcher.mock.calls[0]?.[1]).toEqual({
      method: "POST",
      headers: { "X-Memberberry-Filename": "edited.png", "X-Memberberry-Source": path },
      body: expect.any(File),
    });
    uploader.destroy();
  });

  it("queues a network failure and resolves its optimistic URL after flush", async () => {
    let offline = true;
    const fetcher = vi.fn(async () => {
      if (offline) throw new TypeError("offline");
      return response({ path }, { status: 201 });
    });
    const { queue, options } = harness();
    const uploader = createMediaUploader("personal", fetcher, options);
    const result = await uploader.upload(new File(["image"], "screen.png", { type: "image/png" }));
    expect(result.path).toBe("blob:optimistic");
    expect(await queue.all("personal")).toHaveLength(1);
    offline = false;
    await uploader.flush();
    await expect(result.pending).resolves.toEqual({ path });
    expect(await queue.all("personal")).toEqual([]);
    uploader.destroy();
  });

  it("reconnects a persisted placeholder after the editor reloads", async () => {
    const { queue, options } = harness();
    await queue.put({
      id: "persisted",
      vault: "personal",
      name: "offline.png",
      type: "image/png",
      bytes: new Uint8Array([1]).buffer,
      resolvesEditor: true,
      temporaryPath: "blob:before-reload",
    });
    let release: ((queue: UploadQueue) => void) | undefined;
    const heldQueue = new Promise<UploadQueue>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async () => response({ path }, { status: 201 }));
    const uploader = createMediaUploader("personal", fetcher, {
      ...options,
      queue: heldQueue,
      createObjectURL: () => "blob:after-reload",
    });
    const replacements: Array<readonly [string, string]> = [];
    const final = new Promise<void>((resolve) => {
      uploader.onResolved?.((from, to) => {
        replacements.push([from, to]);
        if (to === path) resolve();
      });
    });
    release?.(queue);
    await final;
    expect(replacements).toEqual([
      ["blob:before-reload", "blob:after-reload"],
      ["blob:after-reload", path],
    ]);
    uploader.destroy();
  });

  it("rejects a failed upload without queuing an authorization failure", async () => {
    const fetcher = vi.fn(async () => response({ error: "denied" }, { status: 404 }));
    const { queue, options } = harness();
    const uploader = createMediaUploader("personal", fetcher, options);
    await expect(uploader.upload(new File(["x"], "x.png"))).rejects.toThrow("media upload failed (404)");
    expect(await queue.all("personal")).toEqual([]);
    uploader.destroy();
  });

  it("rejects a response that is not a safe media path", async () => {
    const fetcher = vi.fn(async () => response({ path: "../secret.txt" }, { status: 201 }));
    const { options } = harness();
    const uploader = createMediaUploader("personal", fetcher, options);
    await expect(uploader.upload(new File(["x"], "x.png"))).rejects.toThrow("invalid path");
    uploader.destroy();
  });

  it("rejects a content address whose fanout does not match its hash", async () => {
    const malformed = `media/ff/${hash.slice(2, 4)}/${hash}.png`;
    const fetcher = vi.fn(async () => response({ path: malformed }, { status: 201 }));
    const { options } = harness();
    const uploader = createMediaUploader("personal", fetcher, options);
    await expect(uploader.upload(new File(["x"], "x.png"))).rejects.toThrow("invalid path");
    uploader.destroy();
  });
});

describe("offline media queue", () => {
  it("survives closing and reopening IndexedDB", async () => {
    const factory = new IDBFactory();
    const first = await openUploadQueue(factory);
    await first.put({
      id: "one",
      vault: "personal",
      name: "screen.png",
      type: "image/png",
      bytes: new Uint8Array([1, 2, 3]).buffer,
      resolvesEditor: true,
    });
    first.close();

    const second = await openUploadQueue(factory);
    const [stored] = await second.all("personal");
    expect(stored?.name).toBe("screen.png");
    expect([...new Uint8Array(stored?.bytes ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
    second.close();
  });
});
