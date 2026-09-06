/**
 * The global graph's filters (§9.4).
 *
 * Each of the six is a claim about what a reader sees, and the two that are easy to get
 * subtly wrong have the most cases here: a tag filter has to nest the way §9.3's tags do
 * (`project` includes `project/mb` and excludes `projects`), and every filter has to take
 * the edges of what it hides with it — a line whose end is not drawn is the one thing a
 * picture cannot render honestly.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type GraphFilters,
  NO_FILTERS,
  carries,
  compileGlob,
  filterGraph,
  filtersAreActive,
} from "./graph-filters.js";
import { EDGE_STRIDE, type VaultGraphData, type VaultGraphNode } from "./vault-graph.js";

function note(
  path: string,
  extra: Partial<Omit<VaultGraphNode, "key" | "path">> = {},
): VaultGraphNode {
  return {
    key: `n:${path}`,
    path,
    label: path,
    icon: null,
    degree: 0,
    words: 0,
    created: null,
    tags: [],
    ...extra,
  };
}

function ghost(name: string): VaultGraphNode {
  return {
    key: `g:${name}`,
    path: null,
    label: name,
    icon: null,
    degree: 0,
    words: 0,
    created: null,
    tags: [],
  };
}

function graph(
  nodes: readonly VaultGraphNode[],
  triples: readonly (readonly [number, number, 0 | 1])[] = [],
): VaultGraphData {
  const edges = new Uint32Array(triples.length * EDGE_STRIDE);
  triples.forEach(([source, target, embed], at) => {
    edges[at * EDGE_STRIDE] = source;
    edges[at * EDGE_STRIDE + 1] = target;
    edges[at * EDGE_STRIDE + 2] = embed;
  });
  return { nodes, edges, total: nodes.length, truncated: false };
}

const withFilters = (extra: Partial<GraphFilters>): GraphFilters => ({ ...NO_FILTERS, ...extra });

const keysOf = (nodes: readonly VaultGraphNode[]): string[] => nodes.map((node) => node.key);

describe("no filters", () => {
  it("keeps every node and every edge", () => {
    const whole = graph([note("A.md"), note("B.md")], [[0, 1, 0]]);
    const filtered = filterGraph(whole, NO_FILTERS);
    expect(keysOf(filtered.nodes)).toEqual(["n:A.md", "n:B.md"]);
    expect(Array.from(filtered.edges)).toEqual([0, 1, 0]);
    expect(filtered.of).toBe(2);
  });

  it("is not reported as filtering anything", () => {
    expect(filtersAreActive(NO_FILTERS)).toBe(false);
  });

  it("is reported as filtering as soon as any one of the six is set", () => {
    // A badge that said "no filters" while a scrubber was hiding half the vault would be
    // worse than no badge: a reader would read the gap as the shape of their notes.
    const each: Partial<GraphFilters>[] = [
      { includeTags: ["project"] },
      { excludeTags: ["archive"] },
      { pathGlob: "Projects/*" },
      { orphansOnly: true },
      { ghosts: false },
      { edges: { link: false, embed: true } },
      { edges: { link: true, embed: false } },
      { createdFrom: "2026-01-01" },
      { createdTo: "2026-12-31" },
    ];
    for (const one of each) {
      expect(filtersAreActive(withFilters(one)), JSON.stringify(one)).toBe(true);
    }
  });
});

describe("tags", () => {
  const tagged = graph([
    note("A.md", { tags: ["project/mb"] }),
    note("B.md", { tags: ["projects"] }),
    note("C.md", { tags: ["archive", "project"] }),
    note("D.md"),
  ]);

  it("includes a tag and everything nested under it", () => {
    const filtered = filterGraph(tagged, withFilters({ includeTags: ["project"] }));
    expect(keysOf(filtered.nodes)).toEqual(["n:A.md", "n:C.md"]);
  });

  it("does not treat a different tag with the same start as nested", () => {
    // `projects` is not under `project`, and a `startsWith` without the separator says it is.
    const filtered = filterGraph(tagged, withFilters({ includeTags: ["projects"] }));
    expect(keysOf(filtered.nodes)).toEqual(["n:B.md"]);
  });

  it("includes a note carrying any of several tags", () => {
    const filtered = filterGraph(tagged, withFilters({ includeTags: ["archive", "projects"] }));
    expect(keysOf(filtered.nodes)).toEqual(["n:B.md", "n:C.md"]);
  });

  it("excludes whatever an exclusion names, even if an inclusion wanted it", () => {
    // Exclusion wins, because "everything in project except the archived ones" is what a
    // reader means by setting both — and the other reading has no way to say that at all.
    const filtered = filterGraph(
      tagged,
      withFilters({ includeTags: ["project"], excludeTags: ["archive"] }),
    );
    expect(keysOf(filtered.nodes)).toEqual(["n:A.md"]);
  });

  it("reads a tag written with its hash, or in any case", () => {
    expect(carries(note("A.md", { tags: ["project/mb"] }), "#Project")).toBe(true);
    expect(carries(note("A.md", { tags: ["project/mb"] }), "  project/MB  ")).toBe(true);
  });

  it("matches nothing for an empty tag", () => {
    expect(carries(note("A.md", { tags: ["project"] }), "")).toBe(false);
    expect(carries(note("A.md", { tags: ["project"] }), "#")).toBe(false);
  });
});

describe("a path glob", () => {
  const tree = graph([
    note("A.md"),
    note("Projects/Q3.md"),
    note("Projects/Deep/Q4.md"),
    note("Notes (2024)/Old.md"),
  ]);

  it("matches within one folder with a single star", () => {
    const filtered = filterGraph(tree, withFilters({ pathGlob: "Projects/*" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Projects/Q3.md"]);
  });

  it("matches across folders with a double star", () => {
    const filtered = filterGraph(tree, withFilters({ pathGlob: "Projects/**" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Projects/Q3.md", "n:Projects/Deep/Q4.md"]);
  });

  it("matches one character with a question mark", () => {
    const filtered = filterGraph(tree, withFilters({ pathGlob: "Projects/Q?.md" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Projects/Q3.md"]);
  });

  it("treats a folder name as text rather than as a pattern", () => {
    // `Notes (2024)` is a folder somebody made. Left unescaped it is a group and a match
    // against nothing, and the reader would conclude the folder is empty.
    const filtered = filterGraph(tree, withFilters({ pathGlob: "Notes (2024)/*" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Notes (2024)/Old.md"]);
  });

  it("ignores case, because the tree a reader reads the name off does", () => {
    const filtered = filterGraph(tree, withFilters({ pathGlob: "projects/q3.md" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Projects/Q3.md"]);
  });

  it("compiles nothing for an empty pattern", () => {
    expect(compileGlob("")).toBeUndefined();
    expect(compileGlob("   ")).toBeUndefined();
  });
});

describe("orphans", () => {
  it("keeps only the notes nothing links to and that link to nothing", () => {
    const linked = graph([note("A.md"), note("B.md"), note("Alone.md")], [[0, 1, 0]]);
    const filtered = filterGraph(linked, withFilters({ orphansOnly: true, ghosts: false }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Alone.md"]);
  });

  it("counts a link in either direction", () => {
    const linked = graph([note("A.md"), note("B.md")], [[1, 0, 0]]);
    const filtered = filterGraph(linked, withFilters({ orphansOnly: true }));
    expect(filtered.nodes).toHaveLength(0);
  });
});

describe("ghosts", () => {
  it("are drawn unless they are switched off", () => {
    const mixed = graph([note("A.md"), ghost("someday")], [[0, 1, 0]]);
    expect(keysOf(filterGraph(mixed, NO_FILTERS).nodes)).toEqual(["n:A.md", "g:someday"]);
    expect(keysOf(filterGraph(mixed, withFilters({ ghosts: false })).nodes)).toEqual(["n:A.md"]);
  });

  it("survive a filter they could not possibly satisfy", () => {
    // A ghost has no path, no tags and no date, so every other filter would hide it by
    // default — and a picture that dropped every unresolved link the moment a reader typed
    // a folder name would be lying about what is in that folder.
    const mixed = graph([note("Projects/A.md"), ghost("someday")]);
    const filtered = filterGraph(
      mixed,
      withFilters({ pathGlob: "Projects/*", includeTags: ["project"], createdFrom: "2020-01-01" }),
    );
    expect(keysOf(filtered.nodes)).toContain("g:someday");
  });

  it("take their edges with them when they go", () => {
    const mixed = graph([note("A.md"), ghost("someday")], [[0, 1, 0]]);
    expect(Array.from(filterGraph(mixed, withFilters({ ghosts: false })).edges)).toEqual([]);
  });
});

describe("edge kinds", () => {
  const both = graph(
    [note("A.md"), note("B.md"), note("C.md")],
    [
      [0, 1, 0],
      [0, 2, 1],
    ],
  );

  it("draws only links when embeds are off", () => {
    const filtered = filterGraph(both, withFilters({ edges: { link: true, embed: false } }));
    expect(Array.from(filtered.edges)).toEqual([0, 1, 0]);
  });

  it("draws only embeds when links are off", () => {
    const filtered = filterGraph(both, withFilters({ edges: { link: false, embed: true } }));
    expect(Array.from(filtered.edges)).toEqual([0, 2, 1]);
  });

  it("keeps the nodes when it drops their edges", () => {
    // Hiding an edge is not hiding a note: a reader turning off embeds wants to see the
    // link structure without them, not a vault with fewer notes in it.
    const filtered = filterGraph(both, withFilters({ edges: { link: false, embed: false } }));
    expect(filtered.nodes).toHaveLength(3);
    expect(Array.from(filtered.edges)).toEqual([]);
  });
});

describe("the creation scrubber", () => {
  const dated = graph([
    note("Old.md", { created: "2019-11-02" }),
    note("New.md", { created: "2026-08-28" }),
    note("Undated.md"),
  ]);

  it("keeps what was made on or after the earliest date", () => {
    const filtered = filterGraph(dated, withFilters({ createdFrom: "2026-01-01" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:New.md"]);
  });

  it("keeps what was made on or before the latest date", () => {
    const filtered = filterGraph(dated, withFilters({ createdTo: "2019-11-02" }));
    expect(keysOf(filtered.nodes)).toEqual(["n:Old.md"]);
  });

  it("hides an undated note as soon as either end is set", () => {
    // "Created before 2020" is a claim, and a note with no date cannot satisfy it. §9.4's
    // undated state is why the scrubber has an off position at all.
    expect(keysOf(filterGraph(dated, withFilters({ createdFrom: "1900-01-01" })).nodes)).toEqual([
      "n:Old.md",
      "n:New.md",
    ]);
    expect(keysOf(filterGraph(dated, NO_FILTERS).nodes)).toContain("n:Undated.md");
  });
});

describe("what a filtered picture carries", () => {
  it("renumbers its edges against the nodes it kept", () => {
    const whole = graph(
      [note("A.md"), note("B.md", { tags: ["hide"] }), note("C.md")],
      [
        [0, 2, 0],
        [1, 2, 0],
      ],
    );
    const filtered = filterGraph(whole, withFilters({ excludeTags: ["hide"] }));
    expect(keysOf(filtered.nodes)).toEqual(["n:A.md", "n:C.md"]);
    expect(Array.from(filtered.edges)).toEqual([0, 1, 0]);
  });

  it("remembers where each node came from", () => {
    // The selection survives a filter change by index into the *unfiltered* graph, so the
    // note a reader had picked is still the note they had picked.
    const whole = graph([note("A.md"), note("B.md", { tags: ["hide"] }), note("C.md")]);
    const filtered = filterGraph(whole, withFilters({ excludeTags: ["hide"] }));
    expect(Array.from(filtered.source)).toEqual([0, 2]);
  });

  it("says how many nodes there were before it filtered", () => {
    const whole = graph([note("A.md"), note("B.md", { tags: ["hide"] })]);
    expect(filterGraph(whole, withFilters({ excludeTags: ["hide"] })).of).toBe(2);
  });
});

// ------------------------------------------------------------------ properties

const nodes = fc.array(
  fc.record({
    path: fc.string({ minLength: 1, maxLength: 8 }),
    tags: fc.array(fc.constantFrom("project", "project/mb", "archive"), { maxLength: 2 }),
    created: fc.option(fc.constantFrom("2019-01-01", "2026-08-28"), { nil: null }),
  }),
  { minLength: 1, maxLength: 40, size: "large" },
);

const anyFilters = fc.record({
  includeTags: fc.array(fc.constantFrom("project", "archive"), { maxLength: 2 }),
  excludeTags: fc.array(fc.constantFrom("project/mb", "archive"), { maxLength: 2 }),
  pathGlob: fc.constantFrom("", "*", "**", "a*"),
  orphansOnly: fc.boolean(),
  ghosts: fc.boolean(),
  edges: fc.record({ link: fc.boolean(), embed: fc.boolean() }),
  createdFrom: fc.constantFrom("", "2020-01-01"),
  createdTo: fc.constantFrom("", "2026-12-31"),
});

describe("every filter", () => {
  it("leaves every drawn edge with both ends on the page", () => {
    fc.assert(
      fc.property(
        nodes,
        fc.array(fc.tuple(fc.nat(39), fc.nat(39), fc.constantFrom(0 as const, 1 as const)), {
          maxLength: 60,
        }),
        anyFilters,
        (entries, triples, filters) => {
          const drawn = entries.map(({ path, tags, created }, at) =>
            at % 5 === 0 ? ghost(path) : note(`${path}${at}.md`, { tags, created }),
          );
          const inRange = triples
            .map(([a, b, kind]) => [a % drawn.length, b % drawn.length, kind] as const)
            .filter(([a, b]) => a !== b);
          const filtered = filterGraph(graph(drawn, inRange), filters);
          for (let at = 0; at < filtered.edges.length; at += EDGE_STRIDE) {
            expect(filtered.edges[at]).toBeLessThan(filtered.nodes.length);
            expect(filtered.edges[at + 1]).toBeLessThan(filtered.nodes.length);
          }
          expect(filtered.source.length).toBe(filtered.nodes.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("only ever takes nodes away", () => {
    fc.assert(
      fc.property(nodes, anyFilters, (entries, filters) => {
        const drawn = entries.map(({ path, tags, created }, at) =>
          note(`${path}${at}.md`, { tags, created }),
        );
        const whole = graph(drawn);
        const filtered = filterGraph(whole, filters);
        expect(filtered.nodes.length).toBeLessThanOrEqual(drawn.length);
        for (const node of filtered.nodes) {
          expect(drawn).toContain(node);
        }
      }),
      { numRuns: 200 },
    );
  });
});
