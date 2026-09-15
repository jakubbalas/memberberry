import { expect, test } from "./fixtures.js";

import { timeSwitch, timeToEditor } from "../perf/measure.ts";

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
