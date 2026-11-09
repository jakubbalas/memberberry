// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fittingZoom, huesOf, openGanttEditor, type GanttEditorOptions } from "./gantt-editor.js";
import { parseChart } from "./model.js";
import { parseDay } from "./model.js";

const TODAY = parseDay("2026-11-01") ?? 0;
const CHART = [
  "gantt",
  "    title Plan",
  "    dateFormat YYYY-MM-DD",
  "    section Design",
  "    Wireframes :done, wf, 2026-11-02, 5d",
  "    Visual design :vd, after wf, 8d",
].join("\n");

beforeAll(() => {
  // why: jsdom has no modal dialogs. These stand in for what the browser does with them.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false; };
});

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); });

function open(overrides: Partial<GanttEditorOptions> = {}) {
  const saved: string[] = [];
  const onClose = vi.fn();
  const handle = openGanttEditor({ source: CHART, host: document.body, today: TODAY, onSave: (text) => saved.push(text), onClose, ...overrides });
  const dialog = document.querySelector<HTMLDialogElement>("dialog.gantt-editor");
  if (dialog === null) throw new Error("no dialog");
  const byLabel = <T extends HTMLElement>(label: string): T => {
    const node = dialog.querySelector<T>(`[aria-label="${label}"]`);
    if (node === null) throw new Error(`no control labelled ${label}`);
    return node;
  };
  const press = (name: string): void => {
    const found = [...dialog.querySelectorAll("button")].find((node) => node.textContent === name);
    if (found === undefined) throw new Error(`no button ${name}`);
    found.click();
  };
  const bar = (name: string): SVGGElement => {
    const found = [...dialog.querySelectorAll<SVGGElement>(".ge-bar")].find((node) => node.textContent?.includes(name) === true || node.getAttribute("aria-label")?.startsWith(name) === true);
    if (found === undefined) throw new Error(`no bar ${name}`);
    return found;
  };
  const change = (node: HTMLInputElement | HTMLSelectElement, value: string): void => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return { handle, dialog, saved, onClose, byLabel, press, bar, change, status: () => dialog.querySelector(".ge-status")?.textContent ?? "" };
}

describe("openGanttEditor", () => {
  it("shows the chart's title, sections and tasks", () => {
    const e = open();
    expect([
      e.byLabel<HTMLInputElement>("Chart title").value,
      e.byLabel<HTMLInputElement>("Name of section Design").value,
      e.byLabel<HTMLInputElement>("Name of Visual design").value,
      e.byLabel<HTMLInputElement>("Start of Visual design").disabled,
      e.dialog.querySelectorAll(".ge-bar").length,
    ]).toEqual(["Plan", "Design", "Visual design", true, 2]);
  });

  it("closes without saving when nothing changed", () => {
    const e = open();
    e.press("Save");
    expect([e.saved, e.onClose.mock.calls.length, e.dialog.isConnected]).toEqual([[], 1, false]);
  });

  it("saves a rename, rewriting only that line", () => {
    const e = open();
    e.change(e.byLabel("Name of Visual design"), "Visual polish");
    e.press("Save");
    expect(e.saved).toEqual([CHART.replace("    Visual design :vd, after wf, 8d", "    Visual polish :vd, after wf, 8d")]);
  });

  it("refuses a name Mermaid cannot hold and says why", () => {
    const e = open();
    e.change(e.byLabel("Name of Wireframes"), "Phase: one");
    expect([e.status(), e.byLabel<HTMLInputElement>("Name of Wireframes").value]).toEqual(["A name cannot contain : # or ;.", "Wireframes"]);
  });

  it("moves a bar a day with the arrow keys and lengthens it with Shift", () => {
    const e = open();
    e.bar("Wireframes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    e.bar("Wireframes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    e.press("Save");
    expect(e.saved[0]).toContain("    Wireframes :done, wf, 2026-11-03, 6d");
  });

  it("keeps keyboard focus on the bar it moved", () => {
    const e = open();
    e.bar("Wireframes").focus();
    e.bar("Wireframes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement?.getAttribute("aria-label")?.startsWith("Wireframes, from")).toBe(true);
  });

  it("says a moved dependent task is now pinned, and Undo restores its dependency", () => {
    const e = open();
    e.bar("Visual design").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const said = e.status();
    e.press("Undo");
    e.press("Save");
    expect([said, e.saved]).toEqual(["Visual design now starts on a fixed date; Undo restores its dependency.", []]);
  });

  it("undoes and redoes with Mod+Z and Mod+Shift+Z outside a text field", () => {
    const e = open();
    e.bar("Wireframes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    e.dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    const undone = e.byLabel<HTMLInputElement>("Start of Wireframes").value;
    e.dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", ctrlKey: true, shiftKey: true, bubbles: true }));
    expect([undone, e.byLabel<HTMLInputElement>("Start of Wireframes").value]).toEqual(["2026-11-02", "2026-11-03"]);
  });

  it("adds a task below with Enter in a name and focuses it", () => {
    const e = open();
    e.byLabel("Name of Wireframes").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const names = [...e.dialog.querySelectorAll<HTMLInputElement>("input[data-field=name]")].map((node) => node.value);
    expect([names, (document.activeElement as HTMLInputElement | null)?.value]).toEqual([["Design", "Wireframes", "New task", "Visual design"], "New task"]);
  });

  it("links a task through Starts after", () => {
    const e = open({ source: "gantt\n    A :2026-11-02, 2d\n    B :2026-11-02, 3d" });
    const select = e.byLabel<HTMLSelectElement>("B starts after");
    const a = [...select.options].find((option) => option.textContent === "A");
    e.change(select, a?.value ?? "");
    e.press("Save");
    expect(e.saved).toEqual(["gantt\n    A :a, 2026-11-02, 2d\n    B :after a, 3d"]);
  });

  it("sets status and marks a milestone", () => {
    const e = open();
    e.change(e.byLabel("Status of Visual design"), "active");
    e.byLabel<HTMLButtonElement>("Milestone: Visual design").click();
    e.press("Save");
    expect(e.saved[0]).toContain("    Visual design :active, milestone, vd, after wf, 0d");
  });

  it("offers no Critical toggle, but keeps a crit tag a chart already has", () => {
    const e = open({ source: CHART.replace("Visual design :vd,", "Visual design :crit, vd,") });
    e.change(e.byLabel("Status of Visual design"), "done");
    e.press("Save");
    expect([e.dialog.querySelector('[aria-label^="Critical"]'), e.saved[0]?.includes("    Visual design :done, crit, vd, after wf, 8d")]).toEqual([null, true]);
  });

  it("switches how a task ends, and edits the value in that unit", () => {
    const e = open();
    e.change(e.byLabel("How Wireframes ends"), "hours");
    e.change(e.byLabel("Length of Wireframes in hours"), "36");
    e.change(e.byLabel("How Visual design ends"), "date");
    const endDate = e.byLabel<HTMLInputElement>("End date of Visual design").value;
    e.press("Save");
    // 36h moves Visual design to start at noon on 3 Nov; 8 days later is noon on the 11th,
    // and an end date is a whole day, so it rounds up to the 12th.
    expect([endDate, e.saved[0]?.split("\n").slice(4)]).toEqual(["2026-11-12", [
      "    Wireframes :done, wf, 2026-11-02, 36h",
      "    Visual design :vd, after wf, 2026-11-12",
    ]]);
  });

  it("says a length must be a whole number of the chosen unit", () => {
    const e = open();
    e.change(e.byLabel("How Wireframes ends"), "weeks");
    e.change(e.byLabel("Length of Wireframes in weeks"), "0");
    expect(e.status()).toBe("A length is a whole number of weeks, at least 1.");
  });

  it("removes a task and keeps the one that depended on it in place", () => {
    const e = open();
    e.byLabel<HTMLButtonElement>("Remove Wireframes").click();
    e.press("Save");
    expect(e.saved[0]).toContain("    Visual design :vd, 2026-11-07, 8d");
  });

  it("changes the title", () => {
    const e = open();
    e.change(e.byLabel("Chart title"), "Roadmap");
    e.press("Save");
    expect(e.saved[0]?.split("\n")[1]).toBe("    title Roadmap");
  });

  it("asks before discarding changes on Escape", () => {
    const e = open();
    e.change(e.byLabel("Chart title"), "Roadmap");
    e.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    const asked = e.dialog.querySelector(".ge-conflict")?.textContent ?? "";
    e.press("Discard");
    expect([asked.startsWith("Discard your changes"), e.saved, e.dialog.isConnected]).toEqual([true, [], false]);
  });

  it("closes at once on Escape with nothing changed", () => {
    const e = open();
    e.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(e.dialog.isConnected).toBe(false);
  });

  it("does not overwrite a collaborator's change silently", () => {
    let current = CHART;
    const e = open({ current: () => current });
    e.change(e.byLabel("Chart title"), "Roadmap");
    current = `${CHART}\n    Someone else :2d`;
    e.press("Save");
    const warned = e.saved.length === 0 && e.dialog.isConnected;
    e.press("Replace theirs");
    expect([warned, e.saved.length]).toEqual([true, 1]);
  });

  it("opens a chart it cannot represent read-only, with Edit as text", () => {
    const onEditAsText = vi.fn();
    const e = open({ source: "gantt\n    dateFormat DD-MM-YYYY\n    A :01-11-2026, 2d", onEditAsText });
    const notice = e.dialog.querySelector(".ge-notice")?.textContent ?? "";
    const saveDisabled = [...e.dialog.querySelectorAll("button")].find((node) => node.textContent === "Save")?.disabled;
    e.press("Edit as text");
    expect([notice.includes("dates use the format DD-MM-YYYY"), saveDisabled, onEditAsText.mock.calls.length, e.dialog.isConnected]).toEqual([true, true, 1, false]);
  });

  it("puts task names in the page as text only", () => {
    const e = open({ source: "gantt\n    <img src=x onerror=alert(1)> :2026-11-02, 2d" });
    expect([e.dialog.querySelector("img"), e.bar("<img").querySelector(":scope > title")?.textContent]).toEqual([null, "<img src=x onerror=alert(1)>"]);
  });

  it("closes from the handle without saving", () => {
    const e = open();
    e.handle.close();
    expect([e.dialog.isConnected, e.onClose.mock.calls.length]).toEqual([false, 1]);
  });
});

describe("moving tasks between phases", () => {
  const PHASES = [
    "gantt",
    "    dateFormat YYYY-MM-DD",
    "    section Design",
    "    Wireframes :wf, 2026-11-02, 5d",
    "    Review :2d",
    "    section Build",
    "    Frontend :fe, 2026-11-20, 4d",
  ].join("\n");
  const altKey = (node: Element, key: "ArrowUp" | "ArrowDown") => node.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true }));

  it("moves a task into the next phase with Alt+Down, keeping its dates", () => {
    const e = open({ source: PHASES });
    altKey(e.byLabel("Name of Review"), "ArrowDown");
    const said = e.status();
    e.press("Save");
    expect([said, e.saved[0]?.split("\n").slice(2)]).toEqual(["Moved Review to Build.", [
      "    section Design",
      "    Wireframes :wf, 2026-11-02, 5d",
      "    section Build",
      "    Review :after wf, 2d",
      "    Frontend :fe, 2026-11-20, 4d",
    ]]);
  });

  it("moves a task back up with Alt+Up from its bar, and keeps focus on it", () => {
    const e = open({ source: PHASES });
    e.bar("Frontend").focus();
    altKey(e.bar("Frontend"), "ArrowUp");
    expect([e.status(), document.activeElement?.getAttribute("aria-label")?.startsWith("Frontend, from")]).toEqual(["Moved Frontend to Design.", true]);
  });

  it("says when a task cannot go further", () => {
    const e = open({ source: PHASES });
    altKey(e.byLabel("Name of Frontend"), "ArrowDown");
    expect(e.status()).toBe("Frontend is already last.");
  });

  it("leaves Alt+Down to a dropdown, which uses it to open", () => {
    const e = open({ source: PHASES });
    altKey(e.byLabel("Status of Review"), "ArrowDown");
    e.press("Save");
    expect(e.saved).toEqual([]);
  });

  it("tells a keyboard user how to move a task when its grip is pressed", () => {
    const e = open({ source: PHASES });
    e.byLabel<HTMLButtonElement>("Move Review").click();
    expect(e.status()).toBe("Drag Review to another row, or press Alt+Up or Alt+Down.");
  });
});

describe("task colours", () => {
  it("colours a task with a note colour, shows it on the bar, and saves a colour line", () => {
    const e = open();
    e.change(e.byLabel("Colour of Wireframes"), "green");
    const fill = e.bar("Wireframes").querySelector<SVGElement>(".ge-shape")?.style.fill;
    e.press("Save");
    expect([fill, e.saved[0]?.split("\n").slice(0, 4)]).toEqual(["var(--note-background-green)", ["gantt", "    title Plan", "    dateFormat YYYY-MM-DD", "    %% color wf green"]]);
  });

  it("saves a custom colour from the picker as hex", () => {
    const e = open();
    e.change(e.byLabel("Custom colour of Visual design"), "#3a7bd5");
    e.press("Save");
    expect(e.saved[0]?.split("\n").filter((line) => line.includes("%% color"))).toEqual(["    %% color vd #3a7bd5"]);
  });

  it("shows a chart's existing colours and returns one to its phase colour", () => {
    const e = open({ source: CHART.replace("    section Design", "    %% color wf #ff0000\n    section Design") });
    const shown = [e.byLabel<HTMLSelectElement>("Colour of Wireframes").value, e.bar("Wireframes").querySelector<SVGElement>(".ge-shape")?.style.stroke];
    e.change(e.byLabel("Colour of Wireframes"), "");
    e.press("Save");
    // why: the DOM may report the colour as rgb(); either spelling is the same red.
    expect([shown[0], /#ff0000|rgb\(255, 0, 0\)/u.test(shown[1] ?? ""), e.saved[0]?.includes("%% color")]).toEqual(["custom", true, false]);
  });

  it("shows the custom picker only for a task with a custom colour", () => {
    const e = open({ source: CHART.replace("    section Design", "    %% color wf #ff0000\n    section Design") });
    const state = (name: string) => [e.byLabel(`Custom colour of ${name}`).dataset["hidden"] ?? "shown", e.byLabel(`Custom colour of ${name}`).tabIndex];
    expect([state("Wireframes"), state("Visual design")]).toEqual([["shown", 0], ["true", -1]]);
  });

  it("gives a task no colour at all, as a plain bar", () => {
    const e = open();
    e.change(e.byLabel("Colour of Wireframes"), "none");
    const bar = e.bar("Wireframes").querySelector<SVGElement>(".ge-shape");
    e.press("Save");
    expect([bar?.style.fill, bar?.style.stroke, e.saved[0]?.split("\n")[3]]).toEqual(["var(--surface-raised)", "var(--text-muted)", "    %% color wf none"]);
  });

  it("does not change anything when Custom is chosen until a colour is picked", () => {
    const e = open();
    e.change(e.byLabel("Colour of Wireframes"), "custom");
    e.press("Save");
    expect(e.saved).toEqual([]);
  });
});

describe("phase colours", () => {
  const PHASES = [
    "gantt", "    dateFormat YYYY-MM-DD",
    "    Kick-off :ko, 2026-11-01, 1d",
    "    section Design", "    Wireframes :wf, 2026-11-02, 5d",
    "    section Empty",
    "    section Build", "    Frontend :fe, after wf, 4d",
  ].join("\n");

  it("gives phases the automatic colours in Mermaid's order, counting tasks above the first phase", () => {
    const chart = parseChart(PHASES);
    const hues = huesOf(chart);
    const key = (name: string) => chart.lines.find((line) => line.kind === "section" && line.name === name)?.key ?? "";
    expect([hues.bySection.get(key("Design")), hues.bySection.get(key("Empty")), hues.bySection.get(key("Build"))])
      .toEqual(["var(--series-1)", undefined, "var(--series-4)"]);
  });

  it("uses a phase's own colour and leaves the next phase's automatic colour where it was", () => {
    const chart = parseChart(PHASES.replace("    section Design", "    %% section-color green Design\n    section Design"));
    const hues = huesOf(chart);
    const key = (name: string) => chart.lines.find((line) => line.kind === "section" && line.name === name)?.key ?? "";
    expect([hues.bySection.get(key("Design")), hues.bySection.get(key("Build"))]).toEqual(["var(--note-color-green)", "var(--series-4)"]);
  });

  it("sets a phase colour from its row, saves it, and repaints its label and bars", () => {
    const e = open();
    const before = e.byLabel<HTMLSelectElement>("Colour of phase Design").value;
    e.change(e.byLabel("Colour of phase Design"), "pink");
    const label = [...e.dialog.querySelectorAll<SVGTextElement>(".ge-section-label")].find((node) => node.textContent === "Design");
    const bar = e.bar("Visual design").querySelector<SVGElement>(".ge-shape");
    e.press("Save");
    expect([before, label?.style.fill, bar?.style.stroke, e.saved[0]?.split("\n")[3]])
      .toEqual(["", "var(--note-color-pink)", "var(--note-color-pink)", "    %% section-color pink Design"]);
  });

  it("gives a phase no colour: no band, the name in the text colour, plain bars", () => {
    const e = open();
    e.change(e.byLabel("Colour of phase Design"), "none");
    const label = [...e.dialog.querySelectorAll<SVGTextElement>(".ge-section-label")].find((node) => node.textContent === "Design");
    const bar = e.bar("Visual design").querySelector<SVGElement>(".ge-shape");
    e.press("Save");
    expect([label?.style.fill, e.dialog.querySelector(".ge-phase-band"), bar?.style.stroke, e.saved[0]?.split("\n")[3]])
      .toEqual(["", null, "var(--text-muted)", "    %% section-color none Design"]);
  });

  it("returns a phase to its automatic colour with Auto", () => {
    const e = open({ source: CHART.replace("    section Design", "    %% section-color #ff0000 Design\n    section Design") });
    const shown = e.byLabel<HTMLSelectElement>("Colour of phase Design").value;
    e.change(e.byLabel("Colour of phase Design"), "");
    e.press("Save");
    expect([shown, e.saved[0]?.includes("section-color")]).toEqual(["custom", false]);
  });
});

describe("chart style", () => {
  const pressed = (e: ReturnType<typeof open>, label: string): string =>
    e.byLabel(label).querySelector('[aria-pressed="true"]')?.getAttribute("data-value") ?? "";
  const choose = (e: ReturnType<typeof open>, label: string, value: string): void => {
    e.byLabel(label).querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.click();
  };

  it("shows the chart's options and saves a change as an option line", () => {
    const e = open({ source: CHART.replace("    section Design", "    %% option rows zoomed\n    section Design") });
    const shown = ["Phase names", "Phase colour", "Row height"].map((label) => pressed(e, label));
    choose(e, "Phase names", "row");
    e.press("Save");
    expect([shown, e.saved[0]?.split("\n").filter((line) => line.includes("option"))])
      .toEqual([["column", "whole", "zoomed"], ["    %% option rows zoomed", "    %% option phases row"]]);
  });

  it("keeps the style settings behind the Style button, and Escape closes them before the editor", () => {
    const e = open();
    const panel = e.byLabel("Chart style");
    const hiddenAtFirst = panel.hidden;
    e.press("Style");
    const shown = !panel.hidden;
    e.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect([hiddenAtFirst, shown, panel.hidden, e.dialog.open, document.activeElement?.textContent]).toEqual([true, true, true, true, "Style"]);
  });

  it("closes the style panel on a click elsewhere in the editor, but not on one inside it", () => {
    const e = open();
    e.press("Style");
    const panel = e.byLabel("Chart style");
    panel.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    const afterInside = panel.hidden;
    e.byLabel("Chart title").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect([afterInside, panel.hidden]).toEqual([false, true]);
  });

  it("carries a phase's colour down its tasks when the whole phase is coloured", () => {
    const e = open();
    // Two tasks, and the room opposite the phase's add row.
    expect(e.dialog.querySelectorAll(".ge-phase-body").length).toBe(3);
  });

  it("colours only the phase's header, outlined, when only its name is coloured", () => {
    const e = open();
    choose(e, "Phase colour", "name");
    const header = e.dialog.querySelector<SVGRectElement>(".ge-phase-band");
    expect([e.dialog.querySelectorAll(".ge-phase-body").length, header?.classList.contains("ge-phase-outline"), header?.style.stroke]).toEqual([0, true, "var(--series-2)"]);
  });

  it("disables the Style button for a chart that can only be edited as text", () => {
    const e = open({ source: "gantt\n    dateFormat DD-MM-YYYY\n    T :01-11-2026, 2d" });
    expect(e.dialog.querySelector<HTMLButtonElement>(".ge-style-button")?.disabled).toBe(true);
  });
});

describe("layout", () => {
  it("puts the chart above the tasks by default, with a divider between", () => {
    const e = open();
    const children = [...(e.dialog.querySelector(".ge-body")?.children ?? [])].map((node) => node.className);
    expect([e.dialog.dataset["layout"], children]).toEqual(["stacked", ["ge-timeline-wrap", "ge-divider", "ge-table-wrap"]]);
  });

  it("switches to side by side and remembers it for the next chart", () => {
    const e = open();
    e.press("Side by side");
    const children = [...(e.dialog.querySelector(".ge-body")?.children ?? [])].map((node) => node.className);
    e.handle.close();
    const next = open();
    expect([children, next.dialog.dataset["layout"]]).toEqual([["ge-table-wrap", "ge-timeline-wrap"], "side"]);
  });

  it("falls back to the stacked layout when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const e = open();
    e.press("Side by side");
    expect(e.dialog.dataset["layout"]).toBe("side");
  });

  it("resizes the panes from the keyboard, within bounds", () => {
    const e = open();
    const divider = e.byLabel("Resize chart and tasks");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const grown = [divider.getAttribute("aria-valuenow"), e.dialog.querySelector<HTMLElement>(".ge-body")?.style.gridTemplateRows];
    for (let n = 0; n < 20; n += 1) divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect([grown, divider.getAttribute("aria-valuenow")]).toEqual([["60", "minmax(0, 60fr) auto minmax(0, 40fr)"], "20"]);
  });

  it("marks the focused task's bar and row together", () => {
    const e = open();
    e.byLabel("Name of Visual design").focus();
    const marked = [...e.dialog.querySelectorAll("[data-current]")].map((node) => node.tagName.toLowerCase());
    e.bar("Wireframes").focus();
    const moved = [...e.dialog.querySelectorAll("[data-current]")].map((node) => node.getAttribute("data-key") === e.bar("Wireframes").getAttribute("data-key"));
    expect([marked.sort(), moved]).toEqual([["g", "tr"], [true, true]]);
  });
});

describe("fittingZoom", () => {
  it("picks days, weeks or months by the chart's span", () => {
    expect([fittingZoom({ start: 0, end: 20 }), fittingZoom({ start: 0, end: 90 }), fittingZoom({ start: 0, end: 400 })]).toEqual(["days", "weeks", "months"]);
  });
});

describe("long task names", () => {
  it("shortens a name that does not fit its bar, and keeps the full name for hover", () => {
    const e = open({ source: CHART.replace("Visual design :vd", "Visual design for every landing page and email :vd") });
    const group = e.bar("Visual design for every landing page and email");
    const label = group.querySelector(".ge-bar-label");
    expect([label?.textContent?.endsWith("…"), label?.getAttribute("data-shortened"), group.querySelector(":scope > title")?.textContent])
      .toEqual([true, "true", "Visual design for every landing page and email"]);
  });
});

describe("adding a task at the end of a phase", () => {
  const PHASES = [
    "gantt", "    dateFormat YYYY-MM-DD",
    "    Kick-off :ko, 2026-11-01, 1d",
    "    section Design", "    Wireframes :wf, 2026-11-02, 5d",
    "    section Empty",
    "    section Build", "    Frontend :fe, after wf, 4d",
  ].join("\n");
  const addButtons = (e: ReturnType<typeof open>) => [...e.dialog.querySelectorAll<HTMLButtonElement>(".ge-add-task")].map((node) => node.getAttribute("aria-label"));

  it("closes every phase, and the tasks above the first one, with a thin add row", () => {
    const e = open({ source: PHASES });
    expect(addButtons(e)).toEqual(["Add a task", "Add a task to Design", "Add a task to Empty", "Add a task to Build"]);
  });

  it("adds a task as the last one of that phase, starting when its last task ends, ready to name", () => {
    const e = open({ source: PHASES });
    e.byLabel<HTMLButtonElement>("Add a task to Design").click();
    const focused = document.activeElement as HTMLInputElement | null;
    e.press("Save");
    const lines = e.saved[0]?.split("\n") ?? [];
    expect([focused?.value, lines.indexOf("    section Empty") - lines.indexOf("    New task :2026-11-07, 5d")]).toEqual(["New task", 1]);
  });

  it("adds a task into an empty phase", () => {
    const e = open({ source: PHASES });
    e.byLabel<HTMLButtonElement>("Add a task to Empty").click();
    e.press("Save");
    const lines = e.saved[0]?.split("\n") ?? [];
    expect(lines.indexOf("    section Empty") + 1).toBe(lines.findIndex((line) => line.startsWith("    New task :")));
  });

  it("leaves the timeline the same room, so its rows still line up with the table's", () => {
    const e = open({ source: PHASES });
    const labelY = (name: string) => Number([...e.dialog.querySelectorAll(".ge-section-label")].find((node) => node.textContent === name)?.getAttribute("y"));
    // Kick-off and its add row, then Design's header row: 40 + 48 + 30.
    expect([labelY("Design"), labelY("Empty") - labelY("Design")]).toEqual([40 + 48 + 30 + 29, 48 + 48 + 30]);
  });
});
