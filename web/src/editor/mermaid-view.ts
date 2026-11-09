/**
 * Mermaid diagrams in the editor (SPEC §13.2, A38).
 *
 * A diagram is an ordinary ` ```mermaid ` code block. This view adds a rendered preview above
 * the block's own text and hides that text until the caret enters it, so the file and the
 * CRDT see nothing new. Every other code block keeps the schema's own rendering.
 *
 * Which block is "being edited" is a decoration from the selection, not view state, so it
 * needs no bookkeeping across remote edits.
 */

import { Extension } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";

import { chartOptions, colorHue, colorStyle, drawnPhases, sectionColors, taskColors, tint } from "../gantt/colors.js";
import { ganttLayout, PHASE_HEADER_PX, phaseBands, sharedMermaidRenderer, thinLabels, type MermaidOutcome, type MermaidRenderer } from "../mermaid/renderer.js";
import { createChartViewer, type ChartViewer } from "../mermaid/chart-viewer.js";
import { revealFullText, shortenLabels } from "../mermaid/labels.js";
import { svgElement } from "../mermaid/sanitize.js";
import { mermaidThemeVariables } from "../mermaid/theme.js";
import { THEME_CHANGE_EVENT } from "../shell/theme.js";
import "../mermaid/mermaid.css";

/** How long typing must pause before the preview re-renders. */
export const MERMAID_RENDER_DELAY_MS = 400;

/** True for a code block whose info string names Mermaid. */
export function isMermaidBlock(node: PMNode | null | undefined): node is PMNode {
  if (node?.type.name !== "code_block") return false;
  const lang = node.attrs["lang"];
  return typeof lang === "string" && lang.trim().toLowerCase() === "mermaid";
}

export interface MermaidViewOptions {
  readonly renderer?: MermaidRenderer;
  /** Defaults to the tokens on the document root. */
  readonly theme?: () => Readonly<Record<string, string>>;
  readonly delayMs?: number;
}

const key = new PluginKey("memberberryMermaidView");

/**
 * Transaction meta for a deliberate move into a diagram's code: Edit code, an arrow key from
 * the adjacent block, a newly inserted chart, or Edit as text. Any other way the caret lands
 * there (a note opening, a collaborator's edit) is moved back out (SPEC §13.2).
 */
export const MERMAID_ENTER = "memberberryMermaidEnter";

/** True when a Mermaid source is a Gantt chart: its first statement is `gantt` (§13.3). */
export function isGanttSource(text: string): boolean {
  const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "" && !line.startsWith("%%"));
  return first !== undefined && /^gantt\b/iu.test(first);
}

type Tracked = ReadonlyMap<string, number>;
interface TrackMeta { readonly add?: readonly [string, number]; readonly remove?: string }
const trackKey = new PluginKey<Tracked>("memberberryGanttTrack");
let trackers = 0;

/**
 * Block positions followed through every transaction while a chart editor is open.
 *
 * why: collaborators keep editing while the dialog is up. A position captured at open would
 * point at the wrong place once text above the chart changed, so Save would write elsewhere.
 */
const trackPlugin = new Plugin<Tracked>({
  key: trackKey,
  state: {
    init: () => new Map<string, number>(),
    apply(tr, tracked) {
      let next = tracked;
      if (tr.docChanged && tracked.size > 0) next = new Map([...tracked].map(([id, pos]) => [id, tr.mapping.map(pos, 1)]));
      const meta = tr.getMeta(trackKey) as TrackMeta | undefined;
      if (meta?.add !== undefined) next = new Map(next).set(meta.add[0], meta.add[1]);
      if (meta?.remove !== undefined && next.has(meta.remove)) {
        const copy = new Map(next);
        copy.delete(meta.remove);
        next = copy;
      }
      return next;
    },
  },
});

/** The Mermaid block a tracker follows, or `undefined` once it is gone. */
function trackedBlock(view: EditorView, id: string): { readonly pos: number; readonly node: PMNode } | undefined {
  const pos = trackKey.getState(view.state)?.get(id);
  if (pos === undefined) return undefined;
  const node = view.state.doc.nodeAt(pos);
  return isMermaidBlock(node) ? { pos, node } : undefined;
}

/**
 * Opens the visual Gantt editor on the Mermaid block at `pos` (SPEC §13.3). Save replaces the
 * block's text in one transaction: one undo step, synced like any other edit.
 */
export async function editGanttAt(view: EditorView, pos: number, returnFocus?: HTMLElement): Promise<void> {
  const node = view.state.doc.nodeAt(pos);
  if (!isMermaidBlock(node) || !view.editable) return;
  trackers += 1;
  const id = `gantt-${trackers}`;
  const add: TrackMeta = { add: [id, pos] };
  view.dispatch(view.state.tr.setMeta(trackKey, add).setMeta("addToHistory", false));
  const untrack = (): void => {
    if (view.isDestroyed) return;
    const remove: TrackMeta = { remove: id };
    view.dispatch(view.state.tr.setMeta(trackKey, remove).setMeta("addToHistory", false));
  };
  let loaded: typeof import("../gantt/gantt-editor.js");
  try {
    loaded = await import("../gantt/gantt-editor.js");
  } catch {
    untrack();
    return;
  }
  const opened = trackedBlock(view, id);
  if (opened === undefined || view.isDestroyed) { untrack(); return; }
  loaded.openGanttEditor({
    source: opened.node.textContent,
    host: view.dom.ownerDocument.body,
    current: () => trackedBlock(view, id)?.node.textContent ?? "",
    onSave: (text) => {
      const block = trackedBlock(view, id);
      if (block === undefined || !view.editable) return;
      const from = block.pos + 1;
      const to = block.pos + block.node.nodeSize - 1;
      const content = text === "" ? Fragment.empty : Fragment.from(view.state.schema.text(text));
      view.dispatch(view.state.tr.replaceWith(from, to, content));
    },
    onEditAsText: () => {
      const block = trackedBlock(view, id);
      if (block === undefined) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, block.pos + block.node.nodeSize - 1)).setMeta(MERMAID_ENTER, true).scrollIntoView());
      view.focus();
    },
    onClose: () => {
      untrack();
      if (returnFocus?.isConnected === true) returnFocus.focus();
      else view.focus();
    },
  });
}

interface EditingSpec { readonly mermaidEditing: true }

class MermaidBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  /** Shows a shortened chart label's full text (SPEC §13.2). */
  private readonly tip: HTMLElement;
  /** Zooming and moving around a Gantt chart (SPEC §13.2). */
  private readonly viewer: ChartViewer;
  private readonly toggle: HTMLButtonElement;
  private readonly chartButton: HTMLButtonElement;
  private readonly root: HTMLElement;
  private node: PMNode;
  private editing = false;
  private sourceOpen = false;
  private visible = false;
  private destroyed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observer: IntersectionObserver | undefined;
  private readonly onTheme = (): void => { this.renderNow(); };

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    decorations: readonly Decoration[],
    private readonly options: Required<MermaidViewOptions>,
  ) {
    this.node = node;
    const document = view.dom.ownerDocument;
    this.root = document.documentElement;
    this.dom = document.createElement("div");
    this.dom.className = "mb-mermaid";

    const chrome = document.createElement("div");
    chrome.className = "mb-mermaid-chrome";
    chrome.contentEditable = "false";
    this.preview = document.createElement("div");
    this.preview.className = "mb-mermaid-preview";
    this.preview.setAttribute("role", "img");
    this.preview.setAttribute("aria-label", "Mermaid diagram");
    // why: a click on the diagram is not a request to edit it (the user's choice): only Edit
    // code opens the code. preventDefault keeps the caret where it was, and stopEvent below
    // keeps ProseMirror from placing it inside the block from the click.
    this.preview.addEventListener("mousedown", (event) => { event.preventDefault(); });
    // A double-click on a Gantt chart opens the visual editor (§13.3); Edit chart is the
    // keyboard way to the same place.
    this.preview.addEventListener("dblclick", (event) => {
      if (!this.view.editable || !isGanttSource(this.node.textContent)) return;
      event.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) void editGanttAt(this.view, pos, this.chartButton);
    });
    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "mb-mermaid-toggle";
    this.toggle.addEventListener("mousedown", (event) => { event.preventDefault(); });
    this.toggle.addEventListener("click", (event) => {
      event.preventDefault();
      this.onToggle();
    });
    this.chartButton = document.createElement("button");
    this.chartButton.type = "button";
    this.chartButton.className = "mb-mermaid-chart";
    this.chartButton.textContent = "Edit chart";
    this.chartButton.addEventListener("mousedown", (event) => { event.preventDefault(); });
    this.chartButton.addEventListener("click", (event) => {
      event.preventDefault();
      const pos = this.getPos();
      if (pos !== undefined) void editGanttAt(this.view, pos, this.chartButton);
    });
    const actions = document.createElement("div");
    actions.className = "mb-mermaid-actions";
    this.viewer = createChartViewer({ preview: this.preview, onZoom: (svg) => { thinAxis(svg, true); } });
    actions.append(this.viewer.controls, this.chartButton, this.toggle);
    this.tip = document.createElement("div");
    this.tip.className = "mb-mermaid-tip";
    this.tip.setAttribute("role", "tooltip");
    this.tip.hidden = true;
    chrome.append(this.preview, this.tip, actions);

    const pre = document.createElement("pre");
    pre.className = "mb-mermaid-source";
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(chrome, pre);

    this.setEditing(isEditing(decorations));
    this.root.addEventListener(THEME_CHANGE_EVENT, this.onTheme);
    this.watchVisibility();
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (!isMermaidBlock(node)) return false;
    const changed = node.textContent !== this.node.textContent;
    this.node = node;
    this.setEditing(isEditing(decorations));
    if (changed) this.schedule();
    return true;
  }

  ignoreMutation(mutation: ViewMutationLike): boolean {
    // why: the preview and toggle are ours; only the source text is ProseMirror's.
    return !this.contentDOM.contains(mutation.target);
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node
      && (this.toggle.contains(event.target) || this.chartButton.contains(event.target) || this.preview.contains(event.target));
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.root.removeEventListener(THEME_CHANGE_EVENT, this.onTheme);
  }

  private watchVisibility(): void {
    const Observer = this.view.dom.ownerDocument.defaultView?.IntersectionObserver;
    if (Observer === undefined) {
      this.visible = true;
      this.renderNow();
      return;
    }
    this.setStatus("Diagram renders when it scrolls into view.");
    this.observer = new Observer((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      this.observer?.disconnect();
      this.observer = undefined;
      this.visible = true;
      this.renderNow();
    }, { rootMargin: "200px" });
    this.observer.observe(this.dom);
  }

  private schedule(): void {
    if (!this.visible) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.renderNow();
    }, this.options.delayMs);
  }

  private renderNow(): void {
    if (this.destroyed || !this.visible) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const source = this.node.textContent;
    const generation = ++this.generation;
    if (source.trim() === "") {
      this.showOutcome({ kind: "error", message: "This diagram is empty." });
      return;
    }
    this.dom.dataset["mermaidState"] = "rendering";
    void this.options.renderer.render(source, this.options.theme(), this.contentWidth()).then((outcome) => {
      if (this.destroyed || generation !== this.generation) return;
      this.showOutcome(outcome);
    });
  }

  /** The preview's width inside its padding, which is what the diagram is laid out into. */
  private contentWidth(): number {
    const style = this.dom.ownerDocument.defaultView?.getComputedStyle(this.preview);
    const padding = (Number.parseFloat(style?.paddingLeft ?? "") || 0) + (Number.parseFloat(style?.paddingRight ?? "") || 0);
    return this.preview.clientWidth - padding;
  }

  private showOutcome(outcome: MermaidOutcome): void {
    if (outcome.kind === "ok") {
      const svg = svgElement(outcome.svg, this.dom.ownerDocument);
      if (svg !== undefined) {
        paintTasks(svg, this.node.textContent);
        markPhases(svg, this.node.textContent);
        this.preview.replaceChildren(svg);
        thinAxis(svg);
        this.tip.hidden = true;
        const gantt = isGanttSource(this.node.textContent);
        const height = gantt ? chartOptions(this.node.textContent).height : "full";
        if (height === "full") delete this.preview.dataset["maxHeight"];
        else this.preview.dataset["maxHeight"] = height;
        this.viewer.attach(gantt ? svg : null);
        if (gantt) {
          const shortened = shortenLabels(svg, chartOptions(this.node.textContent).phases === "row");
          if (shortened.length > 0) revealFullText(shortened, svg, this.tip, this.tip.parentElement ?? this.dom);
        }
        this.dom.dataset["mermaidState"] = "ready";
        return;
      }
      outcome = { kind: "error", message: "The diagram renderer produced no picture." };
    }
    this.setStatus(outcome.message, "mb-mermaid-error");
    this.dom.dataset["mermaidState"] = "error";
  }

  private setStatus(text: string, className = "mb-mermaid-status"): void {
    const message = this.dom.ownerDocument.createElement("p");
    message.className = className;
    message.textContent = text;
    this.preview.replaceChildren(message);
  }

  private setEditing(editing: boolean): void {
    this.editing = editing;
    this.dom.classList.toggle("mb-mermaid-editing", editing);
    this.syncToggle();
  }

  private syncToggle(): void {
    const editable = this.view.editable;
    const open = editable ? this.editing : this.sourceOpen;
    this.dom.classList.toggle("mb-mermaid-source-open", open);
    this.toggle.textContent = editable ? (open ? "Done" : "Edit code") : (open ? "Hide code" : "Show code");
    this.toggle.setAttribute("aria-expanded", String(open));
    this.chartButton.hidden = !editable || !isGanttSource(this.node.textContent);
  }

  private onToggle(): void {
    if (!this.view.editable) {
      this.sourceOpen = !this.sourceOpen;
      this.syncToggle();
      return;
    }
    if (this.editing) leaveSource(this.view, this.getPos());
    else this.enterSource();
  }

  private enterSource(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const end = pos + this.node.nodeSize - 1;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, end)).setMeta(MERMAID_ENTER, true));
    this.view.focus();
  }
}

/**
 * Colours a rendered Gantt chart's task bars from its `%% color` lines (A40). Mermaid names
 * each task's bar `<diagram id>-<task id>`, so the match is exact. Values were validated by
 * `parseColor`, so they are safe in a style attribute.
 */
function paintTasks(svg: Element, source: string): void {
  const colors = taskColors(source);
  if (colors.size === 0 || svg.id === "") return;
  for (const [id, color] of colors) {
    const bar = svg.querySelector<SVGElement>(`rect#${CSS.escape(`${svg.id}-${id}`)}`);
    if (bar === null) continue;
    const style = colorStyle(color);
    bar.style.fill = style.fill;
    bar.style.stroke = style.stroke;
  }
}

type Span = { readonly top: number; readonly bottom: number };

/**
 * Marks each phase of a rendered Gantt chart (SPEC §13.2, §13.3): its colour, a stripe down its
 * left edge and a line where it starts, then the chart style from its `%% option` lines. Mermaid
 * draws one band per task row, so phases are found by grouping consecutive rows with the same
 * style number.
 */
export function markPhases(svg: Element, source: string): void {
  const rows = [...svg.querySelectorAll<SVGRectElement>("rect.section")];
  const first = rows[0];
  if (first === undefined) return;
  const width = Number(first.getAttribute("width") ?? "0");
  const phases = phaseBands(rows.map((row) => {
    const top = Number(row.getAttribute("y") ?? "0");
    const style = Number(/\bsection(\d+)\b/u.exec(row.getAttribute("class") ?? "")?.[1] ?? "0");
    return { top, bottom: top + Number(row.getAttribute("height") ?? "0"), style };
  }));
  const layer = first.parentNode;
  if (layer === null) return;
  const options = chartOptions(source);
  const asRows = options.phases === "row";
  const nameOnly = options.phaseFill === "name";
  const header = asRows ? PHASE_HEADER_PX[options.rows] : 0;
  const names = drawnPhases(source);
  const custom = sectionColors(source);
  const within = (node: Element, phase: Span): boolean => {
    const middle = Number(node.getAttribute("y") ?? "NaN") + Number(node.getAttribute("height") ?? "0") / 2;
    return middle >= phase.top && middle < phase.bottom;
  };
  const owns = phases.map((phase, index) => {
    const name = names[index];
    const own = name === undefined || name === null ? undefined : custom.get(name);
    if (own?.kind === "none") plainPhase(svg, phase, rows, within);
    else if (own !== undefined) paintPhase(svg, phase, colorHue(own), rows, within);
    return own;
  });
  // why: "name only" (SPEC §13.3) keeps the colour off the task rows; the name's own cell or
  // header row carries it instead.
  if (nameOnly) for (const row of rows) row.style.visibility = "hidden";
  if (asRows) phasesAsRows(svg, phases, header);
  const rect = (attributes: Readonly<Record<string, number>>, className: string): SVGRectElement => {
    const node = svg.ownerDocument.createElementNS(SVG_NS, "rect");
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    node.setAttribute("class", className);
    layer.appendChild(node);
    return node;
  };
  const leftPadding = ganttLayout(source).leftPadding;
  phases.forEach((phase, index) => {
    const own = owns[index];
    const hue = own === undefined ? null : colorHue(own);
    // Where the phase is after any header rows were inserted above it.
    const top = phase.top + index * header;
    const bottom = phase.bottom + (index + 1) * header;
    if (asRows || nameOnly) {
      // why: inset in a column, so neighbouring phases' outlines do not merge into one line.
      const cell = rect(asRows ? { x: 0, y: top, width, height: header } : { x: 1, y: top + 2, width: Math.max(0, leftPadding - 10), height: Math.max(0, bottom - top - 4) }, `mb-phase-name mb-phase-name${String(phase.style)}${nameOnly ? " mb-phase-outlined" : ""}`);
      // why: inline, like a phase's own colour, so it wins over the automatic colour's rules.
      if (own?.kind === "none") { cell.classList.add("mb-phase-name-plain"); cell.style.fill = "none"; cell.style.stroke = "none"; }
      else if (hue !== null) {
        cell.style.fill = tint(hue, 18);
        if (nameOnly) cell.style.stroke = hue;
      }
    }
    if (!nameOnly) {
      const stripe = rect({ x: 0, y: top, width: 4, height: bottom - top }, `mb-phase-stripe mb-phase-stripe${String(phase.style)}`);
      if (own?.kind === "none") stripe.style.display = "none";
      else if (hue !== null) stripe.style.fill = hue;
    }
    if (index === 0) return;
    const divider = svg.ownerDocument.createElementNS(SVG_NS, "line");
    for (const [name, value] of [["x1", 0], ["x2", width], ["y1", top], ["y2", top]] as const) divider.setAttribute(name, String(value));
    divider.setAttribute("class", "mb-phase-divider");
    layer.appendChild(divider);
  });
  // The names go on top of the cells drawn for them.
  const titles = svg.querySelector(".sectionTitle")?.parentNode;
  if (titles !== null && titles !== undefined) titles.parentNode?.appendChild(titles);
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Shows phases as rows (SPEC §13.3): opens a header row above each phase, moves its name into
 * it, and shifts everything below down. Mermaid has no such layout, so this rearranges what it
 * drew; positions come from Mermaid's own attributes, so no layout is needed.
 */
function phasesAsRows(svg: Element, phases: readonly Span[], header: number): void {
  const shiftOf = (y: number): number => {
    const index = phases.findIndex((phase) => y >= phase.top && y < phase.bottom);
    return index < 0 ? 0 : (index + 1) * header;
  };
  const move = (node: Element, attribute: string, by: number): void => {
    node.setAttribute(attribute, String(Number(node.getAttribute(attribute) ?? "0") + by));
  };
  const middle = (node: Element): number => Number(node.getAttribute("y") ?? "NaN") + Number(node.getAttribute("height") ?? "0") / 2;
  for (const node of svg.querySelectorAll("rect.section, rect.task")) {
    const by = shiftOf(middle(node));
    move(node, "y", by);
    // why: a milestone is a square turned about this point; it has to move with it.
    const origin = /^(\S+)\s+([\d.-]+)px$/u.exec(node.getAttribute("transform-origin") ?? "");
    if (origin !== null) node.setAttribute("transform-origin", `${origin[1] ?? "0"} ${String(Number(origin[2]) + by)}px`);
  }
  for (const node of svg.querySelectorAll('text[class*="taskText"]')) move(node, "y", shiftOf(Number(node.getAttribute("y") ?? "NaN")));
  for (const title of svg.querySelectorAll<SVGTextElement>(".sectionTitle")) {
    const index = phases.findIndex((phase) => { const y = Number(title.getAttribute("y") ?? "NaN"); return y >= phase.top && y < phase.bottom; });
    const phase = phases[index];
    if (phase === undefined) continue;
    title.setAttribute("y", String(phase.top + index * header + header / 2));
    for (const node of [title, ...title.querySelectorAll("tspan")]) node.setAttribute("x", "12");
  }
  const added = phases.length * header;
  for (const line of svg.querySelectorAll(".grid .tick line")) line.setAttribute("y2", String(Number(line.getAttribute("y2") ?? "0") - added));
  const grid = svg.querySelector(".grid");
  const at = /translate\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/u.exec(grid?.getAttribute("transform") ?? "");
  if (grid !== null && at !== null) grid.setAttribute("transform", `translate(${at[1] ?? "0"}, ${String(Number(at[2]) + added)})`);
  for (const line of svg.querySelectorAll("line.today")) move(line, "y2", added);
  for (const range of svg.querySelectorAll("rect.exclude-range")) move(range, "height", added);
  move(svg, "height", added);
  const box = (svg.getAttribute("viewBox") ?? "").split(/\s+/u).map(Number);
  if (box.length === 4 && box.every(Number.isFinite)) svg.setAttribute("viewBox", [box[0], box[1], box[2], (box[3] ?? 0) + added].join(" "));
}

/**
 * A phase's own colour (`%% section-color`, SPEC §13.3) over the automatic one: its bands, its
 * name and its bars, keeping each bar's state. A bar with its own task colour is left alone.
 */
function paintPhase(svg: Element, phase: Span, hue: string, rows: readonly SVGRectElement[], within: (node: Element, phase: Span) => boolean): void {
  for (const row of rows) if (within(row, phase)) row.style.fill = hue;
  for (const title of svg.querySelectorAll<SVGTextElement>(".sectionTitle")) {
    const y = Number(title.getAttribute("y") ?? "NaN");
    if (y >= phase.top && y < phase.bottom) title.style.fill = hue;
  }
  for (const bar of svg.querySelectorAll<SVGRectElement>("rect.task")) {
    if (bar.style.fill !== "" || !within(bar, phase)) continue;
    const classes = bar.getAttribute("class") ?? "";
    const done = /\bdone(?:Crit)?\d/u.test(classes);
    const active = /\bactive(?:Crit)?\d/u.test(classes);
    bar.style.fill = tint(hue, done ? 10 : active ? 45 : 24);
    if (!/crit\d/iu.test(classes)) bar.style.stroke = hue;
  }
}

/** A phase set to "No colour": no band, no stripe, the name in the text colour, plain bars. */
function plainPhase(svg: Element, phase: Span, rows: readonly SVGRectElement[], within: (node: Element, phase: Span) => boolean): void {
  for (const row of rows) if (within(row, phase)) row.style.fill = "transparent";
  for (const title of svg.querySelectorAll<SVGTextElement>(".sectionTitle")) {
    const y = Number(title.getAttribute("y") ?? "NaN");
    if (y >= phase.top && y < phase.bottom) title.style.fill = "var(--text-primary)";
  }
  const plain = colorStyle({ kind: "none" });
  for (const bar of svg.querySelectorAll<SVGRectElement>("rect.task")) {
    if (bar.style.fill !== "" || !within(bar, phase)) continue;
    bar.style.fill = plain.fill;
    if (!/crit\d/iu.test(bar.getAttribute("class") ?? "")) bar.style.stroke = plain.stroke;
  }
}

/** Hides date labels that would overlap the one before. Needs layout, so runs once inserted. */
function thinAxis(svg: Element, again = false): void {
  const labels = [...svg.querySelectorAll<SVGTextElement>(".grid .tick text")];
  // why: after a zoom, labels hidden at the old size may fit now, and others may not.
  if (again) for (const label of labels) label.style.display = "";
  const keep = thinLabels(labels.map((label) => {
    const box = label.getBoundingClientRect();
    return { left: box.left, right: box.right };
  }));
  labels.forEach((label, index) => { if (keep[index] === false) label.style.display = "none"; });
}

/** The subset of `MutationRecord` ProseMirror passes, typed loosely enough for selection records. */
interface ViewMutationLike { readonly target: Node }

function isEditing(decorations: readonly Decoration[]): boolean {
  return decorations.some((decoration) => (decoration.spec as Partial<EditingSpec>).mermaidEditing === true);
}

/** The Mermaid block containing the selection head, as its start position. */
function enclosingMermaid(state: EditorState): number | undefined {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    if (isMermaidBlock($head.node(depth))) return $head.before(depth);
  }
  return undefined;
}

function leaveSource(view: EditorView, pos: number | undefined): boolean {
  if (pos === undefined) return false;
  const node = view.state.doc.nodeAt(pos);
  if (!isMermaidBlock(node)) return false;
  view.dispatch((outOfDiagram(view.state.tr, pos, pos + node.nodeSize) ?? view.state.tr).scrollIntoView());
  view.focus();
  return true;
}

/**
 * Puts the caret in the nearest text outside the diagram at `from`..`to`: the next text, else
 * the text before it, else a new empty paragraph after it.
 *
 * why: `TextSelection.near` after the last block of a note searches backwards and lands back
 * inside the diagram's own code, so Done left the code open.
 */
function outOfDiagram(tr: Transaction, from: number, to: number, mayInsert = true): Transaction | null {
  const doc = tr.doc;
  const forward = Selection.findFrom(doc.resolve(Math.min(to, doc.content.size)), 1, true);
  if (forward !== null && forward.from >= to) return tr.setSelection(forward);
  const backward = Selection.findFrom(doc.resolve(from), -1, true);
  if (backward !== null && backward.to <= from) return tr.setSelection(backward);
  // why: opening a note must not edit it. Without text to move to, the caret stays put.
  if (!mayInsert) return null;
  const paragraph = doc.type.schema.nodes["paragraph"];
  const $to = doc.resolve(to);
  if (paragraph !== undefined && $to.parent.canReplaceWith($to.index(), $to.index(), paragraph)) {
    tr.insert(to, paragraph.create());
    return tr.setSelection(TextSelection.create(tr.doc, to + 1));
  }
  // why: last resort where no paragraph may follow: select the block itself, which is not
  // "inside" it, so the code still hides.
  return tr.setSelection(NodeSelection.create(doc, from));
}

/**
 * Arrow keys into a hidden source. The browser moves a caret past content it cannot see, so
 * an adjacent diagram would be unreachable from the keyboard (SPEC §8.4) without this.
 */
function arrowIntoDiagram(view: EditorView, event: KeyboardEvent): boolean {
  const down = event.key === "ArrowDown";
  if (!down && event.key !== "ArrowUp") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const { selection, doc } = view.state;
  if (!selection.empty || !selection.$head.parent.isTextblock || selection.$head.depth === 0) return false;
  const $head = selection.$head;
  const edge = down ? $head.after() : $head.before();
  const neighbour = down ? doc.resolve(edge).nodeAfter : doc.resolve(edge).nodeBefore;
  // why: the structural check first. endOfTextblock measures layout, so it runs only when a
  // diagram is actually adjacent.
  if (!isMermaidBlock(neighbour) || !view.endOfTextblock(down ? "down" : "up")) return false;
  const target = down ? edge + 1 : edge - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)).setMeta(MERMAID_ENTER, true).scrollIntoView());
  return true;
}

/**
 * Moves the caret back out of a diagram's code when it got there without asking: a note
 * opening with its first line inside a diagram, or a collaborator's edit moving it.
 *
 * why: the user's choice is that only Edit code opens the code (SPEC §13.2). Staying inside
 * the same block (typing, a remote edit while editing) is left alone.
 */
function keepOutOfDiagrams(transactions: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return null;
  if (transactions.some((tr) => tr.getMeta(MERMAID_ENTER) === true)) return null;
  const now = enclosingMermaid(newState);
  if (now === undefined) return null;
  let was = enclosingMermaid(oldState);
  for (const tr of transactions) if (was !== undefined) was = tr.mapping.map(was);
  if (was === now) return null;
  const node = newState.doc.nodeAt(now);
  if (node === null) return null;
  return outOfDiagram(newState.tr, now, now + node.nodeSize, false);
}

function editingDecorations(state: EditorState): DecorationSet {
  const pos = enclosingMermaid(state);
  if (pos === undefined) return DecorationSet.empty;
  const node = state.doc.nodeAt(pos);
  if (node === null) return DecorationSet.empty;
  const spec: EditingSpec = { mermaidEditing: true };
  return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, {}, spec)]);
}

/** Builds the code-block view for one node: Mermaid blocks get a preview, others do not. */
function codeBlockView(options: Required<MermaidViewOptions>) {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[]): NodeView => {
    if (isMermaidBlock(node)) return new MermaidBlockView(node, view, getPos, decorations, options);
    return plainCodeBlock(node, view);
  };
}

/** Exactly the schema's own rendering, recreated whenever the block's attributes change. */
function plainCodeBlock(node: PMNode, view: EditorView): NodeView {
  const toDOM = node.type.spec.toDOM;
  const rendered = toDOM === undefined
    ? { dom: view.dom.ownerDocument.createElement("pre") }
    : DOMSerializer.renderSpec(view.dom.ownerDocument, toDOM(node));
  return {
    dom: rendered.dom,
    ...(rendered.contentDOM === undefined ? {} : { contentDOM: rendered.contentDOM }),
    update: (next) => next.type === node.type && next.sameMarkup(node) && !isMermaidBlock(next),
  };
}

/** Mermaid previews for ` ```mermaid ` code blocks. Install at editor construction. */
export function mermaidViews(options: MermaidViewOptions = {}): Extension {
  const resolved: Required<MermaidViewOptions> = {
    renderer: options.renderer ?? sharedMermaidRenderer(),
    theme: options.theme ?? (() => mermaidThemeVariables(getComputedStyle(document.documentElement))),
    delayMs: options.delayMs ?? MERMAID_RENDER_DELAY_MS,
  };
  return Extension.create({
    name: "memberberryMermaidView",
    // why: last in line, so an open menu (link or emoji suggestions) keeps its arrow keys;
    // this handles them only when nothing else did. Escape is not bound: §8.4 gives it to
    // block selection, and leaving a diagram's source is moving the caret out, or Done.
    priority: 1,
    addProseMirrorPlugins() {
      return [trackPlugin, new Plugin({
        key,
        props: {
          decorations: editingDecorations,
          nodeViews: { code_block: codeBlockView(resolved) },
          handleKeyDown: arrowIntoDiagram,
        },
        appendTransaction: keepOutOfDiagrams,
      })];
    },
  });
}
