/** Fail-closed admission using the bundled Rust schema and the actual loaded WASM codec. */
import { getSchema } from "@tiptap/core";
import type { Node, Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep, AddNodeMarkStep, RemoveNodeMarkStep, AttrStep, DocAttrStep } from "@tiptap/pm/transform";
import { Doc, applyUpdate, encodeStateAsUpdate } from "yjs";
import { yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import bundledSchema from "../../../crates/mb-core/schema.json";
import { load } from "../notes.js";
import { markdownFromUpdate, schemaJson } from "../wasm/mb.js";
import { createMemberberryExtensions } from "./schema.js";

/** Editor revision, not the independent lib0 v1 encoding revision. */
export { SCHEMA_VERSION } from "./schema-revision.js";
import { SCHEMA_VERSION } from "./schema-revision.js";

/** A terminal refusal: retain the replica, stop transport, and require a fresh editor. */
export class SchemaRefreshRequired extends Error {
  readonly code = "schema_refresh_required";
  constructor() { super("Editor schema refresh required; this replica was not changed."); }
}

export interface SchemaAdmission {
  readonly version: number;
  validate(document: Doc): void;
  validateIncoming(document: Doc, update: Uint8Array): void;
}

/** Loads the real codec before a replica can connect or be bound. */
export async function loadSchemaAdmission(): Promise<SchemaAdmission> {
  await load();
  return createLoadedSchemaAdmission();
}

let editorSchema: Schema | undefined;

/** Synchronous once WASM is ready, so validation and live apply have no edit race. */
export function createLoadedSchemaAdmission(wasmSchema: unknown = JSON.parse(schemaJson())): SchemaAdmission {
  const contract = object(wasmSchema);
  if (!Number.isSafeInteger(SCHEMA_VERSION) || SCHEMA_VERSION <= 0
    || contract["version"] !== SCHEMA_VERSION
    || JSON.stringify(contract["nodes"]) !== JSON.stringify(bundledSchema.nodes)
    || JSON.stringify(contract["marks"]) !== JSON.stringify(bundledSchema.marks)
    || contract["topNode"] !== bundledSchema.topNode) throw new SchemaRefreshRequired();
  editorSchema ??= getSchema(createMemberberryExtensions(bundledSchema));
  const schema = editorSchema;
  const validate = (document: Doc): void => {
    try {
      // why: unresolved structs/delete sets are not a validated empty note. They could
      // integrate unknown content later, after the binding has already mounted.
      if (document.store.pendingStructs !== null || document.store.pendingDs !== null) throw new SchemaRefreshRequired();
      // why: Rust remains the materialization authority. This is admission, never a TS codec.
      markdownFromUpdate(encodeStateAsUpdate(document));
      const fragment = document.getXmlFragment("prosemirror");
      if (fragment.length === 0) return; // A new replica has no editor initializer yet.
      const json: unknown = yXmlFragmentToProsemirrorJSON(fragment);
      validateAttributes(json);
      schema.nodeFromJSON(json).check();
    } catch { throw new SchemaRefreshRequired(); }
  };
  return {
    version: SCHEMA_VERSION,
    validate,
    validateIncoming(document, update): void {
      // why: even a read-only y-prosemirror conversion deletes unknown content. Never feed
      // the bound original until the prospective merged state has passed both authorities.
      const candidate = new Doc({ gc: false });
      try {
        applyUpdate(candidate, encodeStateAsUpdate(document));
        applyUpdate(candidate, update);
        validate(candidate);
      } catch { throw new SchemaRefreshRequired(); }
      finally { candidate.destroy(); }
    },
  };
}

/** Validates only changed PM ranges before ySync can write them; never clones/encodes a note per key. */
export function allowsLocalTransaction(transaction: Transaction): boolean {
  if (!transaction.docChanged) return true;
  try {
    const validateNode = (node: Node): void => {
      const nodes: Record<string, unknown> = bundledSchema.nodes;
      const marks: Record<string, unknown> = bundledSchema.marks;
      validateDeclaredAttributes({ attrs: node.attrs }, nodes[node.type.name]);
      for (const mark of node.marks) validateDeclaredAttributes({ attrs: mark.attrs }, marks[mark.type.name]);
      if (!node.type.validContent(node.content)) throw new SchemaRefreshRequired();
    };
    for (const [index, step] of transaction.steps.entries()) {
      const ranges: Array<[number, number]> = [];
      step.getMap().forEach((_oldStart, _oldEnd, start, end) => ranges.push([start, end]));
      if (ranges.length === 0) {
        if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) ranges.push([step.from, step.to]);
        else if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep || step instanceof AttrStep) ranges.push([step.pos, step.pos + 1]);
        else if (step instanceof DocAttrStep) {
          const nodes: Record<string, unknown> = bundledSchema.nodes;
          validateDeclaredAttributes({ attrs: transaction.doc.attrs }, nodes[transaction.doc.type.name]);
        } else return false;
      }
      const later = transaction.mapping.slice(index + 1);
      for (const [start, end] of ranges) {
        const from = Math.max(0, Math.min(transaction.doc.content.size, later.map(start, -1)));
        const to = Math.max(from, Math.min(transaction.doc.content.size, later.map(end, 1)));
        transaction.doc.nodesBetween(from, to, (node) => { validateNode(node); });
      }
    }
    return true;
  } catch { return false; }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SchemaRefreshRequired();
  return value as Record<string, unknown>;
}

/** Checks wire attributes against their actual schema declarations before PM can default/drop them. */
function validateAttributes(value: unknown): void {
  const node = object(value);
  const type = node["type"];
  if (typeof type !== "string") throw new SchemaRefreshRequired();
  const nodes: Record<string, unknown> = bundledSchema.nodes;
  validateDeclaredAttributes(node, nodes[type]);
  if (node["marks"] !== undefined) {
    if (!Array.isArray(node["marks"])) throw new SchemaRefreshRequired();
    const marks: Record<string, unknown> = bundledSchema.marks;
    for (const markValue of node["marks"]) {
      const mark = object(markValue);
      const name = mark["type"];
      if (typeof name !== "string") throw new SchemaRefreshRequired();
      validateDeclaredAttributes(mark, marks[name]);
    }
  }
  if (node["content"] !== undefined) {
    if (!Array.isArray(node["content"])) throw new SchemaRefreshRequired();
    for (const child of node["content"]) validateAttributes(child);
  }
}

function validateDeclaredAttributes(node: Record<string, unknown>, definition: unknown): void {
  const declarations = object(definition)["attrs"];
  const specs = declarations === undefined ? {} : object(declarations);
  const attrs = node["attrs"] === undefined ? {} : object(node["attrs"]);
  for (const [name, value] of Object.entries(attrs)) {
    const spec = object(specs[name]);
    if (value === null && spec["optional"] === true) continue;
    const values = spec["values"];
    const kind = spec["type"];
    const valid = kind === "string" || kind === "date" ? typeof value === "string"
      : kind === "boolean" ? typeof value === "boolean"
      : kind === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
        && (typeof spec["min"] !== "number" || value >= spec["min"])
        && (typeof spec["max"] !== "number" || value <= spec["max"])
      : kind === "enum" ? Array.isArray(values) && values.includes(value)
      : kind === "string[]" ? Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")
      : kind === "enum[]" ? Array.isArray(value) && Array.isArray(values) && value.every((entry: unknown) => values.includes(entry))
      : false;
    if (!valid) throw new SchemaRefreshRequired();
  }
}
