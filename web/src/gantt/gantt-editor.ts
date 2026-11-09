/**
 * The visual Gantt editor (SPEC §13.3): a modal with a task table and a drag-and-drop
 * timeline over one Mermaid `gantt` source. The host passes text in and gets text back.
 *
 * Every change goes through the pure edits in `edit.ts`, then the table and timeline are
 * drawn again from the result, so the model is the only state. Task names are untrusted
 * vault text: they are only ever set as `textContent` or an input's value.
 */
import {
  addSection,
  addTask,
  endAt,
  isRefused,
  link,
  moveTask,
  moveTo,
  remove,
  renameLine,
  rows,
  setEnd,
  setEndKind,
  type EndKind,
  setFlag,
  setProgress,
  setStart,
  setColor,
  setOption,
  setSectionColor,
  setTitle,
  stepTarget,
  type Outcome,
} from "./edit.js";
import { formatDay, parseChart, parseDay, schedule, serializeChart, type Chart, type Placed, type Section, type Task } from "./model.js";
import { colorHue, colorStyle, colorText, longHex, NOTE_COLORS, parseColor, PHASE_COLOURS, tint, type ChartOptions, type TaskColor } from "./colors.js";
import { fitText } from "./fit-text.js";
import "./gantt.css";

export interface GanttEditorOptions {
  /** The Mermaid source to edit. */
  readonly source: string;
  /** Where the dialog is attached. */
  readonly host: HTMLElement;
  /** Called with the new source when the user saves a changed chart. */
  readonly onSave: (source: string) => void;
  /** Called once when the dialog closes, saved or not. */
  readonly onClose?: () => void;
  /** The chart's current text in the host, to notice a collaborator's change before saving. */
  readonly current?: () => string;
  /** Offered when the chart cannot be edited visually. */
  readonly onEditAsText?: () => void;
  /** Today as a day number; defaults to the local calendar date. */
  readonly today?: number;
}

export interface GanttEditorHandle {
  /** Closes without saving. */
  close(): void;
}

export type Zoom = "days" | "weeks" | "months";
const PX_PER_DAY: Readonly<Record<Zoom, number>> = { days: 36, weeks: 14, months: 4 };
const ROW = 48;
const HEADER = 40;
/** The thin row closing each phase, which adds a task to it (SPEC §13.3); taller for touch. */
const ADD_ROW = 30;
const ADD_ROW_COARSE = 44;
const NARROW = "(max-width: 767px)";
let editors = 0;

/** Opens the editor as a modal dialog. */
export function openGanttEditor(options: GanttEditorOptions): GanttEditorHandle {
  editors += 1;
  const prefix = `gantt-${editors}`;
  const doc = options.host.ownerDocument;
  const today = options.today ?? localToday();
  const initial = parseChart(options.source);
  let chart: Chart = initial;
  const undo: Chart[] = [];
  const redo: Chart[] = [];
  let zoom: Zoom = fittingZoom(dayRange(schedule(initial, today), today));
  let tab: "table" | "chart" = "table";
  let showSource = false;
  let layout: Layout = readLayout(doc);
  /** The chart pane's share of the stacked layout, in percent. */
  let split = 55;
  let closed = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(props)) node.setAttribute(name, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = <K extends keyof SVGElementTagNameMap>(tag: K, props: Record<string, string | number> = {}): SVGElementTagNameMap[K] => {
    const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(props)) node.setAttribute(name, String(value));
    return node;
  };
  const button = (label: string, onclick: () => void, props: Record<string, string> = {}): HTMLButtonElement => {
    const node = el("button", { type: "button", ...props }, label);
    node.addEventListener("click", onclick);
    return node;
  };

  const dialog = el("dialog", { class: "gantt-editor", "aria-labelledby": `${prefix}-heading` });
  const heading = el("h2", { id: `${prefix}-heading`, class: "ge-heading" }, "Edit Gantt chart");
  const titleInput = el("input", { type: "text", class: "ge-title", "aria-label": "Chart title", placeholder: "Chart title" });
  const zoomGroup = el("div", { class: "ge-zoom ge-segmented", role: "group", "aria-label": "Zoom" });
  const zoomButtons = (["days", "weeks", "months"] as const).map((level) => {
    const node = button(level[0]?.toUpperCase() + level.slice(1), () => { zoom = level; draw(); });
    zoomGroup.append(node);
    return [level, node] as const;
  });
  const undoButton = button("Undo", () => step(undo, redo));
  const redoButton = button("Redo", () => step(redo, undo));
  const addTaskButton = button("Add task", () => {
    const added = addTask(chart, lastRowKey(), today);
    commit(added.chart);
    focusAfterDraw = { key: added.key, field: "name" };
    draw();
  });
  const addSectionButton = button("Add section", () => {
    const added = addSection(chart, lastRowKey());
    commit(added.chart);
    focusAfterDraw = { key: added.key, field: "name" };
    draw();
  });
  const sourceButton = button("View source", () => { showSource = !showSource; draw(); });
  const layoutGroup = el("div", { class: "ge-layout ge-segmented", role: "group", "aria-label": "Layout" });
  const layoutButtons = ([["stacked", "Chart above"], ["side", "Side by side"]] as const).map(([value, label]) => {
    const node = button(label, () => { layout = value; writeLayout(doc, value); draw(); });
    layoutGroup.append(node);
    return [value, node] as const;
  });
  // why: chart-wide style lives in the chart text (SPEC §13.3), unlike the zoom and layout
  // above, which are how this editor shows it. It is set rarely, so it waits behind one button.
  let styleOpen = false;
  const styleButton = button("Style", () => setStyleOpen(!styleOpen), { class: "ge-style-button", "aria-expanded": "false", "aria-controls": `${prefix}-style` });
  const stylePanel = el("div", { class: "ge-style-panel", id: `${prefix}-style`, role: "group", "aria-label": "Chart style" });
  stylePanel.hidden = true;
  const styleChoices = STYLE_CHOICES.map(({ option, label, choices }) => {
    const row = el("div", { class: "ge-style-row" });
    const group = el("div", { class: "ge-segmented", role: "group", "aria-label": label });
    const nodes = choices.map(([value, text]) => {
      const node = button(text, () => apply(setOption(chart, option, value as ChartOptions[typeof option])), { "data-value": value });
      group.append(node);
      return [value, node] as const;
    });
    row.append(el("span", { class: "ge-style-label", "aria-hidden": "true" }, label), group);
    stylePanel.append(row);
    return [option, nodes] as const;
  });
  const styleWrap = el("div", { class: "ge-style-wrap" });
  styleWrap.append(styleButton, stylePanel);
  function setStyleOpen(open: boolean, refocus = false): void {
    styleOpen = open;
    stylePanel.hidden = !open;
    styleButton.setAttribute("aria-expanded", String(open));
    if (refocus) styleButton.focus();
  }
  // why: a click anywhere else closes the panel, as a menu would. The listener is on the
  // dialog, which goes away with it, so it needs no separate teardown.
  dialog.addEventListener("pointerdown", (event) => {
    if (styleOpen && event.target instanceof Node && !styleWrap.contains(event.target)) setStyleOpen(false);
  });

  const history = el("div", { class: "ge-history", role: "group", "aria-label": "History" });
  history.append(undoButton, redoButton);
  const header = el("div", { class: "ge-header" });
  header.append(heading, history);
  const actions = el("div", { class: "ge-actions" });
  actions.append(addTaskButton, addSectionButton, sourceButton);
  const toolbar = el("div", { class: "ge-toolbar" });
  toolbar.append(titleInput, zoomGroup, layoutGroup, styleWrap, actions);

  const tabs = el("div", { class: "ge-tabs", role: "tablist", "aria-label": "View" });
  const tabButtons = (["table", "chart"] as const).map((which) => {
    const node = button(which === "table" ? "Tasks" : "Timeline", () => { tab = which; draw(); }, { role: "tab", id: `${prefix}-tab-${which}`, "aria-controls": `${prefix}-body` });
    tabs.append(node);
    return [which, node] as const;
  });

  const body = el("div", { class: "ge-body", id: `${prefix}-body` });
  const notice = el("p", { class: "ge-notice" });
  const source = el("textarea", { class: "ge-source", readonly: "", "aria-label": "Mermaid source", spellcheck: "false" });
  const status = el("p", { class: "ge-status", role: "status", "aria-live": "polite" });
  const conflict = el("div", { class: "ge-conflict", role: "alert" });
  const footer = el("div", { class: "ge-footer" });
  const cancelButton = button("Cancel", () => requestClose());
  const saveButton = button("Save", () => save(false), { class: "ge-primary" });
  footer.append(cancelButton, saveButton);
  dialog.append(header, toolbar, tabs, notice, body, source, status, conflict, footer);

  let focusAfterDraw: { key: string; field: string } | null = null;

  const say = (message: string): void => { status.textContent = message; };
  const apply = (outcome: Outcome): boolean => {
    if (isRefused(outcome)) { say(outcome.refused); draw(); return false; }
    if (outcome !== chart) commit(outcome);
    draw();
    return true;
  };
  function commit(next: Chart): void {
    undo.push(chart);
    redo.length = 0;
    chart = next;
  }
  function step(from: Chart[], to: Chart[]): void {
    const previous = from.pop();
    if (previous === undefined) return;
    to.push(chart);
    chart = previous;
    say("");
    draw();
  }
  const dirty = (): boolean => serializeChart(chart) !== options.source;
  const lastRowKey = (): string | null => {
    const active = doc.activeElement?.closest<HTMLElement>("[data-key]")?.dataset["key"];
    if (active !== undefined && chart.lines.some((line) => line.key === active)) return active;
    return null;
  };

  titleInput.addEventListener("change", () => apply(setTitle(chart, titleInput.value)));

  function draw(): void {
    const remembered = focusAfterDraw ?? focusedField();
    focusAfterDraw = null;
    const readOnly = chart.readOnly !== null;
    titleInput.value = chart.title ?? "";
    titleInput.disabled = readOnly;
    for (const [level, node] of zoomButtons) node.setAttribute("aria-pressed", String(level === zoom));
    for (const [which, node] of tabButtons) node.setAttribute("aria-selected", String(which === tab));
    undoButton.disabled = undo.length === 0;
    redoButton.disabled = redo.length === 0;
    addTaskButton.disabled = readOnly;
    addSectionButton.disabled = readOnly;
    sourceButton.setAttribute("aria-pressed", String(showSource || readOnly));
    saveButton.disabled = readOnly;
    dialog.dataset["tab"] = tab;
    dialog.dataset["layout"] = layout;
    for (const [value, node] of layoutButtons) node.setAttribute("aria-pressed", String(value === layout));
    styleButton.disabled = readOnly;
    if (readOnly) setStyleOpen(false);
    for (const [option, nodes] of styleChoices) for (const [value, node] of nodes) node.setAttribute("aria-pressed", String(value === chart.options[option]));
    notice.replaceChildren();
    notice.hidden = !readOnly;
    if (readOnly) {
      notice.append(`This chart can only be edited as text: ${chart.readOnly ?? ""}.`);
      if (options.onEditAsText !== undefined) {
        notice.append(" ", button("Edit as text", () => { const edit = options.onEditAsText; finish(); edit?.(); }));
      }
    }
    source.value = serializeChart(chart);
    source.hidden = !(showSource || readOnly);
    body.hidden = readOnly;
    if (!readOnly) drawBody();
    if (remembered !== null) restoreFocus(remembered);
  }

  function focusedField(): { key: string; field: string } | null {
    const active = doc.activeElement;
    if (!(active instanceof Element) || !dialog.contains(active)) return null;
    const holder = active.closest<HTMLElement>("[data-key]");
    const field = active.getAttribute("data-field");
    return holder?.dataset["key"] !== undefined && field !== null ? { key: holder.dataset["key"], field } : null;
  }

  function restoreFocus(target: { key: string; field: string }): void {
    const node = dialog.querySelector<HTMLElement>(`[data-key="${CSS.escape(target.key)}"] [data-field="${CSS.escape(target.field)}"], [data-key="${CSS.escape(target.key)}"][data-field="${CSS.escape(target.field)}"]`);
    node?.focus({ preventScroll: false });
    if (node instanceof HTMLInputElement && target.field === "name") node.select();
  }

  /** Task and section keys in drawing order, so a drop position maps to a row. */
  let rowKeys: string[] = [];
  /** Where each row starts in the timeline, in `rowKeys` order. Rows are not evenly spaced:
   * each phase ends with a thin add-a-task row. */
  let rowTops: number[] = [];

  /** The key a row should be moved in front of, for a drop before or after row `index`. */
  const dropBefore = (index: number, after: boolean): string | null => (after ? rowKeys[index + 1] ?? null : rowKeys[index] ?? null);

  /** The phase a task sits in: the last section line above it. */
  const phaseOf = (source: Chart, key: string): string | null => {
    let phase: string | null = null;
    for (const line of source.lines) {
      if (line.kind === "section") phase = line.name;
      if (line.key === key) return phase;
    }
    return null;
  };

  /** Moves a task to a new row (and so maybe a new phase), as one undo step. */
  function moveRow(taskKey: string, beforeKey: string | null, base: Chart = chart): boolean {
    const name = targetNameOf(taskKey);
    const from = phaseOf(chart, taskKey);
    const outcome = moveTask(base, taskKey, beforeKey, today);
    if (isRefused(outcome)) { say(outcome.refused); draw(); return false; }
    if (outcome !== chart) commit(outcome);
    const to = phaseOf(outcome, taskKey);
    say(to !== from && to !== null ? `Moved ${name} to ${to}.` : `Moved ${name}.`);
    draw();
    return true;
  }

  /** The timeline pane's width at the last draw, so a short chart can fill it. */
  let paneWidth = 0;

  function drawBody(refit = true): void {
    const all = rows(chart, today);
    rowKeys = all.map((row) => row.line.key);
    phaseHues = huesOf(chart);
    const placed = schedule(chart, today);
    const tasks = all.flatMap((row) => (row.line.kind === "task" ? [row.line] : []));
    const natural = dayRange(placed, today);
    // why: a short chart in a wide pane would leave most of it empty; extend the dates instead.
    const range = { start: natural.start, end: Math.max(natural.end, natural.start + Math.ceil(paneWidth / PX_PER_DAY[zoom])) };
    const px = PX_PER_DAY[zoom];
    const width = Math.max(320, (range.end - range.start) * px);
    const view = doc.defaultView;
    const addHeight = view !== null && typeof view.matchMedia === "function" && view.matchMedia("(pointer: coarse)").matches ? ADD_ROW_COARSE : ADD_ROW;
    // why: every group of rows ends with an add row: each phase, and the tasks above the first
    // phase when there are any. The table and the timeline both leave room for it, so their
    // rows still line up side by side.
    const closes = (index: number): boolean => {
      const next = all[index + 1];
      return next === undefined || next.line.kind === "section";
    };
    rowTops = [];
    const addSlots = new Map<number, number>();
    let top = HEADER;
    all.forEach((_row, index) => {
      rowTops.push(top);
      top += ROW;
      if (closes(index)) { addSlots.set(index, top); top += addHeight; }
    });
    const height = top;
    const x = (day: number): number => (day - range.start) * px;

    const table = el("table", { class: "ge-table" });
    const head = el("thead");
    const headRow = el("tr");
    for (const label of ["", "Task", "Start", "Ends", "Starts after", "Colour", "Status", ""]) headRow.append(el("th", { scope: "col" }, label));
    head.append(headRow);
    const tbody = el("tbody");
    let group: Section | null = null;
    all.forEach((row, index) => {
      if (row.line.kind === "section") group = row.line;
      const tr = row.line.kind === "task" ? taskRow(row.line, row.placed, tasks) : sectionRow(row.line);
      tr.toggleAttribute("data-stripe", index % 2 === 1);
      tbody.append(tr);
      if (addSlots.has(index)) tbody.append(addRow(row.line.key, group, addHeight));
    });
    table.append(head, tbody);
    const tableWrap = el("div", { class: "ge-table-wrap", role: "tabpanel", "aria-labelledby": `${prefix}-tab-table` });
    tableWrap.append(table);

    const timeline = svg("svg", { class: "ge-timeline", width, height, viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "Timeline" });
    drawAxis(timeline, range, x, height);
    const todayX = x(today);
    if (today >= range.start && today <= range.end) timeline.append(svg("line", { class: "ge-today", x1: todayX, x2: todayX, y1: HEADER, y2: height }));
    const arrows = svg("g", { class: "ge-arrows" });
    timeline.append(arrows);
    const yOf = new Map<string, number>();
    const whole = chart.options.phaseFill === "whole";
    let phaseHue: string | undefined;
    all.forEach((row, index) => {
      const y = rowTops[index] ?? HEADER;
      if (index % 2 === 1) timeline.append(svg("rect", { class: "ge-stripe", x: 0, y, width, height: ROW }));
      if (row.line.kind === "task" && whole && phaseHue !== undefined) {
        // why: "whole phase" (SPEC §13.3) carries the phase's colour down through its tasks.
        const band = svg("rect", { class: "ge-phase-band ge-phase-body", x: 0, y, width, height: ROW });
        band.style.fill = tint(phaseHue, 6);
        const stripe = svg("rect", { class: "ge-phase-stripe", x: 0, y, width: 4, height: ROW });
        stripe.style.fill = phaseHue;
        timeline.append(band, stripe);
      }
      if (row.line.kind === "section") {
        const found = phaseHues.bySection.get(row.line.key);
        const hue = found === NEUTRAL_HUE ? undefined : found;
        phaseHue = hue;
        if (hue !== undefined) {
          const band = svg("rect", { class: "ge-phase-band", x: 0, y, width, height: ROW });
          band.style.fill = tint(hue, 14);
          if (whole) {
            const stripe = svg("rect", { class: "ge-phase-stripe", x: 0, y, width: 4, height: ROW });
            stripe.style.fill = hue;
            timeline.append(band, stripe);
          } else {
            // why: "name only" colours just the phase's header, outlined in its colour.
            band.classList.add("ge-phase-outline");
            band.style.stroke = hue;
            timeline.append(band);
          }
        }
        const label = svg("text", { class: "ge-section-label", x: 12, y: y + ROW / 2 + 5 });
        label.textContent = row.line.name;
        if (hue !== undefined) label.style.fill = hue;
        timeline.append(label);
        return;
      }
      yOf.set(row.line.key, y);
      if (row.placed !== null) timeline.append(bar(row.line, row.placed, y, x, px));
    });
    // The add rows' room in the timeline keeps a whole-phase colour unbroken to the phase's end.
    for (const [index, slotTop] of addSlots) {
      let ownerKey: string | undefined;
      for (const row of all.slice(0, index + 1)) if (row.line.kind === "section") ownerKey = row.line.key;
      const found = ownerKey === undefined ? undefined : phaseHues.bySection.get(ownerKey);
      if (!whole || found === undefined || found === NEUTRAL_HUE) continue;
      const band = svg("rect", { class: "ge-phase-band ge-phase-body", x: 0, y: slotTop, width, height: addHeight });
      band.style.fill = tint(found, 6);
      const stripe = svg("rect", { class: "ge-phase-stripe", x: 0, y: slotTop, width: 4, height: addHeight });
      stripe.style.fill = found;
      timeline.append(band, stripe);
    }
    for (const task of tasks) {
      const at = placed.get(task.key);
      const ty = yOf.get(task.key);
      if (at === undefined || ty === undefined || task.start.kind !== "after") continue;
      for (const id of task.start.ids) {
        const source = tasks.find((candidate) => candidate.id === id);
        const from = source === undefined ? undefined : placed.get(source.key);
        const sy = source === undefined ? undefined : yOf.get(source.key);
        if (from === undefined || sy === undefined) continue;
        const x1 = x(from.end);
        const x2 = x(at.start);
        const y1 = sy + ROW / 2;
        const y2 = ty + ROW / 2;
        // why: when the next task starts at or before this one's end, a straight elbow would
        // run back over the bar; route through the gap between the rows instead.
        const d = x2 >= x1 + 16
          ? `M${x1},${y1} H${x1 + 8} V${y2} H${x2}`
          : `M${x1},${y1} h8 V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${x2 - 8} V${y2} H${x2}`;
        arrows.append(svg("path", { class: "ge-arrow", d, "marker-end": `url(#${prefix}-arrow)` }));
      }
    }
    const defs = svg("defs");
    const marker = svg("marker", { id: `${prefix}-arrow`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 8, markerHeight: 8, orient: "auto" });
    marker.append(svg("path", { d: "M0,0 L8,4 L0,8 z", class: "ge-arrow-head" }));
    defs.append(marker);
    timeline.prepend(defs);
    const timelineWrap = el("div", { class: "ge-timeline-wrap", role: "tabpanel", "aria-labelledby": `${prefix}-tab-chart` });
    timelineWrap.append(timeline);
    timeline.addEventListener("pointerdown", (event) => panTimeline(event, timeline, timelineWrap));
    // why: redrawing replaces the scrollers; without this every edit jumps back to the start.
    const scrolledLeft = body.querySelector(".ge-timeline-wrap")?.scrollLeft ?? null;
    const scrolledTop = body.scrollTop;
    if (layout === "stacked") body.replaceChildren(timelineWrap, divider(), tableWrap);
    else body.replaceChildren(tableWrap, timelineWrap);
    applySplit();
    const available = timelineWrap.clientWidth;
    // why: one refit only. A scrollbar appearing can change the width again, and chasing it
    // would loop.
    if (refit && available > 0 && Math.abs(available - paneWidth) > 1) {
      paneWidth = available;
      drawBody(false);
    }
    if (scrolledLeft !== null) timelineWrap.scrollLeft = scrolledLeft;
    else if (today >= range.start && today <= range.end) timelineWrap.scrollLeft = Math.max(0, x(today) - 3 * px);
    body.scrollTop = scrolledTop;
  }

  function taskRow(task: Task, placed: Placed | null, tasks: readonly Task[]): HTMLTableRowElement {
    const tr = el("tr", { class: "ge-row", "data-key": task.key });
    if (placed?.error !== null && placed?.error !== undefined) tr.setAttribute("aria-invalid", "true");
    const name = el("input", { type: "text", "data-field": "name", "aria-label": `Name of ${task.name}` });
    name.value = task.name;
    name.addEventListener("change", () => apply(renameLine(chart, task.key, name.value)));
    name.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (name.value !== task.name && !apply(renameLine(chart, task.key, name.value))) return;
      const added = addTask(chart, task.key, today);
      commit(added.chart);
      focusAfterDraw = { key: added.key, field: "name" };
      draw();
    });

    const start = el("input", { type: "date", "data-field": "start", "aria-label": `Start of ${task.name}` });
    start.value = placed === null ? "" : formatDay(placed.start);
    start.disabled = task.start.kind !== "date";
    if (start.disabled) start.title = "Set by the task it starts after";
    start.addEventListener("change", () => {
      const day = parseDay(start.value);
      if (day === null) { draw(); return; }
      const moved = moveTo(chart, task.key, day, today);
      apply(moved.chart);
    });

    const milestone = task.tags.includes("milestone");
    const lengthCell = endsCell(task, milestone);

    const after = el("select", { "data-field": "after", "aria-label": `${task.name} starts after` });
    after.append(el("option", { value: "" }, "A fixed date"));
    if (task.start.kind === "previous") after.append(el("option", { value: "@previous" }, "The task above"));
    if (task.start.kind === "after" && task.start.ids.length > 1) after.append(el("option", { value: "@several" }, "Several tasks"));
    for (const other of tasks) {
      if (other.key === task.key) continue;
      after.append(el("option", { value: other.key }, other.name));
    }
    after.value = startChoice(task, tasks);
    after.addEventListener("change", () => {
      if (after.value === "@previous" || after.value === "@several") return;
      if (after.value === "") {
        apply(setStart(chart, task.key, { kind: "date", day: placed?.start ?? today }));
        return;
      }
      apply(link(chart, after.value, task.key, today));
    });

    const progress = el("select", { "data-field": "progress", "aria-label": `Status of ${task.name}` });
    for (const [value, label] of [["todo", "Not started"], ["active", "In progress"], ["done", "Done"]] as const) progress.append(el("option", { value }, label));
    progress.value = task.tags.includes("done") ? "done" : task.tags.includes("active") ? "active" : "todo";
    progress.addEventListener("change", () => apply(setProgress(chart, task.key, progress.value as "todo" | "active" | "done")));
    const flags = el("div", { class: "ge-flags" });
    // why: compact toggles, not labelled checkboxes, so the table leaves room for the timeline.
    // why: only Milestone. Critical was dropped from the row at the user's request; a `crit` tag
    // a chart already has is kept and still drawn.
    for (const [flag, label, glyph] of [["milestone", "Milestone", "◆"]] as const) {
      const on = task.tags.includes(flag);
      const toggle = button(glyph, () => apply(setFlag(chart, task.key, flag, !on)), {
        class: "ge-flag",
        "data-field": flag,
        "aria-pressed": String(on),
        "aria-label": `${label}: ${task.name}`,
        title: label,
      });
      flags.append(toggle);
    }
    const statusCell = el("td");
    statusCell.append(progress, flags);
    // why: a marker, not a sentence. Rows keep one fixed height so the table and timeline line up.
    if (placed?.error !== null && placed?.error !== undefined) statusCell.append(el("span", { class: "ge-error", role: "img", "aria-label": `Problem: ${placed.error}`, title: `Problem: ${placed.error}` }, "!"));

    const removeButton = button("×", () => { commit(remove(chart, task.key, today)); say(`Removed ${task.name}.`); draw(); }, { class: "ge-remove", "data-field": "remove", "aria-label": `Remove ${task.name}`, title: "Remove" });
    const cells = [name, start];
    const tds = cells.map((node) => { const td = el("td"); td.append(node); return td; });
    const afterCell = el("td");
    afterCell.append(after);
    const removeCell = el("td");
    removeCell.append(removeButton);
    const gripCell = el("td", { class: "ge-grip-cell" });
    gripCell.append(grip(task, tr));
    tr.append(gripCell, ...tds, lengthCell, afterCell, colorCell(task), statusCell, removeCell);
    return tr;
  }

  /** The row under a timeline y: the last row starting at or above it, an add row's room included. */
  function rowAt(y: number): number {
    let found = 0;
    rowTops.forEach((rowTop, index) => { if (rowTop <= y) found = index; });
    return found;
  }

  /** The thin row closing a phase (or the tasks above the first phase): adds a task at its end. */
  function addRow(afterKey: string, section: Section | null, height: number): HTMLTableRowElement {
    const tr = el("tr", { class: "ge-add-row" });
    tr.style.height = `${String(height)}px`;
    const td = el("td", { colspan: "7" });
    td.append(button("+ Add task", () => {
      const added = addTask(chart, afterKey, today);
      commit(added.chart);
      focusAfterDraw = { key: added.key, field: "name" };
      draw();
    }, { class: "ge-add-task", "aria-label": section === null ? "Add a task" : `Add a task to ${section.name}` }));
    tr.append(el("td"), td);
    return tr;
  }

  function sectionRow(section: Section): HTMLTableRowElement {
    const tr = el("tr", { class: "ge-row ge-section-row", "data-key": section.key });
    const name = el("input", { type: "text", "data-field": "name", "aria-label": `Name of section ${section.name}` });
    name.value = section.name;
    name.addEventListener("change", () => apply(renameLine(chart, section.key, name.value)));
    const td = el("td", { colspan: "4" });
    td.append(name);
    const removeCell = el("td");
    removeCell.append(button("×", () => { commit(remove(chart, section.key, today)); say(`Removed section ${section.name}.`); draw(); }, { class: "ge-remove", "data-field": "remove", "aria-label": `Remove section ${section.name}`, title: "Remove" }));
    tr.prepend(el("td"));
    tr.append(td, sectionColorCell(section), el("td"), removeCell);
    return tr;
  }

  /** The Ends column: how the end is given (end date, hours, days, weeks) and its value. */
  function endsCell(task: Task, milestone: boolean): HTMLTableCellElement {
    const td = el("td", { class: "ge-ends-cell" });
    const kind = task.end.kind;
    const unitLabel = (value: EndKind): string => (value === "date" ? "End date" : value[0]?.toUpperCase() + value.slice(1));
    const mode = el("select", { "data-field": "end-kind", "aria-label": `How ${task.name} ends` });
    for (const value of END_KINDS) mode.append(el("option", { value }, unitLabel(value)));
    mode.value = kind;
    mode.disabled = milestone;
    mode.addEventListener("change", () => {
      if (isEndKind(mode.value)) apply(setEndKind(chart, task.key, mode.value, today));
    });
    const value = kind === "date"
      ? el("input", { type: "date", "data-field": "end", "aria-label": `End date of ${task.name}`, title: "The bar ends at the start of this day, as in Mermaid." })
      : el("input", { type: "number", min: "1", step: "1", inputmode: "numeric", "data-field": "length", "aria-label": `Length of ${task.name} in ${kind}` });
    value.value = task.end.kind === "date" ? formatDay(task.end.day) : String(task.end.count);
    value.disabled = milestone;
    value.addEventListener("change", () => {
      if (task.end.kind === "date") {
        const day = parseDay(value.value);
        if (day === null) { draw(); return; }
        apply(setEnd(chart, task.key, { kind: "date", day }));
        return;
      }
      const count = Number(value.value);
      if (!Number.isSafeInteger(count) || count < 1) { say(`A length is a whole number of ${task.end.kind}, at least 1.`); draw(); return; }
      apply(setEnd(chart, task.key, { kind: task.end.kind, count }));
    });
    td.append(mode, value);
    return td;
  }

  /** Each phase's and each task's phase colour, as of the last draw (SPEC §13.3). */
  let phaseHues: PhaseHues = { bySection: new Map(), byTask: new Map() };

  /** A task's colour, or `undefined`. */
  const colorOf = (task: Task): TaskColor | undefined => (task.id === null ? undefined : chart.colors.get(task.id));

  /** Fills a bar in its task's colour. The value was validated by `parseColor`. */
  function paint<E extends SVGElement>(shape: E, task: Task): E {
    const color = colorOf(task);
    if (color !== undefined) {
      const style = colorStyle(color);
      shape.style.fill = style.fill;
      shape.style.stroke = style.stroke;
      shape.dataset["color"] = "true";
      return shape;
    }
    // why: as in the note (§13.2), a bar takes its phase's colour, faded when done and stronger
    // when active; a critical task keeps its danger outline.
    const hue = phaseHues.byTask.get(task.key);
    if (hue === undefined) return shape;
    if (hue === NEUTRAL_HUE) {
      const plain = colorStyle({ kind: "none" });
      shape.style.fill = plain.fill;
      shape.style.stroke = task.tags.includes("crit") ? "var(--state-danger)" : plain.stroke;
      return shape;
    }
    const done = task.tags.includes("done");
    shape.style.fill = tint(hue, done ? 10 : task.tags.includes("active") ? 45 : 24);
    shape.style.stroke = task.tags.includes("crit") ? "var(--state-danger)" : hue;
    if (done) shape.style.strokeOpacity = "0.55";
    return shape;
  }

  /** A phase's colour control: Auto, the note colours, or a custom one (SPEC §13.3). */
  function sectionColorCell(section: Section): HTMLTableCellElement {
    const td = el("td", { class: "ge-color-cell" });
    const custom = chart.sectionColors.get(section.name);
    const hue = phaseHues.bySection.get(section.key);
    const swatch = el("span", { class: "ge-swatch", "aria-hidden": "true" });
    if (hue !== undefined) {
      const plain = colorStyle({ kind: "none" });
      swatch.style.background = hue === NEUTRAL_HUE ? plain.fill : tint(hue, 35);
      swatch.style.borderColor = hue === NEUTRAL_HUE ? plain.stroke : hue;
    }
    const select = el("select", { "data-field": "color", "aria-label": `Colour of phase ${section.name}` });
    select.append(el("option", { value: "" }, "Auto"), el("option", { value: "none" }, "No colour"));
    for (const name of NOTE_COLORS) select.append(el("option", { value: name }, name[0]?.toUpperCase() + name.slice(1)));
    select.append(el("option", { value: "custom" }, custom?.kind === "hex" ? `Custom ${custom.hex}` : "Custom…"));
    select.value = custom === undefined ? "" : custom.kind === "hex" ? "custom" : colorText(custom);
    const picker = el("input", { type: "color", class: "ge-picker", "data-field": "picker", "aria-label": `Custom colour of phase ${section.name}` });
    picker.value = custom?.kind === "hex" ? longHex(custom.hex) : "#3a7bd5";
    if (custom?.kind !== "hex") {
      picker.dataset["hidden"] = "true";
      picker.tabIndex = -1;
    }
    select.addEventListener("change", () => {
      if (select.value === "custom") {
        if (typeof picker.showPicker === "function") picker.showPicker();
        else picker.click();
        return;
      }
      apply(setSectionColor(chart, section.key, select.value === "" ? null : parseColor(select.value)));
    });
    picker.addEventListener("change", () => {
      const picked = parseColor(picker.value);
      if (picked !== null) apply(setSectionColor(chart, section.key, picked));
    });
    td.append(swatch, select, picker);
    return td;
  }

  /** The Colour column: a swatch, the note colours, and a custom picker (A40). */
  function colorCell(task: Task): HTMLTableCellElement {
    const td = el("td", { class: "ge-color-cell" });
    const color = colorOf(task);
    const swatch = el("span", { class: "ge-swatch", "aria-hidden": "true" });
    if (color !== undefined) {
      const style = colorStyle(color);
      swatch.style.background = style.fill;
      swatch.style.borderColor = style.stroke;
    }
    const select = el("select", { "data-field": "color", "aria-label": `Colour of ${task.name}` });
    select.append(el("option", { value: "" }, "Phase colour"), el("option", { value: "none" }, "No colour"));
    for (const name of NOTE_COLORS) select.append(el("option", { value: name }, name[0]?.toUpperCase() + name.slice(1)));
    select.append(el("option", { value: "custom" }, color?.kind === "hex" ? `Custom ${color.hex}` : "Custom…"));
    select.value = color === undefined ? "" : color.kind === "hex" ? "custom" : colorText(color);
    const picker = el("input", { type: "color", class: "ge-picker", "data-field": "picker", "aria-label": `Custom colour of ${task.name}` });
    picker.value = color?.kind === "hex" ? longHex(color.hex) : "#3a7bd5";
    // why: only a custom colour shows its picker; otherwise it waits, unseen and out of the tab
    // order, for Custom… in the menu to open it.
    if (color?.kind !== "hex") {
      picker.dataset["hidden"] = "true";
      picker.tabIndex = -1;
    }
    select.addEventListener("change", () => {
      if (select.value === "custom") {
        // why: the custom colour is chosen in the system picker; nothing changes until it is.
        if (typeof picker.showPicker === "function") picker.showPicker();
        else picker.click();
        return;
      }
      apply(setColor(chart, task.key, select.value === "" ? null : parseColor(select.value), today));
    });
    picker.addEventListener("change", () => {
      const picked = parseColor(picker.value);
      if (picked !== null) apply(setColor(chart, task.key, picked, today));
    });
    td.append(swatch, select, picker);
    return td;
  }

  /** The task list's drag handle: drag a row to another place or phase (SPEC §13.3). */
  function grip(task: Task, row: HTMLTableRowElement): HTMLButtonElement {
    let dragged = false;
    const handle = button("⠿", () => {
      // why: a click follows every mouse drag; only a press without one gets the hint.
      if (dragged) { dragged = false; return; }
      say(`Drag ${task.name} to another row, or press Alt+Up or Alt+Down.`);
    }, {
      class: "ge-grip",
      "data-field": "grip",
      "aria-label": `Move ${task.name}`,
      title: "Drag to move. Alt+Up or Alt+Down moves it from the keyboard.",
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      row.classList.add("ge-moving");
      let drop: { index: number; after: boolean } | null = null;
      const clear = (): void => { for (const marked of row.parentElement?.querySelectorAll("[data-drop]") ?? []) marked.removeAttribute("data-drop"); };
      const pane = row.closest<HTMLElement>(".ge-table-wrap");
      const move = (moveEvent: PointerEvent): void => {
        dragged = true;
        clear();
        // why: a row below the visible part of the list must still be reachable mid-drag.
        if (pane !== null) {
          const edge = pane.getBoundingClientRect();
          if (moveEvent.clientY > edge.bottom - 32) pane.scrollTop += 16;
          else if (moveEvent.clientY < edge.top + 32) pane.scrollTop -= 16;
        }
        const over = doc.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLTableRowElement>("tr.ge-row");
        if (over === null || over === undefined || over.parentElement !== row.parentElement) { drop = null; return; }
        const bounds = over.getBoundingClientRect();
        const after = moveEvent.clientY > bounds.top + bounds.height / 2;
        over.setAttribute("data-drop", after ? "after" : "before");
        drop = { index: rowKeys.indexOf(over.dataset["key"] ?? ""), after };
      };
      const stop = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", cancelled);
        clear();
        row.classList.remove("ge-moving");
        if (drop === null || drop.index === -1) return;
        focusAfterDraw = { key: task.key, field: "grip" };
        moveRow(task.key, dropBefore(drop.index, drop.after));
      };
      const cancelled = (): void => { drop = null; stop(); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", cancelled);
    });
    return handle;
  }

  function drawAxis(timeline: SVGSVGElement, range: { start: number; end: number }, x: (day: number) => number, height: number): void {
    const axis = svg("g", { class: "ge-axis" });
    const format = new Intl.DateTimeFormat(undefined, zoom === "months" ? { month: "short", year: "2-digit", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" });
    for (let day = range.start; day <= range.end; day += 1) {
      const date = new Date(day * 86_400_000);
      const tick = zoom === "days" || (zoom === "weeks" && date.getUTCDay() === 1) || (zoom === "months" && date.getUTCDate() === 1);
      if (!tick) continue;
      axis.append(svg("line", { class: "ge-grid", x1: x(day), x2: x(day), y1: HEADER - 8, y2: height }));
      const label = svg("text", { class: "ge-tick", x: x(day) + 3, y: HEADER - 14 });
      label.textContent = zoom === "days" ? String(date.getUTCDate()) : format.format(date);
      axis.append(label);
      // why: the range's first day is labelled only when its month runs on for a few days;
      // otherwise its label collides with the next month's.
      const roomy = new Date((day + 5) * 86_400_000).getUTCMonth() === date.getUTCMonth();
      if (zoom === "days" && (date.getUTCDate() === 1 || (day === range.start && roomy))) {
        const month = svg("text", { class: "ge-month", x: x(day) + 3, y: 12 });
        month.textContent = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
        axis.append(month);
      }
    }
    timeline.append(axis);
  }

  function bar(task: Task, placed: Placed, y: number, x: (day: number) => number, px: number): SVGGElement {
    const milestone = task.tags.includes("milestone");
    const label = `${task.name}, ${milestone ? "" : "from "}${readable(placed.start)}${milestone ? "" : ` to ${readable(placed.end)}`}`;
    const group = svg("g", {
      class: "ge-bar",
      "data-key": task.key,
      "data-field": "bar",
      tabindex: 0,
      role: "button",
      "aria-label": `${label}. Left and Right move it a day${milestone ? "" : "; Shift with Left or Right changes its length"}.`,
    });
    group.dataset["state"] = task.tags.includes("done") ? "done" : task.tags.includes("active") ? "active" : "todo";
    if (task.tags.includes("crit")) group.dataset["crit"] = "true";
    if (placed.error !== null) group.dataset["error"] = "true";
    const top = y + 10;
    const barHeight = ROW - 20;
    if (milestone) {
      const cx = x(placed.start);
      const cy = y + ROW / 2;
      const r = barHeight / 2;
      group.append(paint(svg("path", { class: "ge-shape", d: `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} z` }), task));
    } else {
      const left = x(placed.start);
      const width = Math.max(px * 0.5, x(placed.end) - left);
      group.append(paint(svg("rect", { class: "ge-shape", x: left, y: top, width, height: barHeight, rx: 6 }), task));
      // why: a name goes inside its bar, shortened when it does not fit (SPEC §13.3), and the
      // full name shows on hover; a bar too short for even a few letters keeps it alongside,
      // past the connector.
      const inside = width >= MIN_INSIDE_PX;
      const text = svg("text", { class: inside ? "ge-bar-label" : "ge-bar-label ge-bar-label-outside", x: inside ? left + 8 : left + width + 26, y: y + ROW / 2 + 4 });
      text.textContent = inside ? fitText(task.name, width - 16, estimateWidth) : task.name;
      if (text.textContent !== task.name) text.dataset["shortened"] = "true";
      group.append(text);
      const hover = svg("title");
      hover.textContent = task.name;
      group.append(hover);
      group.append(svg("rect", { class: "ge-resize", "data-handle": "resize", x: left + width - 10, y: top, width: 14, height: barHeight }));
      const link = svg("circle", { class: "ge-link", "data-handle": "link", cx: left + width + 14, cy: y + ROW / 2, r: 7 });
      const title = svg("title");
      title.textContent = `Drag to another task to make it start after ${task.name}`;
      link.append(title);
      group.append(link);
    }
    group.addEventListener("keydown", (event) => onBarKey(event, task, placed));
    group.addEventListener("pointerdown", (event) => onBarPointer(event, task, placed, group, px));
    return group;
  }

  /** Sizes the stacked panes. Inline rows rather than a custom property: the token contract allows no private names. */
  function applySplit(): void {
    const stacked = layout === "stacked" && dialog.dataset["narrow"] !== "true";
    body.style.gridTemplateRows = stacked ? `minmax(0, ${split}fr) auto minmax(0, ${100 - split}fr)` : "";
  }

  /** The draggable, keyboard-operable boundary between chart and tasks (§8.4). */
  function divider(): HTMLElement {
    const handle = el("div", {
      class: "ge-divider",
      role: "separator",
      tabindex: "0",
      "aria-orientation": "horizontal",
      "aria-label": "Resize chart and tasks",
      "aria-valuemin": "20",
      "aria-valuemax": "80",
      "aria-valuenow": String(split),
    });
    const set = (value: number): void => {
      split = Math.round(Math.min(80, Math.max(20, value)));
      handle.setAttribute("aria-valuenow", String(split));
      applySplit();
    };
    handle.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowUp" ? -5 : event.key === "ArrowDown" ? 5 : 0;
      if (step === 0) return;
      event.preventDefault();
      set(split + step);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const bounds = body.getBoundingClientRect();
      const move = (moveEvent: PointerEvent): void => {
        if (bounds.height > 0) set(((moveEvent.clientY - bounds.top) / bounds.height) * 100);
      };
      const stop = (): void => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
    return handle;
  }

  /** Dragging empty timeline space scrolls it sideways, for touch and mouse alike. */
  function panTimeline(event: PointerEvent, timeline: SVGSVGElement, wrap: HTMLElement): void {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".ge-bar") !== null)) return;
    timeline.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originScroll = wrap.scrollLeft;
    const move = (moveEvent: PointerEvent): void => { wrap.scrollLeft = originScroll - (moveEvent.clientX - originX); };
    const stop = (): void => {
      timeline.removeEventListener("pointermove", move);
      timeline.removeEventListener("pointerup", stop);
      timeline.removeEventListener("pointercancel", stop);
    };
    timeline.addEventListener("pointermove", move);
    timeline.addEventListener("pointerup", stop);
    timeline.addEventListener("pointercancel", stop);
  }

  function onBarKey(event: KeyboardEvent, task: Task, placed: Placed): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    focusAfterDraw = { key: task.key, field: "bar" };
    if (event.shiftKey) {
      apply(endAt(chart, task.key, placed.end + delta, today));
      return;
    }
    const moved = moveTo(chart, task.key, placed.start + delta, today);
    if (moved.pinned) say(`${task.name} now starts on a fixed date; Undo restores its dependency.`);
    apply(moved.chart);
  }

  function onBarPointer(event: PointerEvent, task: Task, placed: Placed, group: SVGGElement, px: number): void {
    if (event.button !== 0) return;
    const handle = event.target instanceof Element ? event.target.getAttribute("data-handle") : null;
    const timeline = group.ownerSVGElement;
    if (timeline === null) return;
    event.preventDefault();
    group.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originY = event.clientY;
    let delta = 0;
    let line: SVGLineElement | null = null;
    /** A drop row while the bar is being dragged up or down; `null` while it moves only in time. */
    let drop: { index: number; after: boolean } | null = null;
    let marker: SVGLineElement | null = null;
    if (handle === "link") {
      const point = toSvg(timeline, event);
      line = svg("line", { class: "ge-link-drag", x1: point.x, y1: point.y, x2: point.x, y2: point.y });
      timeline.append(line);
    }
    group.classList.add("ge-dragging");
    const move = (moveEvent: PointerEvent): void => {
      if (line !== null) {
        const point = toSvg(timeline, moveEvent);
        line.setAttribute("x2", String(point.x));
        line.setAttribute("y2", String(point.y));
        return;
      }
      delta = Math.round((moveEvent.clientX - originX) / px);
      const dy = handle === "resize" ? 0 : moveEvent.clientY - originY;
      // why: half a row of vertical movement before a drag means "another row"; a small wobble
      // while dragging along the timeline must not reorder anything.
      if (Math.abs(dy) >= ROW / 2) {
        const point = toSvg(timeline, moveEvent);
        const index = rowAt(point.y);
        const rowTop = rowTops[index] ?? HEADER;
        drop = { index, after: point.y - rowTop > ROW / 2 };
        const y = drop.after ? rowTop + ROW : rowTop;
        marker ??= svg("line", { class: "ge-drop-line", x1: 0, x2: timeline.width.baseVal.value });
        marker.setAttribute("y1", String(y));
        marker.setAttribute("y2", String(y));
        if (!marker.isConnected) timeline.append(marker);
      } else {
        drop = null;
        marker?.remove();
      }
      group.setAttribute("transform", handle === "resize" ? "" : `translate(${delta * px},${drop === null ? 0 : dy})`);
      if (handle === "resize") {
        const shape = group.querySelector<SVGRectElement>(".ge-shape");
        const width = Math.max(px, (placed.end - placed.start + delta) * px);
        shape?.setAttribute("width", String(width));
      }
    };
    const end = (endEvent: PointerEvent): void => {
      group.removeEventListener("pointermove", move);
      group.removeEventListener("pointerup", end);
      group.removeEventListener("pointercancel", cancel);
      group.classList.remove("ge-dragging");
      if (line !== null) {
        line.remove();
        const target = doc.elementFromPoint(endEvent.clientX, endEvent.clientY)?.closest<SVGGElement>(".ge-bar");
        const targetKey = target?.dataset["key"];
        if (targetKey !== undefined && targetKey !== task.key) {
          focusAfterDraw = { key: targetKey, field: "bar" };
          if (apply(link(chart, task.key, targetKey, today))) say(`${targetNameOf(targetKey)} now starts after ${task.name}.`);
        }
        return;
      }
      focusAfterDraw = { key: task.key, field: "bar" };
      marker?.remove();
      if (drop !== null) {
        // One drag, one undo step: the new dates first, then the new row.
        const dated = delta === 0 ? chart : moveTo(chart, task.key, placed.start + delta, today).chart;
        if (isRefused(dated)) { apply(dated); return; }
        moveRow(task.key, dropBefore(drop.index, drop.after), dated);
        return;
      }
      if (delta === 0) { draw(); return; }
      if (handle === "resize") {
        apply(endAt(chart, task.key, placed.end + delta, today));
        return;
      }
      const moved = moveTo(chart, task.key, placed.start + delta, today);
      if (moved.pinned) say(`${task.name} now starts on a fixed date; Undo restores its dependency.`);
      apply(moved.chart);
    };
    const cancel = (): void => {
      group.removeEventListener("pointermove", move);
      group.removeEventListener("pointerup", end);
      group.removeEventListener("pointercancel", cancel);
      line?.remove();
      marker?.remove();
      draw();
    };
    group.addEventListener("pointermove", move);
    group.addEventListener("pointerup", end);
    group.addEventListener("pointercancel", cancel);
  }

  const targetNameOf = (key: string): string =>
    chart.lines.find((line): line is Task => line.kind === "task" && line.key === key)?.name ?? "That task";

  function save(force: boolean): void {
    if (chart.readOnly !== null) return;
    if (!dirty()) { finish(); return; }
    const current = options.current?.();
    if (!force && current !== undefined && current !== options.source) {
      conflict.replaceChildren(
        el("span", {}, "Someone else changed this chart while you were editing. "),
        button("Replace theirs", () => save(true), { class: "ge-primary" }),
        button("Discard mine", () => finish()),
      );
      conflict.hidden = false;
      return;
    }
    options.onSave(serializeChart(chart));
    finish();
  }

  function requestClose(): void {
    if (!dirty()) { finish(); return; }
    conflict.replaceChildren(
      el("span", {}, "Discard your changes to this chart? "),
      button("Discard", () => finish()),
      button("Keep editing", () => { conflict.hidden = true; conflict.replaceChildren(); cancelButton.focus(); }, { class: "ge-primary" }),
    );
    conflict.hidden = false;
    conflict.querySelector<HTMLButtonElement>(".ge-primary")?.focus();
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    media.removeEventListener("change", onMedia);
    resized?.disconnect();
    if (pending !== 0) view?.cancelAnimationFrame(pending);
    dialog.close();
    dialog.remove();
    options.onClose?.();
  }

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    // why: Escape closes the open style panel first, as it would a menu, not the whole editor.
    if (styleOpen) setStyleOpen(false, true);
    else requestClose();
  });
  // why: once the chart and the table are not side by side, a row and its bar no longer share
  // a line. Focus in either marks the task in both and brings the other into view.
  dialog.addEventListener("focusin", (event) => {
    const key = event.target instanceof Element ? event.target.closest<HTMLElement | SVGElement>("[data-key]")?.dataset["key"] : undefined;
    for (const node of dialog.querySelectorAll<HTMLElement | SVGElement>("[data-current]")) delete node.dataset["current"];
    if (key === undefined) return;
    for (const node of dialog.querySelectorAll<HTMLElement | SVGElement>(`[data-key="${CSS.escape(key)}"]`)) {
      node.dataset["current"] = "true";
      if (event.target instanceof Node && !node.contains(event.target)) node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  });
  dialog.addEventListener("keydown", (event) => {
    // why: not in a <select>, where Alt+Down is the platform's way to open the list.
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && event.target instanceof Element && !(event.target instanceof HTMLSelectElement)) {
      const holder = event.target.closest<HTMLElement | SVGElement>("[data-key]");
      const key = holder?.dataset["key"];
      if (key === undefined || !chart.lines.some((line) => line.key === key && line.kind === "task")) return;
      event.preventDefault();
      const target = stepTarget(chart, key, event.key === "ArrowUp" ? "up" : "down");
      if (target === undefined) { say(`${targetNameOf(key)} is already ${event.key === "ArrowUp" ? "first" : "last"}.`); return; }
      focusAfterDraw = focusedField();
      moveRow(key, target);
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
    const target = event.target;
    // why: inside a text field, Mod+Z is the field's own undo of what is being typed.
    if (target instanceof HTMLInputElement && (target.type === "text" || target.type === "number")) return;
    event.preventDefault();
    if (event.shiftKey) step(redo, undo);
    else step(undo, redo);
  });
  // why: a host without matchMedia (an old embed, a test DOM) gets the wide layout.
  const view = doc.defaultView;
  const media = view !== null && typeof view.matchMedia === "function"
    ? view.matchMedia(NARROW)
    : { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
  const onMedia = (): void => { dialog.dataset["narrow"] = String(media.matches); applySplit(); };
  media.addEventListener("change", onMedia);
  // why: the pane's width is only known once the dialog is laid out, and it changes with the
  // window, the layout and the divider. Redraw on the next frame, at most once per frame.
  let pending = 0;
  const Observer = view?.ResizeObserver;
  const resized = Observer === undefined ? undefined : new Observer(() => {
    if (pending !== 0 || view === null) return;
    pending = view.requestAnimationFrame(() => {
      pending = 0;
      if (closed || chart.readOnly !== null || dialog.querySelector(".ge-dragging") !== null) return;
      // why: only a changed width needs new dates; redrawing for nothing would replace the
      // elements under a user's pointer.
      const available = body.querySelector(".ge-timeline-wrap")?.clientWidth ?? 0;
      if (available > 0 && Math.abs(available - paneWidth) > 1) drawBody();
    });
  });
  resized?.observe(body);
  onMedia();

  conflict.hidden = true;
  options.host.append(dialog);
  draw();
  dialog.showModal();
  // why: fit the timeline now that the dialog has a width. Left to the resize observer's first
  // callback, that redraw would replace elements a frame after the user could start using them.
  if (chart.readOnly === null) drawBody();
  if (chart.readOnly === null) titleInput.focus();
  return { close: finish };
}

export type Layout = "stacked" | "side";
const LAYOUT_KEY = "memberberry.gantt.layout";

/** The viewer's last layout. Storage can be blocked; that is not an error, just the default. */
function readLayout(doc: Document): Layout {
  try {
    return doc.defaultView?.localStorage.getItem(LAYOUT_KEY) === "side" ? "side" : "stacked";
  } catch {
    return "stacked";
  }
}

function writeLayout(doc: Document, layout: Layout): void {
  try {
    doc.defaultView?.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Blocked storage keeps the choice for this dialog only.
  }
}

/** A bar narrower than this keeps its name beside it rather than inside. */
const MIN_INSIDE_PX = 40;

/**
 * A label's width, estimated. why: bars are built before they are in the page, so nothing can be
 * measured yet; 12px UI text averages about 7px a character, and an emoji about twice that.
 */
function estimateWidth(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.length > 1 ? 14 : 7), 0);
}

/** The chart style controls, in toolbar order: the option, its label, and its choices. */
const STYLE_CHOICES: readonly {
  readonly option: keyof ChartOptions;
  readonly label: string;
  readonly choices: readonly (readonly [string, string])[];
}[] = [
  { option: "phases", label: "Phase names", choices: [["column", "Column"], ["row", "Rows"]] },
  { option: "phaseFill", label: "Phase colour", choices: [["whole", "Whole phase"], ["name", "Name only"]] },
  { option: "rows", label: "Row height", choices: [["fixed", "Standard"], ["zoomed", "Tall"]] },
  { option: "height", label: "Max height", choices: [["full", "Full"], ["small", "Small"], ["medium", "Medium"], ["large", "Large"]] },
];

/** A phase with "No colour": no band or stripe, and plain bars. */
export const NEUTRAL_HUE = "none";

interface PhaseHues {
  readonly bySection: ReadonlyMap<string, string>;
  readonly byTask: ReadonlyMap<string, string>;
}

/**
 * Each phase's colour, and each task's: a phase's own colour if it has one, else the automatic
 * palette in the order Mermaid numbers phases (phases with tasks, by first task), so the editor
 * and the note agree.
 */
export function huesOf(chart: Chart): PhaseHues {
  const bySection = new Map<string, string>();
  const byTask = new Map<string, string>();
  const order: (string | null)[] = [];
  let section: Section | null = null;
  const hueOf = (current: Section | null): string => {
    const key = current?.name ?? null;
    // why: counted even when the phase has its own colour, so the phases after it keep the
    // automatic colours Mermaid gives them by position.
    if (!order.includes(key)) order.push(key);
    const custom = current === null ? undefined : chart.sectionColors.get(current.name);
    if (custom?.kind === "none") return NEUTRAL_HUE;
    if (custom !== undefined) return colorHue(custom);
    return PHASE_COLOURS[order.indexOf(key) % PHASE_COLOURS.length] ?? PHASE_COLOURS[0];
  };
  for (const line of chart.lines) {
    if (line.kind === "section") { section = line; continue; }
    if (line.kind !== "task") continue;
    const hue = hueOf(section);
    byTask.set(line.key, hue);
    if (section !== null && !bySection.has(section.key)) bySection.set(section.key, hue);
  }
  // A phase with no tasks is not drawn by Mermaid; in the editor it still shows its own colour.
  for (const line of chart.lines) {
    if (line.kind !== "section" || bySection.has(line.key)) continue;
    const custom = chart.sectionColors.get(line.name);
    if (custom !== undefined) bySection.set(line.key, custom.kind === "none" ? NEUTRAL_HUE : colorHue(custom));
  }
  return { bySection, byTask };
}

/** The closest zoom that shows the whole chart: days up to three weeks, weeks up to four months. */
export function fittingZoom(range: { start: number; end: number }): Zoom {
  const days = range.end - range.start;
  if (days <= 24) return "days";
  return days <= 130 ? "weeks" : "months";
}

const END_KINDS: readonly EndKind[] = ["date", "hours", "days", "weeks"];
const isEndKind = (value: string): value is EndKind => (END_KINDS as readonly string[]).includes(value);

/** The "Starts after" choice for a task: "" for a fixed date, a sentinel, or a task's key. */
function startChoice(task: Task, tasks: readonly Task[]): string {
  const start = task.start;
  if (start.kind === "date") return "";
  if (start.kind === "previous") return "@previous";
  if (start.ids.length > 1) return "@several";
  return tasks.find((other) => other.id === start.ids[0])?.key ?? "";
}

function dayRange(placed: ReadonlyMap<string, Placed>, today: number): { start: number; end: number } {
  const values = [...placed.values()];
  if (values.length === 0) return { start: today - 2, end: today + 30 };
  // why: whole days, so axis ticks fall on midnight even when a task starts mid-day.
  const start = Math.floor(Math.min(...values.map((value) => value.start))) - 2;
  const end = Math.ceil(Math.max(...values.map((value) => value.end))) + 7;
  return { start, end: Math.max(end, start + 21) };
}

function toSvg(timeline: SVGSVGElement, event: PointerEvent): { x: number; y: number } {
  const bounds = timeline.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function readable(day: number): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(day * 86_400_000));
}

/** Today's local calendar date as a day number. */
export function localToday(now: Date = new Date()): number {
  return Math.round(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
}
