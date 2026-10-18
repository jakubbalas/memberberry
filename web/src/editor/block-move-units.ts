/** Structural movement units; Markdown conversion remains owned by the Rust/WASM codec. */
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

/** A block, complete list item, or one explicitly separated paragraph line. */
export interface MoveUnit {
  readonly node: PMNode;
  readonly start: number;
  readonly end: number;
  readonly rootStart: number;
  readonly inline: boolean;
  readonly parent?: PMNode;
  readonly childIndex: number;
}
/** Units are scoped to the document, or to one nested list to preserve its parent item. */
export interface MoveUnits {
  readonly units: readonly MoveUnit[];
  readonly from: number;
  readonly parent: PMNode;
}
const isList = (node: PMNode): boolean => node.type.name === "bullet_list" || node.type.name === "ordered_list";
const isBreak = (node: PMNode): boolean => node.type.name === "soft_break" || node.type.name === "hard_break";
function compatibleLists(left: PMNode, right: PMNode): boolean {
  if (!isList(left) || !isList(right) || left.type !== right.type) return false;
  // why: an item adopts the destination's numbering; list start is not item metadata.
  const attrs = left.type.name === "ordered_list" ? { ...left.attrs, start: right.attrs["start"] } : left.attrs;
  return left.type.create(attrs).sameMarkup(right);
}
function listUnits(parent: PMNode, start: number, rootStart: number): MoveUnit[] {
  const units: MoveUnit[] = [];
  parent.forEach((node, offset, childIndex) => {
    const from = start + 1 + offset;
    units.push({ node, start: from, end: from + node.nodeSize, rootStart, inline: false, parent, childIndex });
  });
  return units;
}
function paragraphUnits(parent: PMNode, start: number): MoveUnit[] {
  const units: MoveUnit[] = [];
  let from = 0;
  let children: PMNode[] = [];
  const add = (to: number): void => {
    // why: repeatedly cutting a large paragraph rescans all preceding inline nodes and
    // makes targeting its last line quadratic. Partition the existing children once.
    const node = parent.copy(Fragment.fromArray(children));
    units.push({ node, start: start + 1 + from, end: start + 1 + to, rootStart: start, inline: true, parent, childIndex: units.length });
    children = [];
  };
  parent.forEach((node, offset) => { if (isBreak(node)) { add(offset); from = offset + node.nodeSize; } else children.push(node); });
  add(parent.content.size);
  return units;
}
/** Only expanded captures scan rows; ordinary block/caret captures retain their constant-depth path. */
export function captureMoveUnits(doc: PMNode, pos: number): { plan: MoveUnits; index: number } | undefined {
  const at = doc.resolve(pos);
  const root = doc.child(at.index(0));
  const rootStart = at.depth > 0 ? at.before(1) : pos;
  let listDepth = 0;
  if (isList(root)) {
    for (let depth = 1; depth <= at.depth; depth++) {
      if (isList(at.node(depth)) && at.index(depth) < at.node(depth).childCount) listDepth = depth;
    }
  }
  if (listDepth > 1) {
    const parent = at.node(listDepth);
    const from = at.before(listDepth);
    const units = listUnits(parent, from, rootStart);
    return { plan: { units, from, parent }, index: at.index(listDepth) };
  }
  const lines = root.type.name === "paragraph" ? paragraphUnits(root, rootStart) : undefined;
  if (listDepth === 0 && (!lines || lines.length < 2)) return undefined;
  const units: MoveUnit[] = [];
  doc.forEach((node, start, childIndex) => {
    if (isList(node)) units.push(...listUnits(node, start, start));
    else if (node.type.name === "paragraph") {
      const rows = node === root && lines ? lines : paragraphUnits(node, start);
      if (rows.length > 1) units.push(...rows);
      else units.push({ node, start, end: start + node.nodeSize, rootStart: start, inline: false, childIndex });
    } else units.push({ node, start, end: start + node.nodeSize, rootStart: start, inline: false, childIndex });
  });
  const start = listDepth > 0 ? at.depth > listDepth ? at.before(listDepth + 1) : pos : lines?.find(line => pos >= line.start && pos <= line.end)?.start;
  const index = units.findIndex(unit => unit.start === start);
  return index < 0 ? undefined : { plan: { units, from: 0, parent: doc }, index };
}
/** Describes the post-move location of every original unit, including an unrelated selection. */
export interface UnitMoveResult { readonly relocate: (pos: number) => number }
/** Reorders units, reconstructing only changed containers and replacing the smallest root span. */
export function reorderMoveUnits(tr: Transaction, plan: MoveUnits, index: number, boundary: number): UnitMoveResult | undefined {
  const rows = plan.units.slice();
  const moved = rows.splice(index, 1)[0];
  if (!moved) return undefined;
  rows.splice(boundary > index ? boundary - 1 : boundary, 0, moved);
  const nodes: PMNode[] = [];
  const locations = new Map<MoveUnit, number>();
  let position = plan.from;
  for (let i = 0; i < rows.length;) {
    const first = rows[i]; if (!first) return undefined;
    if (!first.parent) {
      nodes.push(first.node); locations.set(first, position); position += first.node.nodeSize; i++; continue;
    }
    const group: MoveUnit[] = [first]; i++;
    while (i < rows.length) {
      const next = rows[i];
      if (!next || !(next.parent === first.parent || (!first.inline && next.parent && compatibleLists(first.parent, next.parent)))) break;
      group.push(next); i++;
    }
    const parent = group.find(row => row !== moved)?.parent ?? first.parent;
    const ownsAnchor = group.some(row => row.parent === parent && row.childIndex === 0);
    const attrs: Record<string, unknown> = { ...parent.attrs, ...(ownsAnchor ? {} : { anchor: null }) };
    if (!first.inline && parent.type.name === "ordered_list" && !ownsAnchor) attrs["start"] = Number(parent.attrs["start"]) + (group.find(row => row.parent === parent)?.childIndex ?? 0);
    const children: PMNode[] = [];
    let offset = position + 1;
    const breaks: PMNode[] = [];
    // why: explicit break kinds belong to the paragraph's separator slots. Reordering text
    // keeps those slots (including hard versus soft breaks), rather than inventing new ones.
    if (first.inline) first.parent.forEach(node => { if (isBreak(node)) breaks.push(node); });
    for (let g = 0; g < group.length; g++) {
      const row = group[g]; if (!row) return undefined;
      locations.set(row, offset);
      if (row.inline) {
        row.node.forEach(node => children.push(node)); offset += row.node.content.size;
        if (g < group.length - 1) { const separator = breaks[g]; if (!separator) return undefined; children.push(separator); offset += separator.nodeSize; }
      } else { children.push(row.node); offset += row.node.nodeSize; }
    }
    const node = parent.type.createChecked(attrs, Fragment.fromArray(children), parent.marks);
    nodes.push(node); position += node.nodeSize;
  }
  if (plan.parent.type.name !== "doc") {
    // why: nested items stay within their own list; moving a parent still carries its subtree.
    if (nodes.length !== 1) return undefined;
    tr.replaceWith(plan.from, plan.from + plan.parent.nodeSize, nodes);
  } else {
    let prefix = 0; let suffix = 0; let from = 0; let to = plan.parent.content.size;
    while (prefix < nodes.length && prefix < plan.parent.childCount && nodes[prefix]?.eq(plan.parent.child(prefix))) { from += plan.parent.child(prefix).nodeSize; prefix++; }
    while (suffix < nodes.length - prefix && suffix < plan.parent.childCount - prefix && nodes[nodes.length - 1 - suffix]?.eq(plan.parent.child(plan.parent.childCount - 1 - suffix))) { to -= plan.parent.child(plan.parent.childCount - 1 - suffix).nodeSize; suffix++; }
    tr.replaceWith(from, to, nodes.slice(prefix, nodes.length - suffix));
  }
  return { relocate: pos => {
    // why: the end of a list item is also the next item's start. Prefer the item
    // starting there so a node selection follows that item instead of its neighbour.
    const row = plan.units.find(unit => pos >= unit.start && pos < unit.end) ?? plan.units.find(unit => pos === unit.end);
    const start = row && locations.get(row);
    return row && start !== undefined ? start + pos - row.start : tr.mapping.map(pos);
  } };
}
