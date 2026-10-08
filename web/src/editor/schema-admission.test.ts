import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { Doc, XmlElement, XmlText, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { load } from "../notes.js";
import { createLoadedSchemaAdmission, SCHEMA_VERSION, SchemaRefreshRequired } from "./schema-admission.js";

beforeAll(async () => { await load(readFileSync(new URL("../wasm/mb_bg.wasm", import.meta.url))); });

function unknownDocument(mark = false): Doc {
  const doc = new Doc();
  const block = new XmlElement(mark ? "paragraph" : "future_block");
  const text = new XmlText(); text.insert(0, "KEEP ALL CONTENT");
  block.insert(0, [text]); doc.getXmlFragment("prosemirror").insert(0, [block]);
  if (mark) text.format(0, text.length, { future_mark: {} });
  return doc;
}

describe("schema admission", () => {
  it("refuses a candidate with unresolved CRDT dependencies before retaining hidden pending structs", () => {
    const remote = new Doc(); const block = new XmlElement("paragraph"); const text = new XmlText();
    block.insert(0, [text]); remote.getXmlFragment("prosemirror").insert(0, [block]);
    const missingParent = encodeStateVector(remote); text.insert(0, "orphaned payload");
    const live = new Doc(); const before = encodeStateAsUpdate(live);
    expect(() => createLoadedSchemaAdmission().validateIncoming(live, encodeStateAsUpdate(remote, missingParent))).toThrow(SchemaRefreshRequired);
    expect(encodeStateAsUpdate(live)).toEqual(before); live.destroy(); remote.destroy();
  });
  it("derives its revision from the bundled Rust schema and refuses mismatched WASM", () => {
    const admission = createLoadedSchemaAdmission();
    expect(admission.version).toBe(SCHEMA_VERSION);
    expect(() => createLoadedSchemaAdmission({ version: SCHEMA_VERSION + 1 })).toThrow(SchemaRefreshRequired);
    expect(() => createLoadedSchemaAdmission({ version: "1" })).toThrow(SchemaRefreshRequired);
  });

  it.each([false, true])("refuses unknown restored node/mark without conversion mutations (%s)", (mark) => {
    const original = unknownDocument(mark);
    const bytes = encodeStateAsUpdate(original);
    const seen: Uint8Array[] = []; original.on("update", (update: Uint8Array) => seen.push(update));
    expect(() => createLoadedSchemaAdmission().validate(original)).toThrow(SchemaRefreshRequired);
    expect(encodeStateAsUpdate(original)).toEqual(bytes);
    expect(seen).toEqual([]);
    original.destroy();
  });

  it("validates a prospective update on a clone and preserves the original on refusal", () => {
    const live = new Doc(); const admission = createLoadedSchemaAdmission();
    const before = encodeStateAsUpdate(live); const incoming = unknownDocument();
    expect(() => admission.validateIncoming(live, encodeStateAsUpdate(incoming))).toThrow(SchemaRefreshRequired);
    expect(encodeStateAsUpdate(live)).toEqual(before);
    expect(() => admission.validateIncoming(live, new Uint8Array([255]))).toThrow(SchemaRefreshRequired);
    expect(encodeStateAsUpdate(live)).toEqual(before);
    live.destroy(); incoming.destroy();
  });
});
