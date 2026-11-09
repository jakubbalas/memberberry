// @vitest-environment jsdom
import type { MermaidConfig } from "mermaid";
import { describe, expect, it } from "vitest";

import { PHASE_COLOURS } from "../gantt/colors.js";
import { configFor, createMermaidRenderer, GANTT_CSS, ganttLayout, layoutWidth, MIN_DIAGRAM_WIDTH, phaseBands, thinLabels, type MermaidApi } from "./renderer.js";

const SVG = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`;

interface Fake extends MermaidApi {
  readonly configs: MermaidConfig[];
  readonly sources: string[];
  overlapped: boolean;
}

function fakeMermaid(behaviour: (source: string) => Promise<string> = (s) => Promise.resolve(SVG(s))): Fake {
  let inFlight = false;
  const fake: Fake = {
    configs: [],
    sources: [],
    overlapped: false,
    initialize(config) { fake.configs.push(config); },
    async render(_id, text) {
      if (inFlight) fake.overlapped = true;
      inFlight = true;
      fake.sources.push(text);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { svg: await behaviour(text) };
      } finally {
        inFlight = false;
      }
    },
  };
  return fake;
}

describe("createMermaidRenderer", () => {
  it("does not load Mermaid until something is rendered", async () => {
    let loads = 0;
    const renderer = createMermaidRenderer({ load: () => { loads += 1; return Promise.resolve(fakeMermaid()); } });
    const before = loads;
    await renderer.render("gantt", {});
    expect([before, loads]).toEqual([0, 1]);
  });

  it("returns sanitized SVG for a successful render", async () => {
    const fake = fakeMermaid(() => Promise.resolve(`<svg xmlns="http://www.w3.org/2000/svg"><script>x</script><text>ok</text></svg>`));
    const outcome = await createMermaidRenderer({ load: () => Promise.resolve(fake) }).render("gantt", {});
    expect(outcome.kind === "ok" && !outcome.svg.includes("script") && outcome.svg.includes("ok")).toBe(true);
  });

  it("configures strict security, SVG labels and no error bomb before every render", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    await renderer.render("a", { taskBorderColor: "#123456" });
    await renderer.render("b", { taskBorderColor: "#654321" });
    expect(fake.configs.map((c) => [c.securityLevel, c.htmlLabels, c.suppressErrorRendering, c.themeVariables?.["taskBorderColor"]]))
      .toEqual([["strict", false, true, "#123456"], ["strict", false, true, "#654321"]]);
  });

  it("serves a repeated source and theme from the cache", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    const first = await renderer.render("gantt", { a: "#000000" });
    const second = await renderer.render("gantt", { a: "#000000" });
    expect([fake.sources.length, second]).toEqual([1, first]);
  });

  it("renders again when only the theme changed", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    await renderer.render("gantt", { a: "#000000" });
    await renderer.render("gantt", { a: "#ffffff" });
    expect(fake.sources).toEqual(["gantt", "gantt"]);
  });

  it("returns a syntax error as a value and caches it", async () => {
    const fake = fakeMermaid(() => Promise.reject(new Error("Parse error on line 2")));
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    const outcome = await renderer.render("gantt\n  oops", {});
    await renderer.render("gantt\n  oops", {});
    expect([outcome, fake.sources.length]).toEqual([{ kind: "error", message: "Parse error on line 2" }, 1]);
  });

  it("reports a renderer that failed to load, and tries again next time", async () => {
    let attempts = 0;
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(fake);
    } });
    const first = await renderer.render("gantt", {});
    const second = await renderer.render("gantt", {});
    expect([first.kind, second.kind, attempts]).toEqual(["error", "ok", 2]);
  });

  it("never runs two renders at once", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    await Promise.all(["a", "b", "c", "d"].map((source) => renderer.render(source, {})));
    expect([fake.overlapped, fake.sources]).toEqual([false, ["a", "b", "c", "d"]]);
  });

  it("keeps rendering after one render throws something that is not an Error", async () => {
    const fake = fakeMermaid((s) => (s === "bad" ? Promise.reject(42) : Promise.resolve(SVG(s))));
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    const [bad, good] = await Promise.all([renderer.render("bad", {}), renderer.render("good", {})]);
    expect([bad, good.kind]).toEqual([{ kind: "error", message: "The diagram could not be drawn." }, "ok"]);
  });

  it("evicts the least recently used outcome beyond its capacity", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake), capacity: 2 });
    for (const source of ["a", "b", "a", "c", "a", "b"]) await renderer.render(source, {});
    expect(fake.sources).toEqual(["a", "b", "c", "b"]);
  });

  it("reports SVG the sanitizer will not accept as an error", async () => {
    const fake = fakeMermaid(() => Promise.resolve("<div>not svg</div>"));
    const outcome = await createMermaidRenderer({ load: () => Promise.resolve(fake) }).render("x", {});
    expect(outcome.kind).toBe("error");
  });
});

describe("layout width", () => {
  it("lays a Gantt chart out at the width it is shown at, never narrower than its axis needs", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    await renderer.render("a", {}, 905);
    await renderer.render("b", {}, 320);
    await renderer.render("c", {}, Number.NaN);
    expect(fake.configs.map((c) => [c.gantt?.useWidth, c.gantt?.useMaxWidth]))
      .toEqual([[MIN_DIAGRAM_WIDTH + 280, false], [MIN_DIAGRAM_WIDTH, false], [MIN_DIAGRAM_WIDTH, false]]);
  });

  it("re-renders at a new width but reuses a render for a nearly equal one", async () => {
    const fake = fakeMermaid();
    const renderer = createMermaidRenderer({ load: () => Promise.resolve(fake) });
    for (const width of [800, 810, 1000]) await renderer.render("gantt", {}, width);
    expect(fake.sources).toHaveLength(2);
  });

  it("defaults the Gantt axis to a short date a diagram can override", async () => {
    const fake = fakeMermaid();
    await createMermaidRenderer({ load: () => Promise.resolve(fake) }).render("gantt", {});
    expect(fake.configs[0]?.gantt?.axisFormat).toBe("%e %b");
  });

  it("rounds to 40px steps", () => {
    expect([layoutWidth(919), layoutWidth(921), layoutWidth(-50)]).toEqual([920, 920, MIN_DIAGRAM_WIDTH]);
  });
});

describe("configFor", () => {
  it("uses the theme's font for the whole diagram when the tokens give one", () => {
    expect([configFor({ fontFamily: "Inter" }).fontFamily, "fontFamily" in configFor({})]).toEqual(["Inter", false]);
  });
});

describe("ganttLayout", () => {
  it("sizes the left margin from the longest phase name, within bounds", () => {
    const short = ganttLayout("gantt\n  section A\n  T :1d");
    const long = ganttLayout("gantt\n  section Discovery & research\n  section Build");
    const huge = ganttLayout(`gantt\n  section ${"x".repeat(200)}`);
    expect([short.leftPadding, long.leftPadding, huge.leftPadding]).toEqual([80, 180, 280]);
  });

  it("counts characters, not UTF-16 units, for a phase name with emoji", () => {
    expect(ganttLayout("gantt\n  section 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀").leftPadding).toBe(150);
  });

  it("grows the rows and text for tall rows", () => {
    const fixed = ganttLayout("gantt\n  section A");
    const tall = ganttLayout("gantt\n  %% option rows zoomed\n  section A");
    expect([tall.barHeight > fixed.barHeight, tall.fontSize > fixed.fontSize, tall.sectionFontSize > fixed.sectionFontSize]).toEqual([true, true, true]);
  });

  it("drops the name column when phases are rows", () => {
    expect(ganttLayout("gantt\n  %% option phases row\n  section Discovery & research").leftPadding).toBeLessThan(ganttLayout("gantt\n  section A").leftPadding);
  });

  it("adds larger text to the chart's CSS only for tall rows", () => {
    const tall = configFor({}, MIN_DIAGRAM_WIDTH, "gantt\n  %% option rows zoomed").themeCSS ?? "";
    expect([configFor({}, MIN_DIAGRAM_WIDTH, "gantt").themeCSS, tall.startsWith(GANTT_CSS), tall.length > GANTT_CSS.length]).toEqual([GANTT_CSS, true, true]);
  });

  it("reaches Mermaid through configFor", async () => {
    const fake = fakeMermaid();
    await createMermaidRenderer({ load: () => Promise.resolve(fake) }).render("gantt\n  section Discovery & research", {});
    expect([fake.configs[0]?.gantt?.leftPadding, fake.configs[0]?.themeCSS]).toEqual([180, GANTT_CSS]);
  });
});

describe("GANTT_CSS", () => {
  it("styles with design tokens only", () => {
    const colours = [...GANTT_CSS.matchAll(/(?:fill|stroke):\s*([^;]+);/gu)].map((match) => match[1]?.trim() ?? "");
    const token = /^var\(--[a-z0-9-]+\)$/u;
    const mix = /^color-mix\(in srgb, var\(--[a-z0-9-]+\) \d+%, var\(--surface-note\)\)$/u;
    expect(colours.filter((value) => !(value === "none" || value === "transparent" || token.test(value) || mix.test(value)))).toEqual([]);
  });

  it("gives every phase style a band, a name colour and bar colours", () => {
    expect(PHASE_COLOURS.map((_colour, n) => [`.section${String(n)} `, `.sectionTitle${String(n)} `, `.task${String(n)} `, `.active${String(n)} `, `.done${String(n)} `].every((rule) => GANTT_CSS.includes(rule)))).toEqual(PHASE_COLOURS.map(() => true));
  });
});

describe("thinLabels", () => {
  it("keeps a label only when it clears the last one kept", () => {
    const boxes = [0, 30, 60, 90, 120].map((left) => ({ left, right: left + 40 }));
    expect(thinLabels(boxes)).toEqual([true, false, true, false, true]);
  });

  it("keeps everything when nothing is laid out (zero-width boxes)", () => {
    expect(thinLabels([{ left: 0, right: 0 }, { left: 0, right: 0 }])).toEqual([true, true]);
  });
});

describe("phaseBands", () => {
  it("groups consecutive rows of one phase, in position order", () => {
    const rows = [
      { top: 60, bottom: 90, style: 1 },
      { top: 0, bottom: 30, style: 0 },
      { top: 30, bottom: 60, style: 0 },
      { top: 90, bottom: 120, style: 1 },
      { top: 120, bottom: 150, style: 0 },
    ];
    expect(phaseBands(rows)).toEqual([
      { top: 0, bottom: 60, style: 0 },
      { top: 60, bottom: 120, style: 1 },
      { top: 120, bottom: 150, style: 0 },
    ]);
  });

  it("is empty for a chart without phases", () => {
    expect(phaseBands([])).toEqual([]);
  });
});
