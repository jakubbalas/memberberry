import { expect, it, vi } from "vitest";
import { matchesBuild, watchAppUpdates } from "./updates.js";

function worker(current: boolean): ServiceWorker {
  return Object.assign(new EventTarget(), {
    postMessage: (_data: unknown, ports: Transferable[]) => {
      const port = ports[0] as MessagePort;
      port.postMessage({ current });
    },
  }) as unknown as ServiceWorker;
}

it.each([true, false])("identifies whether the waiting build contains this page's entry: %s", async current => {
  expect(await matchesBuild(worker(current), "https://notes.example/assets/app.js")).toBe(current);
});

it("shows a downloaded update without reloading, checks on return and removes its listeners", async () => {
  const candidate = worker(false);
  const registration = Object.assign(new EventTarget(), { waiting: candidate, installing: candidate, update: vi.fn(async () => undefined) });
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let shown: () => void = () => { throw new Error("uninitialized"); };
  const showing = new Promise<void>(resolve => { shown = resolve; });
  const available = vi.fn((value: boolean) => { if (value) shown(); });
  const stop = watchAppUpdates({
    workers: { controller: candidate, ready: Promise.resolve(registration) } as unknown as ServiceWorkerContainer,
    window: window as unknown as Window,
    document: document as unknown as Document,
    entry: "https://notes.example/assets/old.js", available,
  });
  await showing;
  expect(available).toHaveBeenLastCalledWith(true);
  registration.update.mockClear();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  expect(registration.update).toHaveBeenCalledTimes(1);
  stop();
  registration.update.mockClear(); available.mockClear();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  candidate.dispatchEvent(new Event("statechange"));
  await Promise.resolve();
  expect(registration.update).not.toHaveBeenCalled();
  expect(available).not.toHaveBeenCalled();
});

it("never offers an update to a page the Vite dev server loaded from source, which no build contains", async () => {
  // Regression: on `make dev`'s 9011 the page's entry is `/@vite/client` and `/src/main.ts`,
  // so every waiting build "lacked" it and "Update available" stayed up through any reload.
  const candidate = worker(false);
  const registration = Object.assign(new EventTarget(), { waiting: candidate, installing: null, update: vi.fn(async () => undefined) });
  const available = vi.fn();
  const stop = watchAppUpdates({
    workers: { controller: candidate, ready: Promise.resolve(registration) } as unknown as ServiceWorkerContainer,
    window: new EventTarget() as unknown as Window,
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }) as unknown as Document,
    entry: ["http://127.0.0.1:9011/@vite/client", "http://127.0.0.1:9011/src/main.ts"], available,
  });
  await new Promise(resolve => { setTimeout(resolve, 20); });
  stop();
  expect(available).not.toHaveBeenCalledWith(true);
});
