/** Authorized custom artwork for schema emoji atoms and legacy plain-text shortcodes. */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { customEmojiLookup, observeCustomEmoji, type CustomEmoji } from "../custom-emoji.js";

const key = new PluginKey<DecorationSet>("memberberryCustomEmoji");

/** Renders images without putting image URLs or bytes in the note's CRDT/Markdown. */
export function customEmojiViews(vault: string): Extension {
  return Extension.create({
    name: "memberberryCustomEmoji",
    addProseMirrorPlugins() {
      let entries: ReadonlyMap<string, CustomEmoji> = new Map();
      const failed = new Set<string>();
      const renderers = new Set<() => void>();
      const widgetCleanup = new WeakMap<Node, () => void>();
      let view: EditorView | undefined;
      let unsubscribe: (() => void) | undefined;
      let destroyed = false;
      const refresh = (): void => {
        if (view !== undefined && !destroyed) view.dispatch(view.state.tr.setMeta(key, true).setMeta("addToHistory", false));
      };
      const start = (): void => {
        if (unsubscribe !== undefined || destroyed) return;
        unsubscribe = observeCustomEmoji(vault, (catalog) => {
          entries = customEmojiLookup(catalog);
          for (const render of renderers) render();
          refresh();
        });
      };
      const artwork = (shortcode: string): CustomEmoji | undefined => {
        const entry = entries.get(shortcode.toLowerCase());
        return entry !== undefined && !failed.has(entry.imageUrl) ? entry : undefined;
      };
      const fill = (dom: HTMLElement, shortcode: string): (() => void) => {
        const literal = `:${shortcode}:`;
        dom.dataset["emoji"] = shortcode;
        const entry = artwork(shortcode);
        if (entry === undefined) { dom.textContent = literal; return () => undefined; }
        const image = document.createElement("img");
        image.className = "custom-emoji-image";
        image.alt = literal;
        image.src = entry.imageUrl;
        image.draggable = false;
        const error = (): void => {
          failed.add(entry.imageUrl);
          dom.textContent = literal;
          for (const render of renderers) render();
          refresh();
        };
        image.addEventListener("error", error);
        dom.replaceChildren(image);
        return () => image.removeEventListener("error", error);
      };
      const legacy = (doc: PMNode, from = 0, to = doc.content.size): Decoration[] => {
        const decorations: Decoration[] = [];
        doc.nodesBetween(from, to, (node, position, parent) => {
          if (!node.isText || parent?.type.spec.code || node.marks.some((mark) => mark.type.spec.code)) return;
          const text = node.text ?? "";
          if (!text.includes(":")) return;
          for (const match of text.matchAll(/:([a-z0-9_+-]+):/gi)) {
            const shortcode = match[1];
            if (shortcode === undefined) continue;
            const entry = artwork(shortcode);
            if (entry === undefined) continue;
            const start = position + match.index;
            const end = start + match[0].length;
            // why: old picker versions inserted text, which Rust correctly escaped. Display
            // those replicas without rewriting content or creating concurrent CRDT migrations.
            decorations.push(Decoration.inline(start, end, { class: "custom-emoji-legacy-source" }));
            decorations.push(Decoration.widget(start, () => {
              const dom = document.createElement("span");
              dom.contentEditable = "false";
              widgetCleanup.set(dom, fill(dom, shortcode));
              return dom;
            }, { side: -1, key: `${start}:${shortcode}:${entry.imageUrl}`, destroy: (dom) => widgetCleanup.get(dom)?.() }));
          }
        });
        return decorations;
      };
      return [new Plugin<DecorationSet>({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (transaction, previous) => {
            if (transaction.getMeta(key)) return DecorationSet.create(transaction.doc, legacy(transaction.doc));
            const mapped = previous.map(transaction.mapping, transaction.doc);
            if (!transaction.docChanged || entries.size === 0) return mapped;
            const range = changedRange(transaction);
            return mapped.remove(mapped.find(range.from, range.to)).add(transaction.doc, legacy(transaction.doc, range.from, range.to));
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          nodeViews: {
            emoji: (initial) => {
              let node = initial;
              const dom = document.createElement("span");
              let cleanup = (): void => undefined;
              let last: string | undefined;
              const render = (): void => {
                const shortcode = String(node.attrs["shortcode"] ?? "");
                const identity = `${shortcode}\n${artwork(shortcode)?.imageUrl ?? ""}`;
                if (last === identity) return;
                last = identity;
                cleanup();
                cleanup = fill(dom, shortcode);
              };
              renderers.add(render);
              start();
              render();
              return {
                dom, ignoreMutation: () => true,
                update: (next) => { if (next.type !== node.type) return false; node = next; render(); return true; },
                destroy: () => { cleanup(); renderers.delete(render); },
              };
            },
          },
        },
        view: (editorView) => {
          view = editorView;
          if (hasReferences(view.state.doc)) start();
          return {
            update: (_view, previous) => {
              if (unsubscribe === undefined && previous.doc !== editorView.state.doc && hasReferences(editorView.state.selection.$from.parent)) start();
            },
            destroy: () => { destroyed = true; unsubscribe?.(); renderers.clear(); },
          };
        },
      })];
    },
  });
}

function hasReferences(node: PMNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.type.spec.code || child.marks.some((mark) => mark.type.spec.code)) return false;
    if (child.type.name === "emoji" || (child.isText && /:[a-z0-9_+-]+:/i.test(child.text ?? ""))) found = true;
    return !found;
  });
  return found;
}

function changedRange(transaction: Transaction): { from: number; to: number } {
  let from = transaction.doc.content.size;
  let to = 0;
  transaction.mapping.maps.forEach((map, index) => {
    map.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      from = Math.min(from, transaction.mapping.slice(index + 1).map(newFrom, -1));
      to = Math.max(to, transaction.mapping.slice(index + 1).map(newTo, 1));
    });
  });
  transaction.steps.forEach((step, index) => {
    if ("from" in step && typeof step.from === "number" && "to" in step && typeof step.to === "number") {
      from = Math.min(from, transaction.mapping.slice(index).map(step.from, -1));
      to = Math.max(to, transaction.mapping.slice(index).map(step.to, 1));
    }
  });
  if (from > to) { from = transaction.selection.from; to = transaction.selection.to; }
  const start = transaction.doc.resolve(Math.max(0, Math.min(from, transaction.doc.content.size)));
  const end = transaction.doc.resolve(Math.max(0, Math.min(to, transaction.doc.content.size)));
  return {
    from: start.parent.isTextblock ? start.before() : start.pos,
    to: end.parent.isTextblock ? end.after() : end.pos,
  };
}
