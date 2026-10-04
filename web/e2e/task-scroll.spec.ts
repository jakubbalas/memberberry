/** Native scrolling over task controls, plus the inbox intent that used to replay on scroll. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Editor } from "@tiptap/core";
import type { Locator, Page } from "@playwright/test";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function createNote(page: Page, path: string, content: string): Promise<void> {
  const response = await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } });
  expect(response.ok()).toBe(true);
}

async function openTasks(page: Page): Promise<Locator> {
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  await page.getByRole("group", { name: "Navigation views" }).getByRole("button", { name: "Tasks", exact: true }).click();
  const tasks = page.locator("#navigation-tasks .inbox-panel");
  await expect(tasks).toBeVisible();
  return tasks;
}

async function scrollFrom(page: Page, target: Locator, mobile: boolean): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("Missing native scroll start target");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (!mobile) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 220);
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step += 1) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - Math.min(220, y - 80) * step / 8 }] });
      await frames(page);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}

interface Probe {
  readonly boxes: Element[];
  readonly observer: MutationObserver;
  mutations: number;
  changes: number;
  readonly changed: (event: { transaction: { docChanged: boolean } }) => void;
}
type ProbedEditor = HTMLElement & { editor?: Editor; taskScrollProbe?: Probe };

async function observeTasks(page: Page) {
  const original = await page.locator(EDITOR).elementHandle();
  if (original === null) throw new Error("Missing editor to observe");
  await original.evaluate((element) => {
    const root = element as ProbedEditor;
    const probe: Probe = {
      boxes: [...root.querySelectorAll(".task-checkbox")], mutations: 0, changes: 0,
      observer: new MutationObserver((records) => {
        probe.mutations += records.filter((record) => {
          const target = record.target instanceof Element ? record.target : record.target.parentElement;
          return target?.closest(".task-item") !== null;
        }).length;
      }),
      changed: ({ transaction }) => { if (transaction.docChanged) probe.changes += 1; },
    };
    if (root.editor === undefined) throw new Error("Missing real Tiptap editor");
    root.taskScrollProbe = probe;
    probe.observer.observe(root, { subtree: true, attributes: true, characterData: true, childList: true });
    root.editor.on("transaction", probe.changed);
  });
  return async (): Promise<void> => {
    const result = await original.evaluate((element) => {
      const root = element as ProbedEditor;
      const probe = root.taskScrollProbe;
      if (probe === undefined) throw new Error("Missing task probe");
      probe.observer.disconnect();
      root.editor?.off("transaction", probe.changed);
      const current = [...root.querySelectorAll(".task-checkbox")];
      return { connected: root.isConnected, stable: current.length === probe.boxes.length && current.every((box, index) => box === probe.boxes[index]), mutations: probe.mutations, changes: probe.changes };
    });
    expect(result).toEqual({ connected: true, stable: true, mutations: 0, changes: 0 });
    await original.dispose();
  };
}

test("native scrolling over completed checkboxes is mutation-free; deliberate taps, text and keyboard still work", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const path = `Task scroll ${info.project.name} ${randomUUID()}.md`;
  await signIn(page);
  await createNote(page, path, `# Task scroll\n\n${Array.from({ length: 60 }, (_, index) => `- [${index % 2 === 0 ? "x" : " "}] Scroll task ${index} 📅 2026-10-10`).join("\n")}\n`);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const boxes = page.locator(`${EDITOR} .task-checkbox`);
  await expect(boxes).toHaveCount(60);
  const target = boxes.nth(8);
  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await frames(page);
  const pane = page.locator(".note-pane");
  const before = await pane.evaluate((element) => element.scrollTop);
  const statuses = await boxes.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-checked")));
  const unchanged = await observeTasks(page);
  await scrollFrom(page, target, mobile);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 30);
  await frames(page);
  expect(await boxes.evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-checked")))).toEqual(statuses);
  await unchanged();

  await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await frames(page);
  if (mobile) {
    const box = await target.boundingBox();
    if (box === null) throw new Error("Missing cancel target");
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    } finally { await session.detach(); }
    await expect(target).toHaveAttribute("aria-checked", "true");
    await target.tap();
  } else await target.click();
  await expect(target).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => readFileSync(join(E2E_VAULT, path), "utf8"), { timeout: 15_000 }).toContain("- [ ] Scroll task 8");

  // A pointer in task text must select text, not hit the enlarged checkbox pseudo-element.
  const text = page.locator(`${EDITOR} .task-body p`).nth(8);
  if (mobile) await text.tap({ position: { x: 3, y: 8 } });
  else await text.click({ position: { x: 3, y: 8 } });
  await page.keyboard.insertText("Edited ");
  await expect(text).toContainText("Edited");
  await expect(target).toHaveAttribute("aria-checked", "false");
  const complete = page.getByRole("button", { name: "Toggle selected task completion", exact: true });
  await complete.focus();
  await page.keyboard.press("Space");
  await expect(target).toHaveAttribute("aria-checked", "true");
});

test("an inbox toggle survives native scroll and source remount without replaying", async ({ page }, info) => {
  const path = `Inbox scroll ${info.project.name} ${randomUUID()}.md`;
  await signIn(page);
  await createNote(page, path, `# Inbox scroll\n\n- [ ] Keep this completed\n\n${Array.from({ length: 45 }, (_, index) => `Paragraph ${index} makes the source scrollable.`).join("\n\n")}\n`);
  await page.goto("/v/personal/Welcome.md");
  let tasks = await openTasks(page);
  const inboxBox = tasks.locator(`.inbox-task-row[data-path="${path}"]`).getByRole("checkbox");
  if (info.project.name === "mobile") await inboxBox.tap();
  else await inboxBox.click();
  const checkbox = page.locator(`${EDITOR} .task-checkbox`);
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => readFileSync(join(E2E_VAULT, path), "utf8"), { timeout: 15_000 }).toContain("- [x] Keep this completed");
  await frames(page);
  const unchanged = await observeTasks(page);
  const pane = page.locator(".note-pane");
  const before = await pane.evaluate((element) => element.scrollTop);
  await scrollFrom(page, checkbox, info.project.name === "mobile");
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 30);
  await frames(page);
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await unchanged();

  tasks = await openTasks(page);
  await tasks.getByRole("button", { name: "Task options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Open in main panel", exact: true }).click();
  await expect(page.locator(EDITOR)).toHaveCount(0);
  await page.getByRole("button", { name: "Close tasks main panel", exact: true }).click();
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await pane.evaluate((element) => { element.scrollTop += 150; });
  await frames(page);
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  expect(readFileSync(join(E2E_VAULT, path), "utf8")).toContain("- [x] Keep this completed");
});
