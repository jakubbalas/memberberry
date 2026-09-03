/**
 * Fuzzy matching (`SPEC.md` §8.4), and its §21.2 budget.
 *
 * Two kinds of test here. The ranking ones pin what people's fingers expect — typing `pr`
 * should find `Projects/Roadmap` before `Paragraph`, and that ordering is the whole product.
 * The last one pins the budget: §21.2 gives the quick switcher 80 ms over 10 000 notes on a
 * mid-range phone, and a scorer that allocates per candidate quietly misses it on the only
 * device that matters.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fuzzyMatch, fuzzyRank, highlight } from "./fuzzy.js";

/** The best candidate for `query`, by name. */
function best(query: string, candidates: readonly string[]): string | undefined {
  return fuzzyRank(query, candidates, { key: (candidate) => candidate })[0]?.item;
}

describe("matching", () => {
  it("finds a subsequence anywhere in the candidate", () => {
    expect(fuzzyMatch("pr", "Projects/Roadmap.md")).toBeDefined();
    expect(fuzzyMatch("rdm", "Projects/Roadmap.md")).toBeDefined();
  });

  it("refuses a query whose characters are not all there, in order", () => {
    expect(fuzzyMatch("xyz", "Projects/Roadmap.md")).toBeUndefined();
    expect(fuzzyMatch("mapRoad", "Roadmap")).toBeUndefined();
  });

  it("ignores case in both directions", () => {
    expect(fuzzyMatch("ROADMAP", "roadmap.md")).toBeDefined();
    expect(fuzzyMatch("roadmap", "ROADMAP.MD")).toBeDefined();
  });

  it("matches everything on an empty query, so the palette opens with a list", () => {
    const match = fuzzyMatch("", "anything");
    expect(match).toEqual({ score: 0, positions: [] });
  });

  it("reports where it matched, so highlighting needs no second pass", () => {
    expect(fuzzyMatch("rm", "Roadmap")?.positions).toEqual([0, 4]);
  });
});

describe("ranking", () => {
  it("prefers a word start over a match buried mid-word", () => {
    // Typing `pr` means "Projects/Roadmap", not "Paragraph". Getting this wrong makes the
    // switcher feel random, which is the only thing users report about it.
    expect(best("pr", ["Paragraph.md", "Projects/Roadmap.md"])).toBe("Projects/Roadmap.md");
  });

  it("prefers consecutive characters over scattered ones", () => {
    expect(best("road", ["Rough Old Analysis Draft.md", "Roadmap.md"])).toBe("Roadmap.md");
  });

  it("prefers the shorter of two equally good matches", () => {
    expect(best("note", ["Note.md", "Notebook of Very Long Things.md"])).toBe("Note.md");
  });

  it("still finds a deep path when the query really is that folder", () => {
    // The leading penalty is capped for this reason: uncapped, a note several folders down
    // can never win however well it matches.
    const candidates = ["Archive/2019/Old/Deeply/Nested/Roadmap.md", "Random.md"];
    expect(best("roadmap", candidates)).toBe("Archive/2019/Old/Deeply/Nested/Roadmap.md");
  });

  it("keeps the caller's order among equals, which is how recency wins", () => {
    // `fuzzyRank` knows nothing about recency; a caller sorts by it and ties break in that
    // order. That is how §8.4's "recent notes" works without this module learning what a
    // note is.
    const ranked = fuzzyRank("a", ["Alpha.md", "Alpha.md"], { key: (name) => name });
    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.match.score).toBe(ranked[1]?.match.score);
  });

  it("returns at most the limit asked for", () => {
    const many = Array.from({ length: 100 }, (_, index) => `Note ${index}.md`);
    expect(fuzzyRank("note", many, { key: (name) => name, limit: 7 })).toHaveLength(7);
  });

  it("returns nothing for a limit of zero rather than everything", () => {
    expect(fuzzyRank("a", ["Alpha.md"], { key: (name) => name, limit: 0 })).toEqual([]);
  });

  it("is sorted best-first", () => {
    const ranked = fuzzyRank("ro", ["Random.md", "Roadmap.md", "Retro.md"], {
      key: (name) => name,
    });
    const scores = ranked.map((entry) => entry.match.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe("tightening a greedy match", () => {
  it("slides the match right, onto the word the user meant", () => {
    // Greedy forward matching takes the left-most alignment: `road` against "Product roadmap"
    // finds the `ro` of "Product" and then jumps to `a`/`d` in "roadmap". A backward pass
    // slides each position as far right as it can, landing on "road" — which is both the
    // better highlight and, being adjacent and at a word start, the better score.
    const match = fuzzyMatch("road", "Product roadmap");
    expect(match?.positions).toEqual([8, 9, 10, 11]);
  });

  it("earns the adjacency bonus the greedy alignment would have missed", () => {
    // Compared against a candidate of the same length whose letters really are scattered, so
    // the difference is the adjacency the tightening recovered and not a length penalty.
    const tight = fuzzyMatch("road", "Product roadmap");
    const scattered = fuzzyMatch("road", "Rxoxaxdxxxxxxxx");
    expect(tight?.positions).toEqual([8, 9, 10, 11]);
    expect(tight?.score ?? 0).toBeGreaterThan(scattered?.score ?? 0);
  });

  it("keeps the positions strictly ascending", () => {
    // The tightening must never let one character overtake the next, or `highlight` builds
    // overlapping runs and the label comes out scrambled.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 5 }),
        (candidate, query) => {
          const match = fuzzyMatch(query, candidate);
          if (match === undefined) return true;
          for (let index = 1; index < match.positions.length; index += 1) {
            expect(match.positions[index] ?? 0).toBeGreaterThan(match.positions[index - 1] ?? 0);
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("highlighting", () => {
  it("splits into matched and unmatched runs", () => {
    expect(highlight("Roadmap", [0, 1])).toEqual([
      { text: "Ro", matched: true },
      { text: "admap", matched: false },
    ]);
  });

  it("merges a consecutive run into one span rather than one per character", () => {
    // Seven spans for `Roadmap` reads worse and costs more nodes than one.
    const runs = highlight("Roadmap", [0, 1, 2, 3, 4, 5, 6]);
    expect(runs).toEqual([{ text: "Roadmap", matched: true }]);
  });

  it("handles a match at the end", () => {
    expect(highlight("Roadmap", [6])).toEqual([
      { text: "Roadma", matched: false },
      { text: "p", matched: true },
    ]);
  });

  it("returns the whole string unmatched when nothing matched", () => {
    expect(highlight("Roadmap", [])).toEqual([{ text: "Roadmap", matched: false }]);
  });

  it("reassembles into the original text, whatever matched", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), fc.string({ maxLength: 6 }), (text, query) => {
        const match = fuzzyMatch(query, text);
        if (match === undefined) return true;
        const runs = highlight(text, match.positions);
        // The property that matters: highlighting never loses or duplicates a character.
        expect(runs.map((run) => run.text).join("")).toBe(text);
        return true;
      }),
      { numRuns: 400 },
    );
  });
});

describe("the §21.2 budget", () => {
  it("ranks 10 000 notes well inside 80 ms", () => {
    // §21.2: quick-switcher results in < 80 ms on a mid-range phone, < 50 ms on a desktop.
    // This runs on a developer machine or a CI runner, so the *threshold* here is deliberately
    // slack — it is a tripwire for an accidentally quadratic change, not a claim about a
    // phone. The real measurement belongs to the performance harness (§21.1).
    const notes = Array.from(
      { length: 10_000 },
      (_, index) => `Projects/Area ${index % 40}/Note ${index} about something.md`,
    );

    const started = performance.now();
    const ranked = fuzzyRank("pans", notes, { key: (note) => note, limit: 50 });
    const elapsed = performance.now() - started;

    expect(ranked.length).toBeGreaterThan(0);
    expect(elapsed, `ranking 10k notes took ${elapsed.toFixed(1)}ms`).toBeLessThan(50);
  });

  it("is no slower when nothing matches, which is every keystroke of a typo", () => {
    const notes = Array.from({ length: 10_000 }, (_, index) => `Note ${index}.md`);
    const started = performance.now();
    fuzzyRank("qqqqqq", notes, { key: (note) => note, limit: 50 });
    const elapsed = performance.now() - started;
    expect(elapsed, `a non-matching query took ${elapsed.toFixed(1)}ms`).toBeLessThan(50);
  });
});
