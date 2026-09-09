/** Creates one locally durable Tiptap editor session for a Memberberry note. */

import { Editor, type Extensions } from "@tiptap/core";

import type { NoteBridge } from "../notes.js";
import {
  createNoteCollaboration,
  createYjsBinding,
  type CreateNoteCollaborationOptions,
  type NoteCollaboration,
} from "./collaboration.js";
import { conflictViews } from "./conflict-view.js";
import { type EmbedContext, embedViews } from "./embed-view.js";
import { loadMemberberryExtensions } from "./schema.js";
import type { MediaRenderContext } from "./schema.js";
import { memberberryInputRules } from "./commands.js";
import { taskItemView } from "./task-view.js";
import { pdfViews } from "./pdf-view.js";
import { emojiInputRules } from "./commands.js";
import { emojiCatalog } from "../emoji-catalog.js";
import type { EmojiEntry } from "../notes.js";

export interface EditorHandle {
  destroy(): void;
}

export interface CreateEditorOptions {
  readonly element: HTMLElement;
  readonly extensions: Extensions;
  readonly editable: boolean;
}

export type EditorFactory = (options: CreateEditorOptions) => EditorHandle;

export interface StartNoteEditorOptions extends CreateNoteCollaborationOptions {
  readonly element: HTMLElement;
  readonly editable?: boolean;
  readonly createEditor?: EditorFactory;
  readonly loadExtensions?: () => Promise<Extensions>;
  /**
   * What a transclusion resolves against (§9.2), or `undefined` for no server.
   *
   * why: absent rather than defaulted. A local-only replica — `npm run dev`, and what the
   * editor falls back to rather than syncing under an identity nobody authenticated — has no
   * route to ask, and an embed there renders as the plain link it always did. Defaulting to
   * a vault name nobody granted would put a request per embed against a 404.
   */
  readonly embeds?: EmbedContext | undefined;
  /**
   * The WASM entry points §3.5's conflict actions need, already loaded.
   *
   * why: absent rather than defaulted. A conflict callout without it still renders and still
   * round-trips — it is an ordinary callout to the parser and the serializer — it just
   * carries no buttons, which is the honest state for an editor mounted with no note
   * boundary behind it. Loading the module here instead would put a WASM fetch on the path
   * of every editor, including the ones a test mounts.
   */
  readonly bridge?: NoteBridge | undefined;
  readonly media?: MediaRenderContext | undefined;
  readonly loadEmojiCatalog?: () => Promise<readonly EmojiEntry[]>;
}

/** A mounted editor and the local Y.Doc it is attached to. */
export interface NoteEditor {
  readonly editor: EditorHandle;
  readonly collaboration: NoteCollaboration;
  destroy(): Promise<void>;
}

/**
 * Restores local state, then mounts a Tiptap editor that maps every transaction into Yjs.
 *
 * The wait is intentional: mounting an empty editor before IndexedDB has restored a note
 * risks producing an initialization transaction before the durable local replica is present.
 */
export async function startNoteEditor(options: StartNoteEditorOptions): Promise<NoteEditor> {
  const collaboration = createNoteCollaboration(options);
  try {
    await collaboration.whenReady;
    const extensions = await (options.loadExtensions ?? (() => loadMemberberryExtensions(options.media)))();
    const catalog = await (options.loadEmojiCatalog ?? emojiCatalog)().catch(() => []);
    const createEditor = options.createEditor ?? defaultEditorFactory;
    const editor = createEditor({
      element: options.element,
      extensions: [
        ...extensions,
        memberberryInputRules,
        emojiInputRules(catalog),
        taskItemView,
        ...(options.embeds === undefined ? [] : [embedViews(options.embeds)]),
        ...(options.media === undefined ? [] : [pdfViews(options.media)]),
        ...(options.bridge === undefined
          ? []
          : [conflictViews({ document: collaboration.document, bridge: options.bridge })]),
        createYjsBinding(collaboration.fragment, collaboration.awareness),
      ],
      editable: options.editable ?? true,
    });
    let destroyed: Promise<void> | undefined;
    return {
      editor,
      collaboration,
      destroy: () => {
        destroyed ??= Promise.resolve().then(() => {
          editor.destroy();
        }).then(collaboration.destroy);
        return destroyed;
      },
    };
  } catch (error) {
    await collaboration.destroy();
    throw error;
  }
}

function defaultEditorFactory(options: CreateEditorOptions): EditorHandle {
  return new Editor(options);
}
