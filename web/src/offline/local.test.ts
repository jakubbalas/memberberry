/**
 * The page's replica handle (`SPEC.md` §7.2).
 *
 * Two decisions worth pinning: it is opened once however many things ask, and a browser that
 * refuses to store anything gets a working application without an offline copy rather than
 * an error.
 */

import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { localReplica, setLocalReplica } from "./local.js";
import { stubReplica } from "./testing.js";

afterEach(() => {
  setLocalReplica(undefined);
  Reflect.deleteProperty(globalThis, "indexedDB");
});

describe("the page's replica", () => {
  it("is absent where there is nowhere to keep one", async () => {
    // A private window that refuses IndexedDB, or a test environment. Every consumer treats
    // this as "no stored answer", which is the online-only behaviour the shell had before.
    expect(await localReplica()).toBeUndefined();
  });

  it("opens once, however many things ask", async () => {
    // The note catalog and every note pane call this. Opening a database per caller would be
    // a connection per pane, and IndexedDB blocks version upgrades on open connections.
    Object.defineProperty(globalThis, "indexedDB", { value: new IDBFactory(), configurable: true });
    const [first, second] = await Promise.all([localReplica(), localReplica()]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it("survives a store that will not open", async () => {
    // Quota exhausted, or a browser that refuses. Silent on purpose: there is nothing a user
    // can do about it, and an error on every page load teaches people to ignore the console.
    Object.defineProperty(globalThis, "indexedDB", {
      value: {
        open: () => {
          throw new Error("no");
        },
        deleteDatabase: () => undefined,
      },
      configurable: true,
    });
    expect(await localReplica()).toBeUndefined();
  });

  it("can be replaced, which is how a test avoids touching a real store", async () => {
    const stub = stubReplica();
    setLocalReplica(Promise.resolve(stub));
    expect(await localReplica()).toBe(stub);
  });
});
