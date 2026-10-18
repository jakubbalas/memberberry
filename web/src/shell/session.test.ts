import { expect, it } from "vitest";
import { startWorkspace } from "./session.js";
import { createWorkspaceTransport } from "./workspace-sync.js";
import { parseWorkspace } from "./workspace-storage.js";
import { counterIds, tabs } from "./workspace.js";

it("saves the latest scroll position when the workspace closes, even without another tab mutation", async () => {
  const writes: string[] = [];
  const request: typeof fetch = async (_input, init) => {
    if (init?.method !== "PUT") return new Response(null, { status: 404 });
    if (typeof init.body === "string") writes.push(init.body);
    return new Response(null, { status: 200 });
  };
  const transport = createWorkspaceTransport({ vault: "personal", device: "phone", ids: counterIds(), fetch: request });
  const session = await startWorkspace({ vault: "personal", note: "Note.md", transport });
  const active = session.store.activeTab;
  if (active === undefined) throw new Error("missing note tab");
  session.store.setScroll(active.id, 321);
  await session.destroy();
  const saved = writes.at(-1);
  if (saved === undefined) throw new Error("no layout saved");
  expect(tabs(parseWorkspace(saved, "personal", counterIds()).workspace.root)[0]?.scroll).toBe(321);
});
