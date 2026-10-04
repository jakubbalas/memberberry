// @vitest-environment jsdom
import { mount, tick, unmount, type ComponentProps } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ContextMenu from "./ContextMenu.svelte";

const apps: ReturnType<typeof mount>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await unmount(app); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function render(props: Partial<ComponentProps<typeof ContextMenu>> = {}) {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const target = document.createElement("div"); document.body.append(target);
  const ondismiss = vi.fn();
  const onopenmain = vi.fn();
  const app = mount(ContextMenu, { target, props: { open: true, x: 20, y: 30, onopenmain, onmove: vi.fn(), ondismiss, ...props } });
  apps.push(app); await tick();
  const items = [...target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  return { app, opener, target, ondismiss, onopenmain, items };
}
function key(target: EventTarget, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
}

it("focuses the first action, wraps keyboard navigation, and returns Escape focus to the opener", async () => {
  const view = await render();
  expect(document.activeElement).toBe(view.items[0]);
  key(document.activeElement ?? window, "ArrowUp");
  expect(document.activeElement).toBe(view.items[1]);
  key(document.activeElement ?? window, "ArrowDown");
  expect(document.activeElement).toBe(view.items[0]);
  key(document.activeElement ?? window, "End");
  expect(document.activeElement).toBe(view.items[1]);
  key(document.activeElement ?? window, "Home");
  expect(document.activeElement).toBe(view.items[0]);
  expect(key(document.activeElement ?? window, "Escape").defaultPrevented).toBe(true);
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(view.opener);
});

it("dismisses on Tab without preventing native focus traversal", async () => {
  const view = await render();
  expect(key(document.activeElement ?? window, "Tab").defaultPrevented).toBe(false);
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
});

it("ignores internal pointer presses and dismisses an outside press", async () => {
  const view = await render();
  view.items[0]?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(view.ondismiss).not.toHaveBeenCalled();
  view.target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
});

it("restores opener focus and dismisses after an existing action", async () => {
  const view = await render();
  view.items[0]?.click();
  expect(view.onopenmain).toHaveBeenCalledTimes(1);
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(view.opener);
});

it("dismisses when the original non-menu control is clicked", async () => {
  const view = await render();
  view.opener.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
});

it("removes live pointer and keyboard listeners when unmounted", async () => {
  const view = await render();
  key(window, "Escape");
  window.dispatchEvent(new MouseEvent("pointerdown"));
  expect(view.ondismiss).toHaveBeenCalledTimes(2);
  await unmount(view.app); apps.splice(apps.indexOf(view.app), 1);
  view.ondismiss.mockClear();
  key(window, "Escape");
  window.dispatchEvent(new MouseEvent("pointerdown"));
  expect(view.ondismiss).not.toHaveBeenCalled();
});

it("puts checkbox options in the same arrow-key sequence as existing actions", async () => {
  const ontoggle = vi.fn();
  const view = await render({ options: [
    { label: "Show filenames", checked: false, ontoggle },
    { label: "Show completed", checked: true, ontoggle: vi.fn() },
  ] });
  const options = [...view.target.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];
  expect(options.map((item) => [item.textContent?.trim(), item.getAttribute("aria-checked")])).toEqual([
    ["Show filenames", "false"], ["Show completed", "true"],
  ]);
  key(document.activeElement ?? window, "End");
  expect(document.activeElement).toBe(options[1]);
  key(document.activeElement ?? window, "ArrowDown");
  expect(document.activeElement).toBe(view.items[0]);
  key(document.activeElement ?? window, "End");
  key(document.activeElement ?? window, "ArrowUp");
  expect(document.activeElement).toBe(options[0]);
  options[0]?.click();
  expect(ontoggle).toHaveBeenCalledTimes(1);
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(view.opener);
});

it.each([false, true])("labels the optional bookmark action from its current state (%s)", async (bookmarked) => {
  const onbookmark = vi.fn();
  const view = await render({ onbookmark, bookmarked });
  const item = [...view.target.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent === (bookmarked ? "Remove bookmark" : "Add bookmark"));
  expect(item).toBeDefined();
  item?.click();
  expect(onbookmark).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(view.opener);
});

it("restores focus before an existing action opens its own focus destination", async () => {
  const destination = document.createElement("button"); document.body.append(destination);
  const view = await render({ onopenmain: () => destination.focus() });
  view.items[0]?.click();
  expect(document.activeElement).toBe(destination);
});

it("restores focus after an outside press on an unfocusable surface", async () => {
  const view = await render();
  view.target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  expect(view.ondismiss).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(view.opener);
});

it("keeps the menu within the viewport instead of clipping actions at an edge", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 220, height: 100 } as DOMRect);
  const target = document.createElement("div"); document.body.append(target);
  const app = mount(ContextMenu, { target, props: { open: true, x: window.innerWidth, y: window.innerHeight, onrename: vi.fn(), ondismiss: vi.fn() } });
  apps.push(app); await tick();
  const menu = target.querySelector<HTMLElement>('[role="menu"]');
  expect(menu?.style.left).toBe(`${window.innerWidth - 220}px`);
  expect(menu?.style.top).toBe(`${window.innerHeight - 100}px`);
});
