/**
 * Registering the service worker (`SPEC.md` §7.4).
 *
 * Two decisions, both of which have to hold in browsers this project cannot test in: a
 * failed registration must not break the page, and the registration must not run while the
 * page is still fetching its own critical path (§21.2).
 */

import { describe, expect, it, vi } from "vitest";

import { SERVICE_WORKER_URL, afterLoad, registerOfflineShell, retireWorkers } from "./register.js";

describe("registering the worker", () => {
  it("asks for a root scope and a revalidated script", () => {
    // Root scope is what lets one worker control `/v/<vault>/<note>`; `updateViaCache: "none"`
    // is what stops an HTTP cache pinning a browser to one build's precache list.
    const register = vi.fn(async () => ({}));
    return registerOfflineShell({ register }).then((registered) => {
      expect(registered).toBe(true);
      expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
        scope: "/",
        updateViaCache: "none",
      });
    });
  });

  it("reports nothing registered when the browser has no support", async () => {
    expect(await registerOfflineShell(undefined)).toBe(false);
  });

  it("survives a browser that refuses, silently", async () => {
    // A private window may throw here. Offline support is an enhancement: the application
    // still works, and an error nobody can act on is an error people learn to ignore.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const register = vi.fn(async () => {
      throw new Error("registration is disabled");
    });
    expect(await registerOfflineShell({ register })).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("retiring workers from a page loaded from source", () => {
  it("unregisters every worker on the origin", async () => {
    const unregister = vi.fn(async () => true);
    const retired = await retireWorkers({ getRegistrations: async () => [{ unregister }, { unregister }] });
    expect([retired, unregister.mock.calls.length]).toEqual([2, 2]);
  });

  it("counts only the workers that went, and survives a browser that refuses", async () => {
    const one = await retireWorkers({ getRegistrations: async () => [{ unregister: async () => true }, { unregister: async () => { throw new Error("no"); } }] });
    const none = await retireWorkers({ getRegistrations: async () => { throw new Error("blocked"); } });
    expect([one, none, await retireWorkers(undefined)]).toEqual([1, 0, 0]);
  });
});

describe("waiting for the page to load", () => {
  it("runs immediately when the page has already finished", () => {
    const task = vi.fn();
    afterLoad({ document: { readyState: "complete" }, addEventListener: vi.fn() }, task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("waits for the load event otherwise, and only fires once", () => {
    const task = vi.fn();
    const listeners: Array<() => void> = [];
    const target = {
      document: { readyState: "loading" },
      addEventListener: vi.fn((_type: "load", listener: () => void) => {
        listeners.push(listener);
      }),
    };
    afterLoad(target, task);
    expect(task).not.toHaveBeenCalled();
    expect(target.addEventListener).toHaveBeenCalledWith("load", expect.any(Function), { once: true });
    listeners[0]?.();
    expect(task).toHaveBeenCalledTimes(1);
  });
});
