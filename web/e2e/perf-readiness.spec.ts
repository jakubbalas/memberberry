import { expect, signIn, test } from "./fixtures.js";

import { timeSwitch, timeToEditor } from "../perf/measure.ts";

test("cold-start failure identifies the hidden editor gate and connection status", async ({ page }) => {
  test.setTimeout(45_000);
  await page.route("**/perf-blocked", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<style>[data-body="waiting"] { visibility: hidden; }</style>
      <section class="editor-panel" data-body="waiting">
        <div class="editor-surface"><div class="tiptap" contenteditable="true">Note</div></div>
      </section><p class="offline-status" role="status">Offline — reconnecting</p>`,
  }));
  await expect(timeToEditor(page, "/perf-blocked")).rejects.toThrow(/body.*waiting.*Offline — reconnecting/s);
});

test("a stalled custom emoji request does not block the note editor", async ({ page }) => {
  let requests = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/vaults/personal/emoji", async (route) => {
    requests += 1;
    await gate;
    await route.fulfill({ json: [] });
  });
  try {
    await signIn(page);
    await page.goto("/v/personal/Welcome.md");
    await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
    expect(requests).toBe(0);
    await page.getByRole("button", { name: "Insert emoji", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Emoji picker" })).toBeVisible();
    await expect.poll(() => requests).toBe(1);
    await expect(page.locator(".editor-surface .tiptap")).toBeEditable();
    await expect(page.getByText("Loading emoji…", { exact: true })).toBeVisible();
    release();
    await expect(page.locator(".emoji-picker-item").first()).toBeVisible();
  } finally {
    release();
  }
});

test("note timing waits for the editor to become visible after its text arrives", async ({ page }) => {
  await page.setContent(`
    <style>[data-editor="loading"] .editor-surface { visibility: hidden; }</style>
    <button>Switch note</button>
    <section class="editor-panel">
      <div class="editor-surface"><div class="tiptap" contenteditable="true">Old note</div></div>
    </section>
  `);
  await page.evaluate(() => {
    document.querySelector("button")?.addEventListener("click", () => {
      const panel = document.querySelector("section");
      const editor = document.querySelector(".tiptap");
      panel?.setAttribute("data-editor", "loading");
      if (editor !== null) editor.textContent = "New note";
    });
  });
  let completed = false;
  const timing = timeSwitch(page, "button", 0, "New note").then((elapsed) => {
    completed = true;
    return elapsed;
  });
  await expect(page.locator(".tiptap")).toHaveText("New note");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
  expect(completed).toBe(false);
  await page.locator("section").evaluate((panel) => panel.removeAttribute("data-editor"));
  expect(await timing).toBeGreaterThan(0);
  await expect(page.locator(".tiptap")).toBeVisible();
});

test("cold-start timing waits for the body to become editable", async ({ page }) => {
  await page.route("**/perf-readiness", (route) => route.fulfill({
    contentType: "text/html",
    body: `<style>[data-body="waiting"] { visibility: hidden; }</style>
      <section data-body="waiting" class="editor-surface">
        <div class="tiptap" contenteditable="true">Note body</div>
      </section>`,
  }));
  let completed = false;
  const timing = timeToEditor(page, "/perf-readiness").then((elapsed) => {
    completed = true;
    return elapsed;
  });
  await expect(page.locator(".tiptap")).toHaveText("Note body");
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
  expect(completed).toBe(false);
  await page.locator("section").evaluate((panel) => panel.removeAttribute("data-body"));
  expect(await timing).toBeGreaterThan(0);
});
