/**
 * The vault's note list, and where it comes from when there is no server (`SPEC.md` §7.2).
 *
 * The catalog is what the tree, the switcher and the breadcrumbs read, so what it holds
 * after a refresh decides what the whole shell can show offline — and, on a refusal, what it
 * must stop showing.
 */

import { describe, expect, it, vi } from "vitest";

import type { CatalogAnswer } from "../offline/replica.js";
import { NoteCatalog } from "./note-catalog.svelte.js";

const NOTES = [{ path: "One.md", title: "One" }];

/** A replica that records what it was asked to reconcile and answers with `stored`. */
function replicaHolding(stored: readonly { path: string; title: string | null }[]) {
  const seen: CatalogAnswer[] = [];
  return {
    seen,
    handle: async () => ({
      reconcile: async (_vault: string, answer: CatalogAnswer) => {
        seen.push(answer);
        return answer.kind === "ok" ? answer.notes : answer.kind === "denied" ? [] : stored;
      },
      isResident: async () => false,
      metadata: async () => undefined,
      opened: async () => undefined,
    }),
  };
}

describe("loading the catalog", () => {
  it("holds what the server listed", async () => {
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "ok", notes: NOTES }),
      replica: async () => undefined,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual(NOTES);
    expect(catalog.ready).toBe(true);
  });

  it("holds nothing the server refused, even with a replica", async () => {
    const replica = replicaHolding(NOTES);
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "denied" }),
      replica: replica.handle,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
  });

  it("falls back to the replica when there is no server", async () => {
    // This is the tree and the quick switcher working on a train.
    const replica = replicaHolding(NOTES);
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "unreachable" }),
      replica: replica.handle,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual(NOTES);
    expect(replica.seen).toEqual([{ kind: "unreachable" }]);
  });

  it("shows nothing offline on a device with nowhere to keep a replica", async () => {
    // A private window that refuses IndexedDB. The application still works; it just has no
    // offline copy, which is exactly the behaviour it had before §7.2.
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => ({ kind: "unreachable" }),
      replica: async () => undefined,
    });
    await catalog.refresh();
    expect(catalog.notes).toEqual([]);
  });

  it("asks once however many callers want it", async () => {
    // Both the tree and the palette call `ensure`, and the tree calls it from an effect that
    // can re-run — so a second call must not be a second request for a 10 000-note index.
    let calls = 0;
    const catalog = new NoteCatalog({
      vault: "personal",
      load: async () => {
        calls += 1;
        return { kind: "ok", notes: NOTES } satisfies CatalogAnswer;
      },
      replica: async () => undefined,
    });

    catalog.ensure();
    catalog.ensure();
    await vi.waitFor(() => expect(catalog.ready).toBe(true));

    expect(calls).toBe(1);
    catalog.ensure();
    expect(calls).toBe(1);
  });
});
