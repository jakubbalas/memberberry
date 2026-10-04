// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import SidebarDivider from "./SidebarDivider.svelte";

const apps: ReturnType<typeof mount>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await unmount(app); document.body.replaceChildren(); });
function pointer(type: string, x: number, id = 1, button = 0): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}
async function render(side: "left" | "right" = "left") {
  const target = document.createElement("div"); document.body.append(target);
  const onresize = vi.fn();
  const app = mount(SidebarDivider, { target, props: { side, label: "Navigation", width: 260, maximum: 500, onresize } });
  apps.push(app); await tick();
  const element = target.querySelector<HTMLButtonElement>("button");
  if (element === null) throw new Error("missing divider");
  const capture = new Set<number>();
  element.setPointerCapture = (id) => { capture.add(id); };
  element.hasPointerCapture = (id) => capture.has(id);
  element.releasePointerCapture = vi.fn((id) => { capture.delete(id); });
  return { app, element, onresize, capture };
}

it.each([["left", 270], ["right", 250]] as const)("drags the %s panel in its own direction", async (side, expected) => {
  const view = await render(side);
  const down = pointer("pointerdown", 100);
  view.element.dispatchEvent(down);
  view.element.dispatchEvent(pointer("pointermove", 110));
  expect(view.onresize).toHaveBeenLastCalledWith(expected);
  expect(down.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(view.element);
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])("stops a drag after %s", async (event) => {
  const view = await render();
  view.element.dispatchEvent(pointer("pointerdown", 100));
  view.element.dispatchEvent(pointer("pointermove", 150));
  expect(view.onresize).toHaveBeenCalledTimes(1);
  if (event === "lostpointercapture") view.capture.clear();
  view.element.dispatchEvent(pointer(event, 150));
  view.element.dispatchEvent(pointer("pointermove", 200));
  expect(view.onresize).toHaveBeenCalledTimes(1);
  expect(view.capture.size).toBe(0);
});

it("ignores secondary buttons and unrelated pointers without stealing the current drag", async () => {
  const view = await render();
  view.element.dispatchEvent(pointer("pointerdown", 100, 1, 2));
  view.element.dispatchEvent(pointer("pointermove", 200));
  expect(view.onresize).not.toHaveBeenCalled();
  view.element.dispatchEvent(pointer("pointerdown", 100));
  view.element.dispatchEvent(pointer("pointerdown", 400, 2));
  view.element.dispatchEvent(pointer("pointercancel", 400, 2));
  view.element.dispatchEvent(pointer("lostpointercapture", 400, 2));
  view.element.dispatchEvent(pointer("pointermove", 150));
  expect(view.onresize).toHaveBeenLastCalledWith(310);
  expect(view.capture.has(2)).toBe(false);
});

it("releases an active capture when the divider unmounts", async () => {
  const view = await render();
  view.element.dispatchEvent(pointer("pointerdown", 100));
  expect(view.capture.has(1)).toBe(true);
  await unmount(view.app); apps.splice(apps.indexOf(view.app), 1);
  expect(view.capture.size).toBe(0);
  expect(view.element.releasePointerCapture).toHaveBeenCalledWith(1);
});

it("clamps pointer resizing to the supported sidebar bounds", async () => {
  const view = await render();
  view.element.dispatchEvent(pointer("pointerdown", 100));
  view.element.dispatchEvent(pointer("pointermove", -1000));
  expect(view.onresize).toHaveBeenLastCalledWith(Number(view.element.getAttribute("aria-valuemin")));
  view.element.dispatchEvent(pointer("pointermove", 1000));
  expect(view.onresize).toHaveBeenLastCalledWith(500);
});
