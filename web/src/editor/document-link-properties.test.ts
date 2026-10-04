import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createDocumentLinkIndex, type DocumentLinkNote } from "./document-link-autocomplete.js";
import { documentReference, linkDestination } from "./links.js";

const options = { seed: 20261003, numRuns: 250 };
const word = fc.array(fc.constantFrom("a", "b", "C", "é", "e\u0301", "中", "א", "☕", "<", ">", "&", " "), { minLength: 1, maxLength: 18 }).map((parts) => parts.join(""));
const notes = fc.uniqueArray(fc.record({ path: word.map((name) => `Notes/${name}.md`), title: fc.option(word, { nil: null }) }), { selector: (note) => note.path, maxLength: 50 });
const fold = (text: string): string => text.normalize("NFC").toLowerCase();

// Independent oracle: sorting all authorized matches versus the production bounded top-eight scan.
function ordered(catalog: readonly DocumentLinkNote[], query: string): readonly DocumentLinkNote[] {
  const wanted = fold(query.trim());
  function score(note: DocumentLinkNote): number {
    const title = fold(note.title ?? note.path.replace(/\.md$/, ""));
    const basename = fold(note.path.split("/").at(-1)?.replace(/\.md$/, "") ?? note.path);
    const matches = [title === wanted, basename === wanted, title.startsWith(wanted), basename.startsWith(wanted), title.includes(wanted), fold(note.path).includes(wanted)];
    return matches.indexOf(true);
  }
  return catalog.filter((note) => score(note) >= 0).sort((a, b) => score(a) - score(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, 8);
}

describe("document autocomplete invariants", () => {
  it("returns the ordered top eight and no metadata outside the supplied authorized catalog", () => {
    fc.assert(fc.property(notes, word, (catalog, query) => {
      const rank = createDocumentLinkIndex(catalog);
      expect(rank(query)).toEqual(ordered(catalog, query));
      for (const result of rank(query)) expect(catalog).toContain(result);
    }), options);
  });

  it("is deterministic under catalog permutation, equivalent Unicode and query casing", () => {
    fc.assert(fc.property(notes, word, (catalog, query) => {
      const rank = createDocumentLinkIndex(catalog);
      expect(rank(query)).toEqual(createDocumentLinkIndex([...catalog].reverse())(query));
      expect(rank(query.normalize("NFD"))).toEqual(rank(query.normalize("NFC")));
      expect(rank(query.toLowerCase())).toEqual(rank(query));
    }), options);
  });

  it("prioritizes exact title, exact basename, prefixes, then substrings with path tie-breaking", () => {
    const catalog = [
      { path: "f/Road.md", title: "Different" },
      { path: "d/Roadwork.md", title: "Other" },
      { path: "e/Not.md", title: "Old road" },
      { path: "a/Plan.md", title: "Road" },
      { path: "b/Plan.md", title: "Roadtrip" },
      { path: "z/Road folder/Plan.md", title: "Other" },
    ];
    expect(createDocumentLinkIndex(catalog)("road").map((note) => note.path)).toEqual([
      "a/Plan.md", "f/Road.md", "b/Plan.md", "d/Roadwork.md", "e/Not.md", "z/Road folder/Plan.md",
    ]);
  });
});

describe("document destination safety invariants", () => {
  it("never promotes arbitrary text to an external URL outside the scheme allowlist", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (href) => {
      const destination = linkDestination(href);
      if (destination.kind === "external") {
        expect(["http:", "https:", "mailto:", "tel:"]).toContain(new URL(destination.href).protocol);
        expect(destination.href).not.toMatch(/[\u0000-\u001f\u007f\\]/u);
      }
    }), options);
  });

  it("blocks unsafe schemes even with case and percent-encoding obfuscation", () => {
    fc.assert(fc.property(fc.constantFrom("javascript", "data", "vbscript", "file", "blob"), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }), fc.boolean(), word,
      (scheme, upper, encode, suffix) => {
        const value = `${[...scheme].map((char, index) => upper[index] ? char.toUpperCase() : char).join("")}:${suffix}`;
        expect(linkDestination(encode ? encodeURIComponent(value) : value).kind).toBe("blocked");
      }), options);
  });

  it("blocks protocol-relative, backslash and encoded control-character destinations", () => {
    fc.assert(fc.property(fc.constantFrom("//", "\\\\", "%2f%2f", "%5c%5c", "%00", "%0a", "%7f"), word,
      (prefix, suffix) => { expect(linkDestination(`${prefix}${suffix}`).kind).toBe("blocked"); }), options);
  });

  it("preserves encoded note names and heading/block anchors without resolving authorization locally", () => {
    const safe = word.filter((value) => value.trim() !== "" && !value.includes("#"));
    fc.assert(fc.property(safe, safe, fc.boolean(), (name, anchor, block) => {
      const target = `Notes/${name}.md`;
      expect(linkDestination(`${encodeURIComponent(target)}#${encodeURIComponent(`${block ? "^" : ""}${anchor}`)}`)).toEqual({
        kind: "note", target, anchorKind: block ? "block" : "heading", anchor,
      });
    }), options);
  });

  it("rejects relative traversal above the vault root", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), (depth) => {
      expect(documentReference(`${"../".repeat(depth + 1)}Private.md`, `${"Folder/".repeat(depth)}Source.md`)).toBeUndefined();
      expect(documentReference(`${"../".repeat(depth)}Allowed.md`, `${"Folder/".repeat(depth)}Source.md`)).toBe("Allowed.md");
    }), options);
  });
});
