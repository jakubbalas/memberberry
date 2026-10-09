/**
 * Toggles: foldable callouts (`> [!note]+ Summary` / `> [!note]- Summary`, SPEC §8.4).
 *
 * The `+`/`-` in the file is each toggle's default. ▸/▾ and Mod-Enter fold the reader's own
 * view and never write the note, so folding is not an edit, does not sync, and works read-only.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** Positions of toggles whose view differs from the file's default. */
interface FoldState { readonly flipped: ReadonlySet<number> }

const key = new PluginKey<FoldState>("memberberryCalloutFold");

function foldable(node: PMNode | null | undefined): node is PMNode {
  return node?.type.name === "callout" && node.attrs["fold"] !== "none";
}

function isFolded(state: EditorState, pos: number): boolean {
  const node = state.doc.nodeAt(pos);
  if (!foldable(node)) return false;
  return (node.attrs["fold"] === "collapsed") !== (key.getState(state)?.flipped.has(pos) ?? false);
}

/** The innermost foldable callout containing the selection head, as its start position. */
function enclosing(state: EditorState): number | undefined {
  const { $head } = state.selection;
  for (let depth = $head.depth; depth > 0; depth--) {
    if (foldable($head.node(depth))) return $head.before(depth);
  }
  return undefined;
}

function toggle(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!foldable(node)) return false;
  const tr = view.state.tr.setMeta(key, pos);
  const title = node.firstChild;
  const { head } = view.state.selection;
  // why: a caret inside the body it is about to hide would type into invisible text.
  if (!isFolded(view.state, pos) && title !== null && head > pos + 1 + title.nodeSize && head < pos + node.nodeSize) {
    tr.setSelection(TextSelection.create(tr.doc, pos + title.nodeSize));
  }
  view.dispatch(tr);
  return true;
}

function decorations(state: EditorState): DecorationSet {
  const found: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!foldable(node)) return true;
    const folded = isFolded(state, pos);
    found.push(Decoration.node(pos, pos + node.nodeSize, { class: folded ? "mb-folded" : "mb-unfolded" }));
    found.push(Decoration.widget(pos + 2, (view, getPos) => {
      const button = view.dom.ownerDocument.createElement("button");
      button.type = "button";
      button.className = "mb-fold-toggle";
      button.contentEditable = "false";
      // why: no text node. The arrow is CSS (keyed on aria-expanded), so the summary's
      // text content stays exactly the file's — for copy, find and screen readers.
      button.setAttribute("aria-expanded", String(!folded));
      button.setAttribute("aria-label", folded ? "Expand toggle" : "Collapse toggle");
      button.addEventListener("mousedown", (event) => { event.preventDefault(); });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        const at = getPos();
        if (at !== undefined) toggle(view, at - 2);
      });
      return button;
    }, { side: -1, key: `fold-${String(pos)}-${String(folded)}`, ignoreSelection: true, stopEvent: () => true }));
    return true;
  });
  return DecorationSet.create(state.doc, found);
}

/** Fold controls for every foldable callout. Install at editor construction. */
export const calloutFold = Extension.create({
  name: "memberberryCalloutFold",
  // why: Tiptap's core keymap binds Mod-Enter to exitCode. Run first; outside a toggle the
  // shortcut returns false and falls through to that default unchanged.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => {
        const pos = enclosing(this.editor.state);
        return pos !== undefined && toggle(this.editor.view, pos);
      },
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin<FoldState>({
      key,
      state: {
        init: () => ({ flipped: new Set<number>() }),
        apply: (tr, value, _old, next) => {
          const flipped = new Set<number>();
          for (const pos of value.flipped) {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted && foldable(next.doc.nodeAt(mapped.pos))) flipped.add(mapped.pos);
          }
          const target = tr.getMeta(key) as number | undefined;
          if (target !== undefined && !flipped.delete(target)) flipped.add(target);
          return { flipped };
        },
      },
      props: { decorations: (state) => decorations(state) },
    })];
  },
});
