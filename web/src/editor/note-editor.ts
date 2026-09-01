/** Creates one locally durable Tiptap editor session for a Memberberry note. */

import { Editor, type Extensions } from "@tiptap/core";

import {
  createNoteCollaboration,
  createYjsBinding,
  type CreateNoteCollaborationOptions,
  type NoteCollaboration,
} from "./collaboration.js";
import { loadMemberberryExtensions } from "./schema.js";
import { memberberryInputRules } from "./commands.js";

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
    const extensions = await (options.loadExtensions ?? loadMemberberryExtensions)();
    const createEditor = options.createEditor ?? defaultEditorFactory;
    const editor = createEditor({
      element: options.element,
      extensions: [...extensions, memberberryInputRules, createYjsBinding(collaboration.fragment)],
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
