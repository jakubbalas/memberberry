/** Mermaid diagrams render from an ordinary ```mermaid fence (SPEC §13.2, A38). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const GANTT = [
  "gantt",
  "    title Website relaunch",
  "    dateFormat YYYY-MM-DD",
  "    section Design",
  "    Wireframes :done, wf, 2026-11-02, 5d",
  "    Visual design :active, vd, after wf, 8d",
].join("\n");

async function openNote(page: import("@playwright/test").Page, path: string, content: string) {
  await signIn(page);
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  return () => readFileSync(join(E2E_VAULT, path), "utf8");
}

test("a Gantt chart renders, edits as text, and the file stays plain Markdown", async ({ page }, info) => {
  const server = new URL(info.project.use.baseURL ?? "http://127.0.0.1:9012").origin;
  const offsite: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== server) offsite.push(request.url());
  });
  const path = `Gantt ${info.project.name} ${randomUUID()}.md`;
  const initial = `# Plan\n\nBefore\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`;
  const disk = await openNote(page, path, initial);
  const editor = page.locator(EDITOR);
  const diagram = editor.locator(".mb-mermaid");
  const source = diagram.locator(".mb-mermaid-source");

  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  await expect(diagram.locator(".mb-mermaid-preview svg")).toContainText("Wireframes");
  await expect(source).toBeHidden();
  await page.screenshot({ path: info.outputPath("gantt-rendered.png") });

  await diagram.getByRole("button", { name: "Edit source" }).click();
  await expect(source).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("    Build :b, after vd, 4d");
  await expect(diagram.locator(".mb-mermaid-preview svg")).toContainText("Build", { timeout: 20_000 });
  await expect.poll(disk, { timeout: 15_000 }).toContain("    Build :b, after vd, 4d\n```");
  await page.screenshot({ path: info.outputPath("gantt-editing.png") });

  await diagram.getByRole("button", { name: "Done" }).click();
  await expect(source).toBeHidden();
  expect(disk()).toBe(`# Plan\n\nBefore\n\n\`\`\`mermaid\n${GANTT}\n    Build :b, after vd, 4d\n\`\`\`\n\nAfter\n`);
  expect(offsite, "rendering fetches nothing from outside the server (C1)").toEqual([]);
});

test("the arrow keys reach a hidden diagram's source", async ({ page }, info) => {
  const path = `Gantt keys ${info.project.name} ${randomUUID()}.md`;
  await openNote(page, path, `# Plan\n\nBefore\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`);
  const editor = page.locator(EDITOR);
  const diagram = editor.locator(".mb-mermaid");
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });

  await editor.getByText("Before", { exact: true }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await expect(diagram.locator(".mb-mermaid-source")).toBeVisible();

  await editor.getByText("After", { exact: true }).click();
  await expect(diagram.locator(".mb-mermaid-source")).toBeHidden();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await expect(diagram.locator(".mb-mermaid-source")).toBeVisible();
});

test("a diagram with a syntax error shows the message and its source", async ({ page }, info) => {
  const path = `Broken diagram ${info.project.name} ${randomUUID()}.md`;
  await openNote(page, path, "# Plan\n\n```mermaid\ngantt\n    dateFormat YYYY-MM-DD\n    Oops :\n```\n");
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "error", { timeout: 20_000 });
  await expect(diagram.locator(".mb-mermaid-error")).not.toBeEmpty();
  await expect(diagram.locator(".mb-mermaid-source")).toBeVisible();
  await page.screenshot({ path: info.outputPath("gantt-error.png") });
});

test("a Gantt chart takes its colours from the theme's tokens in dark mode", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const path = `Gantt dark ${info.project.name} ${randomUUID()}.md`;
  await openNote(page, path, `# Plan\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  const colours = await diagram.evaluate((element) => {
    const token = (name: string) => {
      const probe = element.ownerDocument.createElement("span");
      probe.style.color = `var(${name})`;
      element.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const stroke = (selector: string) => {
      const rect = element.querySelector(`.mb-mermaid-preview svg ${selector}`);
      return rect === null ? "missing" : getComputedStyle(rect).stroke;
    };
    return {
      done: [stroke("rect.task[class*=done]"), token("--text-muted")],
      active: [stroke("rect.task[class*=active]"), token("--accent-primary")],
    };
  });
  expect(colours.done[0], "a done task is drawn in --text-muted").toBe(colours.done[1]);
  expect(colours.active[0], "an active task is drawn in --accent-primary").toBe(colours.active[1]);
  await page.screenshot({ path: info.outputPath("gantt-dark.png") });
});
