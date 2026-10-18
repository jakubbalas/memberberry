import { expect, it, vi } from "vitest";
import { watchInstallation } from "./install.js";

it("offers installation only when the browser provides a prompt, invoked by the user", async () => {
  const target = new EventTarget();
  const available = vi.fn();
  const controller = watchInstallation(target, false, available);
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(async () => undefined);
  Object.assign(event, { prompt });
  target.dispatchEvent(event);
  expect(available).toHaveBeenLastCalledWith(true);
  expect(prompt).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
  await controller.install();
  await controller.install();
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(available).toHaveBeenLastCalledWith(false);
  controller.destroy();
});

it("does not offer another installation in an installed window", () => {
  const target = new EventTarget();
  const available = vi.fn();
  const controller = watchInstallation(target, true, available);
  target.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined }));
  expect(available).not.toHaveBeenCalled();
  controller.destroy();
});

it("removes availability after installation and releases listeners on teardown", () => {
  const target = new EventTarget();
  const available = vi.fn();
  const controller = watchInstallation(target, false, available);
  target.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined }));
  target.dispatchEvent(new Event("appinstalled"));
  expect(available).toHaveBeenLastCalledWith(false);
  controller.destroy();
  available.mockClear();
  target.dispatchEvent(Object.assign(new Event("beforeinstallprompt"), { prompt: async () => undefined }));
  target.dispatchEvent(new Event("appinstalled"));
  expect(available).not.toHaveBeenCalled();
});
