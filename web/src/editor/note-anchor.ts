import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { encodeStateAsUpdate } from "yjs";
import { extract, markdownFromUpdate } from "../notes.js";
import type { OpenNoteDetail } from "./links.js";

/** A section or block of an already-authorized, mounted note. */
export type NoteAnchor = Pick<OpenNoteDetail, "anchorKind" | "anchor">;

/** Find a schema position, never a DOM id from a transcluded copy or another pane. */
export async function noteAnchorPosition(doc: ProseMirrorNode, reference: NoteAnchor): Promise<number | undefined> {
  if (reference.anchor === null || reference.anchor === "" || reference.anchorKind === "none") return undefined;
  let found: number | undefined;
  if (reference.anchorKind === "heading") {
    // Same heading identity as mb-core/transclude.rs: NFC, trimmed, lowercased.
    const fold = (value: string): string => value.trim().normalize("NFC").toLowerCase();
    const wanted = fold(reference.anchor);
    const headings: { node: ProseMirrorNode; position: number }[] = [];
    doc.forEach((node, position) => {
      if (node.type.name === "heading") headings.push({ node, position });
    });
    if (headings.length === 0) return undefined;
    // why: textContent omits inline atoms, while DOM text includes editor-only syntax.
    // Use the existing schema/CRDT conversion and core's plain-text extraction, just for
    // top-level headings so quoted/transcluded copies cannot become navigation targets.
    const model = prosemirrorToYDoc(doc.type.create(doc.attrs, headings.map(({ node }) => node)));
    try {
      const facts = await extract(await markdownFromUpdate(encodeStateAsUpdate(model)));
      return headings[facts.headings.findIndex(({ text }) => fold(text) === wanted)]?.position;
    } finally { model.destroy(); }
  } else {
    doc.descendants((node, position) => {
      if (found !== undefined) return false;
      if (node.isBlock && node.attrs["anchor"] === reference.anchor) found = position;
      return found === undefined;
    });
  }
  return found;
}

/** Owns one pending jump while a note's asynchronous body arrives; releases all work on close. */
export function noteAnchorNavigator(editor: Editor, ready: () => boolean = () => true): {
  follow(reference: NoteAnchor): void;
  refresh(): void;
  destroy(): void;
} {
  let pending: NoteAnchor | undefined;
  let frame: number | undefined;
  let destroyed = false;
  const window = editor.view.dom.ownerDocument.defaultView;
  const jump = async (): Promise<void> => {
    frame = undefined;
    if (destroyed || pending === undefined || !ready()) return;
    const reference = pending;
    const doc = editor.state.doc;
    const position = await noteAnchorPosition(doc, reference);
    // why: WASM loading/conversion yields; a newer request, edit or closed pane owns the
    // viewport now, so a position computed from the old document must never scroll it.
    if (destroyed || pending !== reference || editor.state.doc !== doc || !ready() || position === undefined) return;
    const element = editor.view.nodeDOM(position);
    if (!(element instanceof HTMLElement)) return;
    pending = undefined;
    // why: run after mount/layout and after title-cursor placement, so neither restore
    // scroll nor the initial focus can move the reader away from their requested section.
    element.scrollIntoView({ block: "start", behavior: "auto" });
  };
  const refresh = (): void => {
    if (destroyed || pending === undefined || frame !== undefined) return;
    frame = window?.requestAnimationFrame(jump);
  };
  editor.on("update", refresh);
  return {
    follow: (reference) => { pending = reference; refresh(); },
    refresh,
    destroy: () => {
      destroyed = true;
      pending = undefined;
      if (frame !== undefined) window?.cancelAnimationFrame(frame);
      frame = undefined;
      editor.off("update", refresh);
    },
  };
}
