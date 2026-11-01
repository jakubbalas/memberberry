/** Lossless in-app clipboard slices; Markdown remains owned by the Rust/WASM codec. */
import { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import type { Transaction } from "@tiptap/pm/state";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import { allowsLocalTransaction, createLoadedSchemaAdmission, validateAttributes } from "./schema-admission.js";
import { SCHEMA_VERSION } from "./schema-revision.js";

/** Private, versioned rich payload alongside standard HTML and plain text. */
export const CLIPBOARD_TYPE = "application/x-memberberry-slice";
const MAX_CLIPBOARD_SIZE = 8 * 1024 * 1024;

/** Writes every format synchronously before a caller may remove selected content. */
export function writeClipboardSlice(view: EditorView, data: Pick<DataTransfer, "clearData" | "setData">, selection: Slice): void {
  const { dom, text, slice } = view.serializeForClipboard(selection);
  const payload = JSON.stringify({ version: SCHEMA_VERSION, slice: slice.toJSON() });
  if (payload.length > MAX_CLIPBOARD_SIZE) throw new Error("selection exceeds clipboard limit");
  data.clearData();
  data.setData("text/html", dom.innerHTML);
  data.setData("text/plain", text);
  data.setData(CLIPBOARD_TYPE, payload);
}

/** An absent custom format delegates to normal browser paste; malformed data fails closed. */
export function readClipboardSlice(view: EditorView, data: Pick<DataTransfer, "getData">): { slice: Slice } | { refused: true } | undefined {
  const payload = data.getData(CLIPBOARD_TYPE);
  if (payload === "") return undefined;
  try {
    if (payload.length > MAX_CLIPBOARD_SIZE) return { refused: true };
    const body: unknown = JSON.parse(payload);
    if (typeof body !== "object" || body === null || !("version" in body) || body.version !== SCHEMA_VERSION
      || !("slice" in body) || typeof body.slice !== "object" || body.slice === null) return { refused: true };
    const value = body.slice;
    if (!("content" in value) || !Array.isArray(value.content) || value.content.length === 0) return { refused: true };
    for (const depth of ["openStart" in value ? value.openStart : 0, "openEnd" in value ? value.openEnd : 0]) {
      if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 || depth > 64) return { refused: true };
    }
    // why: PM's JSON decoder defaults or drops unknown attributes; validate them first.
    // Open slices may contain incomplete parents, so content validity is checked on the
    // prospective inserted document, rather than rejecting a valid partial selection.
    for (const node of value.content) validateAttributes(node);
    return { slice: Slice.fromJSON(view.state.schema, value) };
  } catch {
    return { refused: true };
  }
}

/** Validates an untrusted paste against the real codec before changing the live replica. */
export function allowsClipboardTransaction(view: EditorView, transaction: Transaction): boolean {
  if (!allowsLocalTransaction(transaction)) return false;
  // why: date strings and other semantic constraints belong to Rust. Clipboard paste is
  // an explicit boundary; a scratch document here never touches the live Y.Doc or undo.
  const candidate = prosemirrorJSONToYDoc(view.state.schema, transaction.doc.toJSON());
  try {
    createLoadedSchemaAdmission().validate(candidate);
    return true;
  } catch {
    return false;
  } finally {
    candidate.destroy();
  }
}
