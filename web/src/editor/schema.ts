/**
 * Tiptap extensions generated from the Rust-owned ProseMirror schema contract.
 *
 * Markdown remains exclusively Rust/WASM territory. This module defines only the editing
 * shape that `y-prosemirror` stores, so the editor cannot invent a node the server rejects.
 */

import { Mark, Node, getSchema, type Extensions } from "@tiptap/core";
import type { DOMOutputSpec, Schema } from "@tiptap/pm/model";

import { schema as loadSchemaContract } from "../notes.js";

type AttributeType = "string" | "boolean" | "integer" | "enum" | "date" | "string[]" | "enum[]";

interface AttributeDefinition {
  readonly type: AttributeType;
  readonly optional?: true;
  readonly default?: string | boolean | number | readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly values?: readonly string[];
}

interface NodeDefinition {
  readonly group?: string;
  readonly content?: string;
  readonly attrs?: Readonly<Record<string, AttributeDefinition>>;
  readonly atom?: true;
  readonly inline?: true;
  readonly marks?: string;
  readonly code?: true;
  readonly defining?: true;
}

interface MarkDefinition {
  readonly attrs?: Readonly<Record<string, AttributeDefinition>>;
  readonly excludes?: string;
  readonly code?: true;
}

interface SchemaContract {
  readonly version: number;
  readonly topNode: string;
  readonly nodes: Readonly<Record<string, NodeDefinition>>;
  readonly marks: Readonly<Record<string, MarkDefinition>>;
}

/** Creates the generated Tiptap extension set for one validated schema contract. */
export function createMemberberryExtensions(contract: unknown): Extensions {
  const parsed = parseContract(contract);
  const nodes = Object.entries(parsed.nodes).map(([name, definition]) =>
    createNodeExtension(name, definition, parsed.topNode),
  );
  const marks = Object.entries(parsed.marks).map(([name, definition]) =>
    createMarkExtension(name, definition),
  );
  return [...nodes, ...marks];
}

function createNodeExtension(name: string, definition: NodeDefinition, topNode: string) {
  const attributes = definition.attrs;
  return Node.create({
    name,
    ...(name === topNode ? { topNode: true } : {}),
    ...(definition.group === undefined ? {} : { group: definition.group }),
    ...(definition.content === undefined ? {} : { content: definition.content }),
    ...(definition.inline === undefined ? {} : { inline: definition.inline }),
    ...(definition.atom === undefined ? {} : { atom: definition.atom }),
    ...(definition.marks === undefined ? {} : { marks: definition.marks }),
    ...(definition.code === undefined ? {} : { code: definition.code }),
    ...(definition.defining === undefined ? {} : { defining: definition.defining }),
    ...(attributes === undefined ? {} : { addAttributes: () => attributesFor(attributes) }),
    ...(name === "text" ? {} : { renderHTML: (props) => renderNode(name, props.node.attrs, props.HTMLAttributes) }),
  });
}

function createMarkExtension(name: string, definition: MarkDefinition) {
  const attributes = definition.attrs;
  return Mark.create({
    name,
    ...(definition.excludes === undefined ? {} : { excludes: definition.excludes }),
    ...(definition.code === undefined ? {} : { code: definition.code }),
    ...(attributes === undefined ? {} : { addAttributes: () => attributesFor(attributes) }),
    renderHTML: (props) => renderMark(name, props.HTMLAttributes),
  });
}

/** Creates the ProseMirror schema consumed by Tiptap and y-prosemirror. */
export function createMemberberrySchema(contract: unknown): Schema {
  return getSchema(createMemberberryExtensions(contract));
}

/** Loads the Rust-owned contract through WASM and generates the editor schema from it. */
export async function loadMemberberrySchema(): Promise<Schema> {
  return createMemberberrySchema(await loadSchemaContract());
}

/** Loads the Rust-owned contract through WASM and generates Tiptap extensions from it. */
export async function loadMemberberryExtensions(): Promise<Extensions> {
  return createMemberberryExtensions(await loadSchemaContract());
}

function attributesFor(attributes: Readonly<Record<string, AttributeDefinition>>) {
  return Object.fromEntries(
    Object.entries(attributes).map(([name, definition]) => [
      name,
      { default: definition.optional === true ? null : definition.default },
    ]),
  );
}

function renderNode(
  name: string,
  attrs: Readonly<Record<string, unknown>>,
  htmlAttributes: Readonly<Record<string, unknown>>,
): DOMOutputSpec {
  switch (name) {
    case "doc":
      return ["div", htmlAttributes, 0];
    case "paragraph":
      return ["p", htmlAttributes, 0];
    case "heading":
      return [`h${headingLevel(attrs["level"])}`, htmlAttributes, 0];
    case "bullet_list":
      return ["ul", htmlAttributes, 0];
    case "ordered_list":
      return ["ol", htmlAttributes, 0];
    case "list_item":
      return ["li", htmlAttributes, 0];
    case "task_item":
      return ["li", { ...htmlAttributes, "data-task-status": stringValue(attrs["status"]) }, 0];
    case "blockquote":
      return ["blockquote", htmlAttributes, 0];
    case "callout":
      return ["aside", { ...htmlAttributes, "data-callout": stringValue(attrs["kind"]) }, 0];
    case "callout_title":
      return ["div", { ...htmlAttributes, "data-callout-title": "" }, 0];
    case "code_block":
      return ["pre", htmlAttributes, ["code", 0]];
    case "math_block":
      return ["div", { ...htmlAttributes, "data-math-block": "" }, 0];
    case "divider":
      return ["hr", htmlAttributes];
    case "table":
      return ["table", htmlAttributes, ["tbody", 0]];
    case "table_row":
      return ["tr", htmlAttributes, 0];
    case "table_cell":
      return ["td", htmlAttributes, 0];
    case "soft_break":
    case "hard_break":
      return ["br", htmlAttributes];
    case "image":
      return ["img", { ...htmlAttributes, src: stringValue(attrs["dest"]), alt: stringValue(attrs["alt"]) }];
    case "wikilink":
      return ["span", { ...htmlAttributes, "data-wikilink": "" }, `[[${stringValue(attrs["target"])}]]`];
    case "tag":
      return ["span", { ...htmlAttributes, "data-tag": "" }, `#${stringValue(attrs["name"])}`];
    case "emoji":
      return ["span", { ...htmlAttributes, "data-emoji": "" }, `:${stringValue(attrs["shortcode"])}:`];
    case "inline_math":
      return ["span", { ...htmlAttributes, "data-inline-math": "" }, `$${stringValue(attrs["value"])}$`];
    case "footnote_ref":
      return ["sup", htmlAttributes, `[^${stringValue(attrs["label"])}]`];
    default:
      return ["span", htmlAttributes];
  }
}

function renderMark(name: string, htmlAttributes: Readonly<Record<string, unknown>>): DOMOutputSpec {
  switch (name) {
    case "strong":
      return ["strong", htmlAttributes, 0];
    case "em":
      return ["em", htmlAttributes, 0];
    case "strikethrough":
      return ["s", htmlAttributes, 0];
    case "highlight":
      return ["mark", htmlAttributes, 0];
    case "code":
      return ["code", htmlAttributes, 0];
    case "link":
      return ["a", htmlAttributes, 0];
    default:
      return ["span", htmlAttributes, 0];
  }
}

function headingLevel(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 6 ? value : 1;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseContract(value: unknown): SchemaContract {
  const root = object(value, "schema contract");
  const version = number(root["version"], "schema version");
  const topNode = string(root["topNode"], "schema topNode");
  const nodes = definitions<NodeDefinition>(root["nodes"], "nodes", parseNodeDefinition);
  const marks = definitions<MarkDefinition>(root["marks"], "marks", parseMarkDefinition);
  if (!(topNode in nodes)) {
    throw new Error(`schema topNode \`${topNode}\` is not a declared node`);
  }
  return { version, topNode, nodes, marks };
}

function definitions<T>(
  value: unknown,
  label: string,
  parse: (value: unknown, label: string) => T,
): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([name, definition]) => [
      name,
      parse(definition, `${label}.${name}`),
    ]),
  );
}

function parseNodeDefinition(value: unknown, label: string): NodeDefinition {
  const definition = object(value, label);
  return {
    ...optionalString(definition, "group", label),
    ...optionalString(definition, "content", label),
    ...optionalAttributes(definition, label),
    ...optionalTrue(definition, "atom", label),
    ...optionalTrue(definition, "inline", label),
    ...optionalString(definition, "marks", label),
    ...optionalTrue(definition, "code", label),
    ...optionalTrue(definition, "defining", label),
  };
}

function parseMarkDefinition(value: unknown, label: string): MarkDefinition {
  const definition = object(value, label);
  return {
    ...optionalAttributes(definition, label),
    ...optionalString(definition, "excludes", label),
    ...optionalTrue(definition, "code", label),
  };
}

function optionalAttributes(
  value: Readonly<Record<string, unknown>>,
  label: string,
): { readonly attrs?: Readonly<Record<string, AttributeDefinition>> } {
  if (!("attrs" in value)) return {};
  return { attrs: definitions(value["attrs"], `${label}.attrs`, parseAttributeDefinition) };
}

function parseAttributeDefinition(value: unknown, label: string): AttributeDefinition {
  const definition = object(value, label);
  const type = string(definition["type"], `${label}.type`);
  if (!isAttributeType(type)) throw new Error(`${label}.type is not supported: ${type}`);
  const optional = definition["optional"] === true ? { optional: true as const } : {};
  const defaultValue = "default" in definition ? { default: attributeDefault(definition["default"], label) } : {};
  const min = "min" in definition ? { min: number(definition["min"], `${label}.min`) } : {};
  const max = "max" in definition ? { max: number(definition["max"], `${label}.max`) } : {};
  const values = "values" in definition ? { values: stringArray(definition["values"], `${label}.values`) } : {};
  return { type, ...optional, ...defaultValue, ...min, ...max, ...values };
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): { readonly [key: string]: string } {
  return key in value ? { [key]: string(value[key], `${label}.${key}`) } : {};
}

function optionalTrue(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): { readonly [key: string]: true } {
  if (!(key in value)) return {};
  if (value[key] !== true) throw new Error(`${label}.${key} must be true when present`);
  return { [key]: true };
}

function object(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function attributeDefault(value: unknown, label: string): string | boolean | number | readonly string[] {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  throw new Error(`${label}.default must be a scalar or string array`);
}

function isAttributeType(value: string): value is AttributeType {
  return ["string", "boolean", "integer", "enum", "date", "string[]", "enum[]"].includes(value);
}
