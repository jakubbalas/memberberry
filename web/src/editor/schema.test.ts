/** Cross-language editor conformance (`SPEC.md` §22.2), TypeScript half. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";

import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from "y-prosemirror";
import { beforeAll, describe, expect, it } from "vitest";

import { load, normalize, markdownFromUpdate, schema as loadSchema } from "../notes.js";
import { createMemberberrySchema, loadMemberberrySchema } from "./schema.js";

const FIXTURES = new URL("../../../crates/mb-crdt/fixtures/conformance/", import.meta.url);
const fixture = (name: string): string => fileURLToPath(new URL(name, FIXTURES));
const update = new Uint8Array(readFileSync(fixture("full.bin")));
const markdown = readFileSync(fixture("full.md"), "utf8");
const expected = JSON.parse(readFileSync(fixture("full.json"), "utf8")) as unknown;

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../wasm/mb_bg.wasm", import.meta.url));
  await load(readFileSync(wasm));
});

describe("generated Memberberry schema", () => {
  it("renders bounded relative size and refuses CSS strings", async () => {
    const generated = await loadMemberberrySchema();
    const type = generated.marks["mb_size"];
    if (type === undefined) throw new Error("missing size");
    expect(type.spec.toDOM?.(type.create({ value: "large" }), true)).toEqual(["span", { class: "mb-size-large" }, 0]);
    expect(() => type.spec.toDOM?.(type.create({ value: "1em" }), true)).toThrow();
    expect(type.spec.excludes).toBe("mb_size code");
  });
  it("renders independent finite backgrounds and keeps native highlight", async () => {
    const generated = await loadMemberberrySchema();
    const type = generated.marks["mb_background"];
    if (type === undefined) throw new Error("missing background");
    expect(type.spec.toDOM?.(type.create({ value: "yellow" }), true)).toEqual(["span", { class: "mb-background-yellow" }, 0]);
    expect(() => type.spec.toDOM?.(type.create({ value: "default" }), true)).toThrow();
    expect(type.spec.excludes).toBe("mb_background code");
    expect(generated.marks["highlight"]).toBeDefined();
  });
  it("renders finite color without authored attributes and refuses invalid values", async () => {
    const generated = await loadMemberberrySchema();
    const type = generated.marks["mb_color"];
    if (type === undefined) throw new Error("missing color");
    expect(type.spec.toDOM?.(type.create({ value: "red" }), true)).toEqual(["span", { class: "mb-color-red" }, 0]);
    expect(() => type.spec.toDOM?.(type.create({ value: "url(evil)" }), true)).toThrow();
    expect(type.spec.excludes).toBe("mb_color code");
  });
  it("renders underline as a fixed semantic class", async () => {
    const generated = await loadMemberberrySchema();
    const type = generated.marks["mb_underline"];
    expect(type).toBeDefined();
    if (type === undefined) throw new Error("missing underline");
    const mark = type.create();
    expect(generated.marks["mb_underline"]?.spec.toDOM?.(mark, true)).toEqual(["span", { class: "mb-underline" }, 0]);
  });
  it("matches every node, mark, attribute, and default in the Rust-owned contract", async () => {
    const contract = await loadSchema();
    const generated = createMemberberrySchema(contract);
    const source = asContract(contract);
    expect(asFixture(expected).version).toBe(record(contract, "schema")["version"]);

    expect(Object.keys(generated.nodes).sort()).toEqual(Object.keys(source.nodes).sort());
    expect(Object.keys(generated.marks).sort()).toEqual(Object.keys(source.marks).sort());
    expect(generated.topNodeType.name).toBe(source.topNode);

    for (const [name, definition] of Object.entries(source.nodes)) {
      const spec = generated.nodes[name]?.spec;
      expect(spec, `missing generated node ${name}`).toBeDefined();
      expect(spec?.content).toBe(definition.content);
      expect(spec?.group).toBe(definition.group);
      expect(spec?.attrs).toEqual(expectedAttributes(definition.attrs));
    }
    for (const [name, definition] of Object.entries(source.marks)) {
      const spec = generated.marks[name]?.spec;
      expect(spec, `missing generated mark ${name}`).toBeDefined();
      expect(spec?.attrs).toEqual(expectedAttributes(definition.attrs));
    }
  });
});

describe("M2 fixture consumer", () => {
  it("decodes the Rust lib0 v1 update to the exact ProseMirror and frontmatter JSON", () => {
    const ydoc = new Doc();
    applyUpdate(ydoc, update);

    expect(materialize(ydoc)).toEqual(semanticFixture(expected));
  });

  it("accepts the decoded ProseMirror state through the generated Tiptap schema", async () => {
    const ydoc = new Doc();
    applyUpdate(ydoc, update);
    const generated = await loadMemberberrySchema();

    expect(() => generated.nodeFromJSON(materialize(ydoc).prosemirror)).not.toThrow();
  });

  it("uses the shared WASM serializer for the fixture's canonical Markdown", async () => {
    expect(await normalize(markdown)).toBe(markdown);
  });
});

describe("M2 fixture producer", () => {
  it("writes fixture ProseMirror JSON into y-prosemirror's semantic shape", async () => {
    const generated = await loadMemberberrySchema();
    const ydoc = new Doc();
    prosemirrorJSONToYXmlFragment(generated, asFixture(expected).prosemirror, ydoc.getXmlFragment("prosemirror"));

    for (const [key, value] of Object.entries(asFixture(expected).frontmatter)) ydoc.getMap("frontmatter").set(key, value);
    expect(await markdownFromUpdate(encodeStateAsUpdate(ydoc))).toBe(markdown);
    expect(semanticProsemirror(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("prosemirror")))).toEqual(
      semanticFixture(expected).prosemirror,
    );
  });
});

interface Fixture {
  readonly version: number;
  readonly prosemirror: Record<string, unknown>;
  readonly frontmatter: Record<string, unknown>;
}

interface Contract {
  readonly topNode: string;
  readonly nodes: Readonly<Record<string, Definition>>;
  readonly marks: Readonly<Record<string, Definition>>;
}

interface Definition {
  readonly content?: string;
  readonly group?: string;
  readonly attrs?: Readonly<Record<string, Attribute>>;
}

interface Attribute {
  readonly optional?: true;
  readonly default?: unknown;
}

function materialize(ydoc: Doc): Fixture {
  return {
    version: asFixture(expected).version,
    prosemirror: semanticProsemirror(yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment("prosemirror"))),
    frontmatter: ydoc.getMap("frontmatter").toJSON(),
  };
}

/**
 * Y.XmlElement cannot distinguish an absent optional attribute from an explicit null, and
 * y-prosemirror emits `{ attrs: {} }` for marks without attributes. Both forms carry the
 * same ProseMirror state; lib0 key order and either representation are deliberately outside
 * the fixture contract (SPEC §22.2).
 */
function semanticFixture(value: unknown): Fixture {
  const fixtureValue = asFixture(value);
  return { ...fixtureValue, prosemirror: semanticProsemirror(fixtureValue.prosemirror) };
}

function semanticProsemirror(value: unknown): Record<string, unknown> {
  return record(semanticJson(record(value, "ProseMirror JSON")), "semantic ProseMirror JSON");
}

function semanticJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticJson);
  if (typeof value !== "object" || value === null) return value;

  const object = record(value, "ProseMirror JSON value");
  const normalized = Object.entries(object)
    .flatMap(([key, child]) => {
      // why: marks are an unordered semantic set. PM emits schema rank while the Y
      // JSON reader emits key order; the real WASM producer assertion above proves storage.
      if (key === "marks" && Array.isArray(child)) {
        const marks = child.map(semanticJson).sort((a: unknown, b: unknown) =>
          text(record(a, "mark")["type"], "mark.type").localeCompare(text(record(b, "mark")["type"], "mark.type")));
        return [[key, marks] as const];
      }
      if (key !== "attrs") return [[key, semanticJson(child)] as const];
      const attributes = Object.entries(record(child, "ProseMirror attrs"))
        .filter(([, attribute]) => attribute !== null)
        .map(([name, attribute]) => [name, semanticJson(attribute)] as const);
      return attributes.length === 0 ? [] : [[key, Object.fromEntries(attributes)] as const];
    });
  return Object.fromEntries(normalized);
}

function asFixture(value: unknown): Fixture {
  const fixtureValue = record(value, "fixture");
  return {
    version: finiteNumber(fixtureValue["version"], "fixture.version"),
    prosemirror: record(fixtureValue["prosemirror"], "fixture.prosemirror"),
    frontmatter: record(fixtureValue["frontmatter"], "fixture.frontmatter"),
  };
}

function asContract(value: unknown): Contract {
  const source = record(value, "schema contract");
  return {
    topNode: text(source["topNode"], "schema topNode"),
    nodes: definitions(source["nodes"], "nodes"),
    marks: definitions(source["marks"], "marks"),
  };
}

function definitions(value: unknown, label: string): Readonly<Record<string, Definition>> {
  return Object.fromEntries(
    Object.entries(record(value, label)).map(([name, definition]) => {
      const parsed = record(definition, `${label}.${name}`);
      return [
        name,
        {
          ...(typeof parsed["content"] === "string" ? { content: parsed["content"] } : {}),
          ...(typeof parsed["group"] === "string" ? { group: parsed["group"] } : {}),
          ...("attrs" in parsed ? { attrs: attributes(parsed["attrs"], `${label}.${name}.attrs`) } : {}),
        },
      ];
    }),
  );
}

function attributes(value: unknown, label: string): Readonly<Record<string, Attribute>> {
  return Object.fromEntries(
    Object.entries(record(value, label)).map(([name, attribute]) => {
      const parsed = record(attribute, `${label}.${name}`);
      return [
        name,
        {
          ...(parsed["optional"] === true ? { optional: true as const } : {}),
          ...("default" in parsed ? { default: parsed["default"] } : {}),
        },
      ];
    }),
  );
}

function expectedAttributes(attributes: Definition["attrs"]) {
  if (attributes === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(attributes).map(([name, attribute]) => [
      name,
      { default: attribute.optional === true ? null : attribute.default },
    ]),
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}
