/**
 * Shift-Enter: a second line in the same block (SPEC §8.4).
 *
 * Inserts a Markdown hard break (`\` + newline) inside a paragraph, wherever that paragraph
 * sits — top level, list item, quote, callout or toggle body. Headings and toggle summaries
 * are single-line in Markdown, and table cells own their own Enter handling
 * (`table-tools.ts`), so those fall through.
 */
import { Extension } from "@tiptap/core";

/** Shift-Enter inserts a hard break in a paragraph. Install at editor construction. */
export const lineBreak = Extension.create({
  name: "memberberryLineBreak",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => {
        const { state, view } = this.editor;
        const { $from, $to } = state.selection;
        const hardBreak = state.schema.nodes["hard_break"];
        if (!this.editor.isEditable || hardBreak === undefined
          || $from.parent.type.name !== "paragraph" || !$from.sameParent($to)) return false;
        view.dispatch(state.tr.replaceSelectionWith(hardBreak.create(), false).scrollIntoView());
        return true;
      },
    };
  },
});
