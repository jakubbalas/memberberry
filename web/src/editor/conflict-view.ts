/**
 * The three actions on a conflict callout, and the count of them (`SPEC.md` §3.5).
 *
 * §3.5 asks a `[!conflict]` callout to carry `Keep mine` / `Keep theirs` / `Keep both`, each
 * performing "an ordinary edit through the CRDT — so resolution syncs and is undoable". A
 * ProseMirror node view is what can do that: `renderHTML` produces static DOM, so buttons
 * drawn there would show but never accept a click.
 *
 * **The base rendering is the schema's own.** A callout that is not a conflict is rendered by
 * `node.type.spec.toDOM` — the same `renderHTML` `schema.ts` generates from the Rust contract
 * — rather than re-implemented here, so this module cannot drift from what a callout looks
 * like. A conflict gets that same DOM with an actions bar appended outside `contentDOM`,
 * where ProseMirror will not read it as note content.
 *
 * **The buttons are in the tab order**, unlike `task-view.ts`'s checkbox. There is no
 * inspector offering the same three choices, so this is the only route to them, and
 * `AGENTS.md` §4.4 means no mouse-only feature ships. The cost the task checkbox was avoiding
 * — a hundred tasks becoming a hundred tab stops — does not apply: a note with a hundred
 * unresolved conflicts is not a note anybody has.
 */

import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView, NodeView } from "@tiptap/pm/view";
import type { Doc } from "yjs";

import type { ConflictSide, NoteBridge } from "../notes.js";
import { applyResolution } from "./conflicts.js";

/** Fired at the editor's DOM whenever the note's unresolved conflict count changes. */
export const CONFLICT_EVENT = "memberberry:conflicts";

/** What a {@link CONFLICT_EVENT} carries. */
export interface ConflictDetail {
  /** Unresolved conflict callouts in the open note, at any depth. */
  readonly count: number;
}

/** The callout kind §3.5 gives a divergent version. Matches `mb_core::conflict`. */
const CONFLICT_KIND = "conflict";

/** §3.5's three actions, in the order they are offered. */
const ACTIONS: ReadonlyArray<{ readonly keep: ConflictSide; readonly label: string }> = [
  { keep: "mine", label: "Keep mine" },
  { keep: "theirs", label: "Keep theirs" },
  { keep: "both", label: "Keep both" },
];

/** Whether a ProseMirror node is an unresolved conflict callout. */
export function isConflictCallout(node: ProseMirrorNode): boolean {
  if (node.type.name !== "callout") return false;
  const kind = node.attrs["kind"];
  return typeof kind === "string" && kind.toLowerCase() === CONFLICT_KIND;
}

/**
 * The nodes a conflict callout can be reached through, and so the only ones worth descending.
 *
 * why: a bounded walk. `descendants` over a whole note visits every text node and every mark,
 * which is the keystroke path (§4.5) — but the block structure is tens of nodes whatever the
 * note weighs. This mirrors `mb_core::conflict::count_blocks`, and `conflict-view.test.ts`
 * holds the two to the same answer.
 */
const CONTAINERS: ReadonlySet<string> = new Set([
  "doc",
  "blockquote",
  "callout",
  "bullet_list",
  "ordered_list",
  "list_item",
  "task_item",
]);

/**
 * How many unresolved conflicts a document carries, at any depth.
 *
 * The same question `mb_core::conflict::count` answers, asked of the editor's document rather
 * than of Markdown — because the status count has to be live, and serializing the note on
 * every keystroke is not something §21 has room for.
 */
export function conflictsOf(doc: ProseMirrorNode): number {
  let count = 0;
  const walk = (node: ProseMirrorNode): void => {
    node.forEach((child) => {
      if (isConflictCallout(child)) {
        // Not descended into: §3.5 forbids a conflict inside a conflict, and counting one
        // would disagree with the reader, who sees one callout.
        count += 1;
        return;
      }
      if (CONTAINERS.has(child.type.name)) walk(child);
    });
  };
  walk(doc);
  return count;
}

/**
 * Where the conflict at `pos` sits among the note's conflicts, or `undefined` if nowhere.
 *
 * `undefined` for a conflict callout that is *not* a direct child of the document: §3.5's
 * merge only ever emits them at the top level, `mb_core::conflict::nth` only addresses them
 * there, and offering an action that cannot be applied is worse than offering none.
 */
export function conflictOrdinal(doc: ProseMirrorNode, pos: number): number | undefined {
  if (pos < 0 || pos > doc.content.size) return undefined;
  const resolved = doc.resolve(pos);
  // Depth 0 is what makes this a *top-level* position. Without it, a position inside a
  // conflict callout resolves to the callout containing it — so a nested conflict's buttons
  // would silently resolve the outer one, which is a different reader's decision.
  if (resolved.depth !== 0) return undefined;
  const index = resolved.index(0);
  const node = doc.maybeChild(index);
  if (node === null || node === undefined || !isConflictCallout(node)) return undefined;
  let ordinal = 0;
  for (let before = 0; before < index; before += 1) {
    const node = doc.maybeChild(before);
    if (node !== null && node !== undefined && isConflictCallout(node)) ordinal += 1;
  }
  return ordinal;
}

export interface ConflictViewOptions {
  /** The note's CRDT document, which is what a resolution is read from and written to. */
  readonly document: Doc;
  /** The WASM entry points, already loaded — see `NoteBridge`. */
  readonly bridge: NoteBridge;
}

class CalloutView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement | null;

  private readonly actions: HTMLElement | undefined;

  constructor(
    private node: ProseMirrorNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly options: ConflictViewOptions,
  ) {
    const spec = node.type.spec.toDOM?.(node);
    const rendered =
      spec === undefined
        ? undefined
        : DOMSerializer.renderSpec(
            window.document,
            spec as Parameters<typeof DOMSerializer.renderSpec>[1],
          );
    // A schema with no `toDOM` for `callout` is not reachable — `schema.ts` generates one
    // from the contract — but the type admits it, and an aside is what the contract renders.
    this.dom = asElement(rendered?.dom) ?? window.document.createElement("aside");

    if (!isConflictCallout(node)) {
      // The contract's own rendering, unchanged: `["aside", attrs, 0]` puts the content hole
      // directly in the element, so `contentDOM` is the element.
      this.contentDOM = asElement(rendered?.contentDOM) ?? null;
      this.actions = undefined;
      return;
    }

    // why: a wrapper, only here. The contract renders the content hole *as* the aside, so
    // `contentDOM` and `dom` are the same element — and ProseMirror synchronizes every child
    // of `contentDOM` against the document, which silently deletes an actions bar appended
    // beside them. The blocks go in a child it owns; the buttons sit outside it, where they
    // are ours.
    const body = window.document.createElement("div");
    body.className = "callout-body";
    this.contentDOM = body;
    this.actions = this.buildActions();
    this.dom.replaceChildren(body, this.actions);
  }

  /** Accepts any later state of the same node, keeping the cursor where the reader left it. */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    // A callout that changed kind is a different thing with different actions, and rebuilding
    // the view is the only way to stop offering the old ones.
    if (isConflictCallout(node) !== isConflictCallout(this.node)) return false;
    this.node = node;
    return true;
  }

  /** The actions bar is ours, and ProseMirror must not read it back as note content. */
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean {
    if (this.contentDOM === null) return true;
    return !this.contentDOM.contains(mutation.target);
  }

  /** A click on an action is ours; ProseMirror should not move the selection into it. */
  stopEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Node) || this.actions === undefined) return false;
    return this.actions.contains(target);
  }

  private buildActions(): HTMLElement {
    const bar = window.document.createElement("div");
    bar.className = "conflict-actions";
    bar.dataset["conflictActions"] = "";
    // The attribute rather than the property: the property is what tells ProseMirror this
    // subtree is not the document, and not every DOM implementation reflects it back.
    bar.setAttribute("contenteditable", "false");
    for (const action of ACTIONS) {
      const button = window.document.createElement("button");
      button.type = "button";
      button.className = "conflict-action";
      button.dataset["conflictKeep"] = action.keep;
      button.textContent = action.label;
      button.addEventListener("click", () => this.resolve(action.keep));
      bar.append(button);
    }
    return bar;
  }

  private resolve(keep: ConflictSide): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const ordinal = conflictOrdinal(this.view.state.doc, pos);
    // Nothing, silently, when this callout has no ordinal — it was nested, or the position
    // has gone stale. There is nothing a reader could do about it either way.
    if (ordinal === undefined) return;
    applyResolution({
      view: this.view,
      document: this.options.document,
      bridge: this.options.bridge,
      ordinal,
      keep,
    });
  }
}

function asElement(node: Node | null | undefined): HTMLElement | undefined {
  return node instanceof HTMLElement ? node : undefined;
}

export interface ConflictAnnouncer {
  destroy(): void;
}

/**
 * Announces the open note's unresolved conflict count whenever it changes (§3.5).
 *
 * The editor announces and the shell renders, the same shape `outline.ts` uses: this module
 * is inside ProseMirror and the count is shown in a header it must not have to know about.
 * Announced only on a change, because "update" fires on every keystroke and a count that is
 * still two is not news.
 */
export function mountConflicts(editor: Editor): ConflictAnnouncer {
  let announced: number | undefined;
  const announce = (): void => {
    const count = conflictsOf(editor.state.doc);
    if (count === announced) return;
    announced = count;
    editor.view.dom.dispatchEvent(
      new CustomEvent<ConflictDetail>(CONFLICT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { count },
      }),
    );
  };
  editor.on("update", announce);
  announce();
  return {
    destroy: (): void => {
      editor.off("update", announce);
    },
  };
}

/**
 * Registers the callout node view that carries §3.5's actions.
 *
 * Added alongside the generated extensions in `note-editor.ts` rather than folded into them,
 * so `createMemberberryExtensions` stays a pure function of the schema contract.
 */
export function conflictViews(options: ConflictViewOptions): Extension {
  return Extension.create({
    name: "memberberryConflictView",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("memberberryConflictView"),
          props: {
            nodeViews: {
              callout: (node, view, getPos) => new CalloutView(node, view, getPos, options),
            },
          },
        }),
      ];
    },
  });
}
