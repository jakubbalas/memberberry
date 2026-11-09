/** The visual Gantt editor edits the Mermaid text in the note, and nothing else (SPEC §13.3, A39). */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { E2E_VAULT } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const CHART = [
  "gantt",
  "    title Website relaunch",
  "    dateFormat YYYY-MM-DD",
  "    section Design",
  "    Wireframes :done, wf, 2026-11-02, 5d",
  "    Visual design :vd, after wf, 8d",
  "    section Build",
  "    Frontend :fe, after vd, 10d",
].join("\n");

async function openChart(page: Page, name: string, chart = CHART): Promise<() => string> {
  await signIn(page);
  const path = `${name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: `# Plan\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\nAfter\n` } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  await expect(page.locator(`${EDITOR} .mb-mermaid`)).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
  return () => readFileSync(join(E2E_VAULT, path), "utf8");
}

test("Edit chart opens the visual editor on the note's chart", async ({ page }, info) => {
  await openChart(page, `Gantt editor ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Chart title" })).toHaveValue("Website relaunch");
  await expect(dialog.getByRole("textbox", { name: "Name of Visual design" })).toHaveValue("Visual design");
  await page.screenshot({ path: info.outputPath("gantt-editor-table.png") });
  if (info.project.name === "mobile") await dialog.getByRole("tab", { name: "Timeline" }).click();
  await expect(dialog.locator(".ge-bar")).toHaveCount(3);
  await page.screenshot({ path: info.outputPath("gantt-editor-timeline.png") });
});

test("dragging a bar moves the task and Save writes the Markdown", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt drag ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await dialog.getByRole("button", { name: "Days", exact: true }).click();
  if (info.project.name === "mobile") await dialog.getByRole("tab", { name: "Timeline" }).click();
  const bar = dialog.locator(".ge-bar").filter({ hasText: "Wireframes" }).locator(".ge-shape");
  const box = await bar.boundingBox();
  if (box === null) throw new Error("no bar");
  // Days zoom is 36px a day: two days to the right.
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 56, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + 92, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(dialog.getByRole("status")).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    Wireframes :done, wf, 2026-11-04, 5d\n    Visual design :vd, after wf, 8d\n");
});

test("the Insert menu's Gantt chart opens the editor on a starter chart and saves it", async ({ page }, info) => {
  await signIn(page);
  const path = `Gantt insert ${info.project.name} ${randomUUID()}.md`;
  expect((await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content: "# Title\n\nBody\n" } })).ok()).toBe(true);
  await page.goto(`/v/personal/${encodeURIComponent(path)}`);
  const editor = page.locator(EDITOR);
  await editor.getByText("Body", { exact: true }).click();
  await page.getByRole("button", { name: "Insert block", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Block menu", exact: true });
  await menu.getByRole("searchbox", { name: "Filter blocks" }).fill("gantt");
  await menu.getByRole("menuitem", { name: "Gantt chart", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Name of First task" }).fill("Kick-off");
  await dialog.getByRole("textbox", { name: "Name of First task" }).press("Tab");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const disk = () => readFileSync(join(E2E_VAULT, path), "utf8");
  await expect.poll(disk, { timeout: 15_000 }).toMatch(/```mermaid\ngantt\n {4}title New plan\n {4}dateFormat YYYY-MM-DD\n {4}section Phase 1\n {4}Kick-off :first, \d{4}-\d{2}-\d{2}, 5d\n {4}Second task :after first, 3d\n```/u);
});

test("dragging from a bar's connector to another bar makes it start after it", async ({ page }, info) => {
  const chart = "gantt\n    dateFormat YYYY-MM-DD\n    Design :2026-11-02, 3d\n    Build :2026-11-02, 4d";
  const disk = await openChart(page, `Gantt link ${info.project.name}`, chart);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  if (info.project.name === "mobile") await dialog.getByRole("tab", { name: "Timeline" }).click();
  const from = await dialog.locator(".ge-bar").filter({ hasText: "Design" }).locator(".ge-link").boundingBox();
  const to = await dialog.locator(".ge-bar").filter({ hasText: "Build" }).locator(".ge-shape").boundingBox();
  if (from === null || to === null) throw new Error("no geometry");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(dialog.getByRole("status")).toHaveText("Build now starts after Design.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    Design :design, 2026-11-02, 3d\n    Build :after design, 4d\n");
});

test("a bar moves with the keyboard, and a touch drag moves it on a phone", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt keys ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await dialog.getByRole("button", { name: "Days", exact: true }).click();
  if (info.project.name === "mobile") await dialog.getByRole("tab", { name: "Timeline" }).click();
  const bar = dialog.getByRole("button", { name: /^Frontend, from / });
  await bar.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(dialog.getByRole("button", { name: /^Frontend, from / })).toBeFocused();
  if (info.project.name === "mobile") {
    const shape = dialog.locator(".ge-bar").filter({ hasText: "Wireframes" }).locator(".ge-shape");
    // The timeline opens scrolled to today, so the bar may be off to the left, as on a phone.
    await shape.scrollIntoViewIfNeeded();
    const box = await shape.boundingBox();
    if (box === null) throw new Error("no bar");
    const session = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + 20, y }] });
      for (const x of [box.x + 40, box.x + 70, box.x + 92]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await session.detach(); }
  } else {
    await dialog.getByRole("button", { name: /^Wireframes, from / }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    Wireframes :done, wf, 2026-11-04, 5d\n    Visual design :vd, after wf, 8d\n    section Build\n    Frontend :fe, after vd, 11d");
});

test("the chart sits above the tasks, and the divider resizes them", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "a phone shows the panes as tabs");
  await openChart(page, `Gantt layout ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  const chart = dialog.locator(".ge-timeline-wrap");
  const tasks = dialog.locator(".ge-table-wrap");
  const [chartBox, tasksBox] = [await chart.boundingBox(), await tasks.boundingBox()];
  if (chartBox === null || tasksBox === null) throw new Error("no panes");
  expect(chartBox.y + chartBox.height).toBeLessThanOrEqual(tasksBox.y);
  await page.screenshot({ path: info.outputPath("gantt-editor-stacked.png") });
  const divider = dialog.getByRole("separator", { name: "Resize chart and tasks" });
  const handle = await divider.boundingBox();
  if (handle === null) throw new Error("no divider");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 120, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await chart.boundingBox())?.height ?? 0).toBeGreaterThan(chartBox.height + 80);
  await dialog.getByRole("button", { name: "Side by side", exact: true }).click();
  const [left, right] = [await tasks.boundingBox(), await chart.boundingBox()];
  expect((left?.x ?? 0) < (right?.x ?? 0)).toBe(true);
  await page.screenshot({ path: info.outputPath("gantt-editor-side.png") });
  // The choice is remembered: put it back for the other tests in this browser.
  await dialog.getByRole("button", { name: "Chart above", exact: true }).click();
});

const PHASES = [
  "gantt",
  "    dateFormat YYYY-MM-DD",
  "    section Design",
  "    Wireframes :wf, 2026-11-02, 5d",
  "    Review :2d",
  "    section Build",
  "    Frontend :fe, 2026-11-20, 4d",
].join("\n");
const MOVED = "    section Design\n    Wireframes :wf, 2026-11-02, 5d\n    section Build\n    Frontend :fe, 2026-11-20, 4d\n    Review :after wf, 2d\n```";

test("a task's grip drags it into another phase in the task list", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt grip ${info.project.name}`, PHASES);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  const grip = dialog.getByRole("button", { name: "Move Review", exact: true });
  const target = dialog.locator("tr.ge-row").filter({ has: page.getByRole("textbox", { name: "Name of Frontend" }) });
  await target.scrollIntoViewIfNeeded();
  const [from, to] = [await grip.boundingBox(), await target.boundingBox()];
  if (from === null || to === null) throw new Error("no geometry");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: start.x, y: to.y + to.height * 0.8 };
  if (info.project.name === "mobile") {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
      for (const t of [0.25, 0.5, 0.75, 1]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: start.y + (end.y - start.y) * t }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await session.detach(); }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect(dialog.getByRole("status")).toHaveText("Moved Review to Build.");
  await page.screenshot({ path: info.outputPath("gantt-moved-phase.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain(MOVED);
});

test("dragging a bar down in the chart moves it into the next phase", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "on a phone a vertical swipe scrolls; the task list's grip moves rows there");
  const disk = await openChart(page, `Gantt chart move ${info.project.name}`, PHASES);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  const bar = await dialog.locator(".ge-bar").filter({ hasText: "Review" }).locator(".ge-shape").boundingBox();
  const below = await dialog.locator(".ge-bar").filter({ hasText: "Frontend" }).locator(".ge-shape").boundingBox();
  if (bar === null || below === null) throw new Error("no geometry");
  const x = bar.x + Math.min(10, bar.width / 2);
  await page.mouse.move(x, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, below.y + below.height + 8, { steps: 10 });
  await page.mouse.up();
  await expect(dialog.getByRole("status")).toHaveText("Moved Review to Build.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain(MOVED);
});

test("double-clicking a Gantt chart opens the editor", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt dblclick ${info.project.name}`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  const preview = diagram.locator(".mb-mermaid-preview");
  if (info.project.name === "mobile") {
    // A real double tap, not a mouse double-click dressed as one.
    const box = await preview.boundingBox();
    if (box === null) throw new Error("no chart");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const session = await page.context().newCDPSession(page);
    try {
      for (let tap = 0; tap < 2; tap += 1) {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    } finally { await session.detach(); }
  } else {
    await preview.dblclick();
  }
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await expect(dialog).toBeVisible();
  await expect(diagram.locator(".mb-mermaid-source")).toBeHidden();
  await dialog.getByRole("textbox", { name: "Chart title" }).fill("Relaunch plan");
  await dialog.getByRole("textbox", { name: "Chart title" }).press("Tab");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    title Relaunch plan\n");
});

test("a task colour set in the editor is saved and colours the chart in the note", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt colour ${info.project.name}`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await diagram.getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await dialog.getByRole("combobox", { name: "Colour of Visual design" }).selectOption("green");
  await expect(dialog.locator(".ge-bar").filter({ hasText: "Visual design" }).locator(".ge-shape")).toHaveCSS("stroke", /rgb/);
  await page.screenshot({ path: info.outputPath("gantt-colour-editor.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    %% color vd green\n");
  // The note's own chart is Mermaid's render; its bar for `vd` carries the colour.
  const bar = diagram.locator('.mb-mermaid-preview svg rect[id$="-vd"]');
  await expect(bar).toHaveAttribute("style", /fill: var\(--note-background-green\)/u, { timeout: 20_000 });
  const [colour, plain] = await Promise.all([
    bar.evaluate((node) => getComputedStyle(node).fill),
    diagram.locator('.mb-mermaid-preview svg rect[id$="-fe"]').evaluate((node) => getComputedStyle(node).fill),
  ]);
  expect(colour).not.toBe(plain);
  await page.screenshot({ path: info.outputPath("gantt-colour-note.png") });
});

test("a custom task colour is saved as hex", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt custom colour ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  // Chrome's colour dialog cannot be driven from a test; choosing Custom… then setting the
  // picker is the same change the dialog makes.
  await dialog.getByRole("combobox", { name: "Colour of Frontend" }).selectOption("custom");
  await dialog.getByLabel("Custom colour of Frontend").fill("#3a7bd5");
  await expect(dialog.getByRole("combobox", { name: "Colour of Frontend" })).toHaveValue("custom");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    %% color fe #3a7bd5\n");
});

test("a task's end can be given in hours, and Mermaid draws it", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt hours ${info.project.name}`);
  await page.locator(`${EDITOR} .mb-mermaid`).getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await expect(dialog.getByRole("button", { name: /^Critical/ })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "How Wireframes ends" }).selectOption("hours");
  await dialog.getByRole("spinbutton", { name: "Length of Wireframes in hours" }).fill("36");
  await dialog.getByRole("spinbutton", { name: "Length of Wireframes in hours" }).press("Tab");
  await page.screenshot({ path: info.outputPath("gantt-ends-hours.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    Wireframes :done, wf, 2026-11-02, 36h\n");
  await expect(page.locator(`${EDITOR} .mb-mermaid`)).toHaveAttribute("data-mermaid-state", "ready", { timeout: 20_000 });
});

test("a phase colour set in the editor colours that phase in the note", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt phase colour ${info.project.name}`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await diagram.getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await expect(dialog.getByRole("combobox", { name: "Colour of phase Build" })).toHaveValue("");
  await dialog.getByRole("combobox", { name: "Colour of phase Build" }).selectOption("green");
  await page.screenshot({ path: info.outputPath("gantt-phase-colour-editor.png") });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    %% section-color green Build\n");
  const svg = diagram.locator(".mb-mermaid-preview svg");
  await expect(svg.locator(".mb-phase-stripe").nth(1)).toHaveAttribute("style", /fill: var\(--note-color-green\)/u, { timeout: 20_000 });
  const colours = await svg.evaluate((root) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--note-color-green)";
    document.body.append(probe);
    const green = getComputedStyle(probe).color;
    probe.remove();
    const title = (name: string) => [...root.querySelectorAll(".sectionTitle")].find((node) => node.textContent === name);
    const build = title("Build");
    const design = title("Design");
    const frontend = root.querySelector('rect[id$="-fe"]');
    return {
      green,
      build: build === undefined ? "missing" : getComputedStyle(build).fill,
      design: design === undefined ? "missing" : getComputedStyle(design).fill,
      frontend: frontend === null ? "missing" : getComputedStyle(frontend).stroke,
    };
  });
  expect([colours.build, colours.frontend]).toEqual([colours.green, colours.green]);
  expect(colours.design, "the other phase keeps its automatic colour").not.toBe(colours.green);
  await page.screenshot({ path: info.outputPath("gantt-phase-colour-note.png") });
});

test("chart style set in the editor lays the note's chart out with phase rows", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt chart style ${info.project.name}`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  const svg = diagram.locator(".mb-mermaid-preview svg");
  const before = Number(await svg.getAttribute("height"));
  await diagram.getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  await page.screenshot({ path: info.outputPath("gantt-style-toolbar.png") });
  await dialog.getByRole("button", { name: "Style", exact: true }).click();
  const style = dialog.getByRole("group", { name: "Chart style" });
  await style.getByRole("group", { name: "Phase names" }).getByRole("button", { name: "Rows" }).click();
  await style.getByRole("group", { name: "Phase colour" }).getByRole("button", { name: "Name only" }).click();
  await style.getByRole("group", { name: "Row height" }).getByRole("button", { name: "Tall" }).click();
  await page.screenshot({ path: info.outputPath("gantt-style-editor.png") });
  await page.keyboard.press("Escape");
  await expect(style, "Escape closes the style panel, not the editor").toBeHidden();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toContain("    %% option phases row\n");
  await expect(svg.locator(".mb-phase-name")).toHaveCount(2, { timeout: 20_000 });
  const layout = await svg.evaluate((root) => {
    const box = (node: Element | null) => node?.getBoundingClientRect() ?? new DOMRect();
    const headers = [...root.querySelectorAll(".mb-phase-name")].map(box);
    const titles = [...root.querySelectorAll(".sectionTitle")].map(box);
    const bars = [...root.querySelectorAll("rect.task")].map(box);
    const inside = (inner: DOMRect, outer: DOMRect) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    return {
      namesInHeaders: titles.every((title, index) => { const header = headers[index]; return header !== undefined && inside(title, header); }),
      barsClearHeaders: bars.every((bar) => headers.every((header) => bar.bottom <= header.top + 1 || bar.top >= header.bottom - 1)),
      height: Number(root.getAttribute("height")),
    };
  });
  expect([layout.namesInHeaders, layout.barsClearHeaders], "names sit in their header rows, clear of every bar").toEqual([true, true]);
  expect(layout.height, "header rows and tall rows make the chart taller").toBeGreaterThan(before);
  await page.screenshot({ path: info.outputPath("gantt-style-note.png") });
});

test("the thin row at the end of a phase adds a task to that phase", async ({ page }, info) => {
  const disk = await openChart(page, `Gantt add row ${info.project.name}`);
  const diagram = page.locator(`${EDITOR} .mb-mermaid`);
  await diagram.getByRole("button", { name: "Edit chart" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit Gantt chart" });
  const add = dialog.getByRole("button", { name: "Add a task to Design" });
  if (info.project.name === "desktop") {
    const rows = await dialog.locator(".ge-table tbody tr").evaluateAll((nodes) => nodes.map((node) => [node.className, Math.round(node.getBoundingClientRect().height)]));
    expect(rows.find(([name]) => name === "ge-add-row")?.[1], "the add row is thinner than a task row").toBeLessThan(40);
  }
  await page.screenshot({ path: info.outputPath("gantt-add-row.png") });
  await add.click();
  await expect(dialog.getByRole("textbox", { name: "Name of New task" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Copy review");
  await page.keyboard.press("Tab");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(disk, { timeout: 15_000 }).toMatch(/ {4}Visual design :vd, after wf, 8d\n {4}Copy review :2026-11-15, 5d\n {4}section Build/u);
});
