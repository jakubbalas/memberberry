// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emojiCatalog } from "../emoji-catalog.js";
import NamePrompt from "./NamePrompt.svelte";

vi.mock("../emoji-catalog.js", () => ({ emojiCatalog: vi.fn(async () => [
  { shortcode: "tada", glyph: "🎉", aliases: ["party"], category: "activities", supportsSkinTone: false },
  { shortcode: "wave", glyph: "👋", aliases: [], category: "people", supportsSkinTone: true },
]) }));
const apps: ReturnType<typeof mount>[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(async () => { for (const app of apps.splice(0)) await unmount(app); document.body.replaceChildren(); });
async function render(emoji = true) {
  const onsubmit = vi.fn(), ondismiss = vi.fn(), target = document.createElement("div");
  document.body.append(target);
  apps.push(mount(NamePrompt, { target, props: { open: true, title: "New note", subject: "Root", label: "Name", initial: "", onsubmit, ondismiss, emoji } }));
  await tick();
  const input = target.querySelector("input");
  if (input === null) throw new Error("Missing name field");
  return { target, input, onsubmit, ondismiss };
}
async function type(input: HTMLInputElement, value: string, caret = value.length) {
  input.value = value; input.setSelectionRange(caret, caret); input.dispatchEvent(new Event("input", { bubbles: true })); await tick();
}
it("opens suggestions on the first colon and inserts a glyph before submitting", async () => {
  const view = await render(); await type(view.input, ":");
  await vi.waitFor(() => expect(view.target.querySelectorAll('[role="option"]')).toHaveLength(2));
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  view.input.dispatchEvent(enter); await tick();
  expect(enter.defaultPrevented).toBe(true); expect(view.input.value).toBe("🎉"); expect(view.onsubmit).not.toHaveBeenCalled();
  view.target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(view.onsubmit).toHaveBeenCalledWith("🎉");
});
it("replaces the query at the caret while preserving nested paths and following text", async () => {
  const view = await render(); await type(view.input, "Projects/:wa draft", 12);
  await vi.waitFor(() => expect(view.target.querySelector('[role="option"]')?.textContent).toContain(":wave:"));
  view.target.querySelector<HTMLButtonElement>('[role="option"]')?.click(); await tick();
  expect(view.input.value).toBe("Projects/👋 draft"); expect(document.activeElement).toBe(view.input);
});
it("arrows change selection and Escape closes suggestions before the dialog", async () => {
  const view = await render(); await type(view.input, ":");
  await vi.waitFor(() => expect(view.target.querySelectorAll('[role="option"]')).toHaveLength(2));
  view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); await tick();
  expect(view.target.querySelector('[aria-selected="true"]')?.textContent).toContain(":wave:");
  view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await tick();
  expect(view.target.querySelector('[role="listbox"]')).toBeNull(); expect(view.ondismiss).not.toHaveBeenCalled();
});
it("does not suggest in destructive exact-name confirmations", async () => {
  const view = await render(false); await type(view.input, ":");
  expect(view.target.querySelector('[role="listbox"]')).toBeNull();
});

it("keeps naming usable after catalog failure and retries on another query", async () => {
  vi.mocked(emojiCatalog).mockRejectedValueOnce(new Error("catalog unavailable"));
  const view = await render(); await type(view.input, ":ta");
  await tick();
  expect(view.target.querySelector('[role="listbox"]')).toBeNull();
  await type(view.input, "Plain 日本 😀");
  view.target.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(view.onsubmit).toHaveBeenCalledWith("Plain 日本 😀");
  await type(view.input, ":party");
  await vi.waitFor(() => expect(view.target.querySelector('[role="option"]')?.textContent).toContain("🎉"));
});
it("does not publish a catalog result after the dialog is destroyed", async () => {
  let resolve: (value: Awaited<ReturnType<typeof emojiCatalog>>) => void = () => { throw new Error("missing resolver"); };
  vi.mocked(emojiCatalog).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = await render(); await type(view.input, ":");
  for (const app of apps.splice(0)) await unmount(app);
  resolve([{ shortcode: "tada", glyph: "🎉", aliases: [], category: "activities", supportsSkinTone: false }]);
  await tick();
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});
