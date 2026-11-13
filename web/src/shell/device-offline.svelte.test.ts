import { describe, expect, it } from "vitest";

import { DeviceOffline } from "./device-offline.svelte.js";

const serverVault = {
  server: true,
  online: true,
  pins: { vault: false, folders: [], notes: ["A.md"] },
  downloaded: ["A.md"],
  held: [],
};

function respond(status: number, body: unknown): typeof globalThis.fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("the desktop offline state", () => {
  it("is read from the app's endpoint for a server vault", async () => {
    const offline = new DeviceOffline({ vault: "work", fetch: respond(200, serverVault) });
    await offline.refresh();
    expect(offline.snapshot?.downloaded).toEqual(["A.md"]);
  });

  it("is absent on a server without the endpoint", async () => {
    const offline = new DeviceOffline({ vault: "work", fetch: respond(404, {}) });
    await offline.refresh();
    expect(offline.snapshot).toBeUndefined();
  });

  it("reports a refusal in the server's words", async () => {
    const offline = new DeviceOffline({ vault: "work", fetch: respond(409, { error: "The folder Projects is available offline." }) });
    const message = await offline.apply({ label: "Online only", kind: "note", path: "Projects/A.md", offline: false });
    expect(message).toBe("The folder Projects is available offline.");
  });

  it("stops re-reading when its watch is torn down", () => {
    const offline = new DeviceOffline({ vault: "work", fetch: respond(200, serverVault) });
    let cleared: unknown;
    const stop = offline.watch(
      ((() => 42) as unknown) as typeof setInterval,
      ((id: unknown) => {
        cleared = id;
      }) as typeof clearInterval,
    );
    stop();
    expect(cleared).toBe(42);
  });
});
