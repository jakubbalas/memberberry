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

  // A click on the diagram itself does not open its code; only Edit code does.
  await diagram.locator(".mb-mermaid-preview").click();
  await expect(source).toBeHidden();
  await diagram.getByRole("button", { name: "Edit code" }).click();
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
    // The chart's one phase is the first, whose colour is --series-2 (SPEC §13.2).
    return {
      done: [stroke("rect.task[class*=done]"), token("--series-2")],
      active: [stroke("rect.task[class*=active]"), token("--series-2")],
    };
  });
  expect(colours.done[0], "a done task is outlined in its phase's colour").toBe(colours.done[1]);
  expect(colours.active[0], "an active task is outlined in its phase's colour").toBe(colours.active[1]);
  await page.screenshot({ path: info.outputPath("gantt-dark.png") });
});

test("Done hides the code of a diagram that ends the note", async ({ page }, info) => {
  const path = `Diagram last ${info.project.name} ${randomUUID()}.md`;
  await openNote(page, path, `# Plan\n\nBefore\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  const source = diagram.locator(".mb-mermaid-source");
  await diagram.getByRole("button", { name: "Edit code" }).click();
  await expect(source).toBeVisible();
  await diagram.getByRole("button", { name: "Done" }).click();
  await expect(source).toBeHidden();
  await expect(diagram.getByRole("button", { name: "Edit code" })).toBeVisible();
});

test("a note whose first line is a diagram opens with the code hidden", async ({ page }, info) => {
  for (const [label, content] of [
    ["title", `# Plan\n\n\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`],
    ["first", `\`\`\`mermaid\n${GANTT}\n\`\`\`\n\nAfter\n`],
  ] as const) {
    const path = `Diagram opens ${label} ${info.project.name} ${randomUUID()}.md`;
    if (label === "title") await signIn(page);
    expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } })).ok()).toBe(true);
    await page.goto(`/v/personal/${encodeURIComponent(path)}`);
    const diagram = page.locator(`${EDITOR} .mb-mermaid`);
    await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
    await expect(diagram.locator(".mb-mermaid-source"), `${label}: code hidden on open`).toBeHidden();
    await expect(diagram.getByRole("button", { name: "Edit code" })).toBeVisible();
  }
});

test("a Gantt chart's phase names and date labels never collide", async ({ page }, info) => {
  const path = `Gantt layout ${info.project.name} ${randomUUID()}.md`;
  const chart = [
    "gantt", "    dateFormat YYYY-MM-DD",
    "    section Discovery & research", "    Interviews :iv, 2026-11-02, 5d",
    "    section Engineering build", "    Backend API :be, after iv, 30d",
  ].join("\n");
  await openNote(page, path, `# Plan\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\nAfter\n`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  const layout = await diagram.locator(".mb-mermaid-preview svg").evaluate((svg) => {
    const box = (node: Element) => node.getBoundingClientRect();
    const labels = [...svg.querySelectorAll<SVGTextElement>(".grid .tick text")].filter((label) => getComputedStyle(label).display !== "none").map(box);
    const overlaps = labels.slice(1).filter((label, index) => label.left < (labels[index]?.right ?? 0)).length;
    const names = [...svg.querySelectorAll(".sectionTitle")].map(box);
    const bars = [...svg.querySelectorAll("rect.task")].map(box);
    const nameRight = Math.max(...names.map((name) => name.right));
    const barLeft = Math.min(...bars.map((bar) => bar.left));
    return { shown: labels.length, overlaps, clear: nameRight <= barLeft };
  });
  expect(layout.overlaps, "visible date labels overlap").toBe(0);
  expect(layout.shown).toBeGreaterThan(2);
  expect(layout.clear, "phase names stay left of every bar").toBe(true);
  const phases = await diagram.locator(".mb-mermaid-preview svg").evaluate((svg) => ({
    stripes: svg.querySelectorAll(".mb-phase-stripe").length,
    dividers: svg.querySelectorAll(".mb-phase-divider").length,
    names: new Set([...svg.querySelectorAll(".sectionTitle")].map((name) => getComputedStyle(name).fill)).size,
  }));
  expect(phases, "each phase has a stripe and its own name colour, and a line where it starts").toEqual({ stripes: 2, dividers: 1, names: 2 });
});

test("a Gantt chart shortens names that do not fit and shows them in full on hover or tap", async ({ page }, info) => {
  const path = `Gantt long names ${info.project.name} ${randomUUID()}.md`;
  const long = "Wireframes for every landing page and the onboarding emails";
  const chart = [
    "gantt", "    dateFormat YYYY-MM-DD",
    "    section Discovery, research and stakeholder interviews", `    ${long} :wf, 2026-11-02, 6d`,
    "    section Build", "    API :api, after wf, 12d",
  ].join("\n");
  await openNote(page, path, `# Plan\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\nAfter\n`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  const svg = diagram.locator(".mb-mermaid-preview svg");
  const label = svg.locator('text[id$="-wf-text"]');
  await expect(label).toHaveText(/…$/u);
  const fit = await svg.evaluate((root) => {
    const chartRight = root.getBoundingClientRect().right;
    const bar = root.querySelector('rect[id$="-wf"]')?.getBoundingClientRect();
    const text = root.querySelector('text[id$="-wf-text"]')?.getBoundingClientRect();
    const titles = [...root.querySelectorAll(".sectionTitle")].map((node) => node.getBoundingClientRect().right);
    const firstBar = Math.min(...[...root.querySelectorAll("rect.task")].map((node) => node.getBoundingClientRect().left));
    return { insideBar: bar !== undefined && text !== undefined && text.left >= bar.left && text.right <= bar.right, inChart: (text?.right ?? Infinity) <= chartRight, namesClear: titles.every((right) => right <= firstBar) };
  });
  expect(fit, "the shortened name sits inside its bar and the phase name stays left of the bars").toEqual({ insideBar: true, inChart: true, namesClear: true });
  const tip = diagram.getByRole("tooltip");
  if (info.project.name === "mobile") await label.tap();
  else await label.hover();
  await expect(tip).toHaveText(long);
  await page.screenshot({ path: info.outputPath("gantt-long-names.png") });
});

test("a long Gantt chart can be capped in height, zoomed and dragged around", async ({ page }, info) => {
  const path = `Gantt viewer ${info.project.name} ${randomUUID()}.md`;
  const tasks = Array.from({ length: 30 }, (_, index) => `    Task ${String(index + 1)} :t${String(index)}, ${index === 0 ? "2026-11-02" : `after t${String(index - 1)}`}, 3d`);
  const chart = ["gantt", "    dateFormat YYYY-MM-DD", "    %% option max-height medium", "    section Work", ...tasks].join("\n");
  await openNote(page, path, `# Plan\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\nAfter\n`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await expect(diagram).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  const preview = diagram.locator(".mb-mermaid-preview");
  const svg = preview.locator("svg");
  const size = () => preview.evaluate((node) => ({ box: Math.round(node.getBoundingClientRect().height), content: node.scrollHeight, width: Math.round(node.querySelector("svg")?.getBoundingClientRect().width ?? 0) }));
  const capped = await size();
  expect(capped.box, "the chart stops at its cap and scrolls").toBeLessThanOrEqual(30 * 16 + 2);
  expect(capped.content).toBeGreaterThan(capped.box);

  // The dates sit at the top of the box, over the dates of the axis below, and stay there.
  const dates = preview.locator(".mb-chart-dates");
  const header = () => preview.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const strip = node.querySelector(".mb-chart-dates");
    const shown = [...(strip?.querySelectorAll("span") ?? [])].map((span) => ({ text: span.textContent, x: Math.round(span.getBoundingClientRect().left + span.getBoundingClientRect().width / 2) }));
    const axis = [...node.querySelectorAll(".grid .tick text")].filter((text) => getComputedStyle(text).display !== "none").map((text) => ({ text: text.textContent.trim(), x: Math.round(text.getBoundingClientRect().left + text.getBoundingClientRect().width / 2) }));
    return { offset: Math.round((strip?.getBoundingClientRect().top ?? -999) - box.top), shown, axis };
  });
  await expect(dates).toBeVisible();
  const top = await header();
  expect(top.shown.length, "the header shows dates").toBeGreaterThan(1);
  expect(top.shown.map((label) => label.text), "the same dates as the axis").toEqual(top.axis.map((label) => label.text));
  expect(top.shown.every((label, index) => Math.abs(label.x - (top.axis[index]?.x ?? Infinity)) <= 2), "each date over its axis date").toBe(true);
  await preview.evaluate((node) => { node.scrollTop = 200; });
  expect(Math.abs((await header()).offset), "the header stays at the top of the box, with no gap above it").toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("gantt-viewer-dates.png") });
  await preview.evaluate((node) => { node.scrollTop = 0; });

  const zoom = diagram.getByRole("group", { name: "Chart zoom" });
  await zoom.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom.getByRole("button", { name: "Reset zoom" })).toHaveText("125%");
  expect((await size()).width).toBeGreaterThan(capped.width);
  await page.screenshot({ path: info.outputPath("gantt-viewer-zoomed.png") });

  if (info.project.name === "desktop") {
    const box = await preview.boundingBox();
    if (box === null) throw new Error("no preview");
    const before = await preview.evaluate((node) => [node.scrollLeft, node.scrollTop]);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 80, { steps: 6 });
    await page.mouse.up();
    const after = await preview.evaluate((node) => [node.scrollLeft, node.scrollTop]);
    expect(after[0], "dragging left scrolls right").toBeGreaterThan(before[0] ?? 0);
    expect(after[1], "dragging up scrolls down").toBeGreaterThan(before[1] ?? 0);
  }

  await zoom.getByRole("button", { name: "Fit to width" }).click();
  const fitted = await preview.evaluate((node) => ({ inner: node.clientWidth, svg: node.querySelector("svg")?.getBoundingClientRect().width ?? 0 }));
  expect(fitted.svg).toBeLessThanOrEqual(fitted.inner);
  await zoom.getByRole("button", { name: "Reset zoom" }).click();
  await expect(svg).toHaveCSS("width", `${String(capped.width)}px`);
  await page.screenshot({ path: info.outputPath("gantt-viewer.png") });
});
