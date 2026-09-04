/**
 * Rendering a transclusion inside the editor (`SPEC.md` §9.2).
 *
 * `![[Note]]` used to render as the text `[[Note]]` with an exclamation mark in front of it.
 * This is the view: the target's content, inline, visually distinguished, collapsible, with
 * a jump to its source — and, where §9.2 says it must refuse, a plain link instead.
 *
 * **One class, mounted two ways.** {@link EmbedBlock} is plain DOM and knows nothing about
 * ProseMirror, because an embed nested inside an embed is *not* a node in this document —
 * it arrives as an `<a data-embed>` inside a fragment the server rendered, and something has
 * to replace it in place. The outermost embed is a ProseMirror node view wrapping the same
 * class. That keeps the recursion testable without an editor: a stack four deep is a
 * `document.createElement` away, not a mounted Tiptap instance.
 *
 * **The content is never editable** (§9.2: "editing inside a transclusion is not supported
 * in v1; click through to the source"). So there is no `contentDOM`, every event inside
 * belongs to this view, and every mutation it makes is invisible to ProseMirror — without
 * that, inserting the fetched fragment would look like the reader had typed the target's
 * whole note into this one.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DOMSerializer } from "@tiptap/pm/model";
import type { EditorView, NodeView } from "@tiptap/pm/view";

import {
  type EmbedAnchorKind,
  type EmbedOutcome,
  type EmbedRequest,
  type EmbedStack,
  embedLabel,
  resolveEmbed,
} from "./embed.js";
import { type OpenNoteIntent, openIntent, referenceOf, requestOpenNote } from "./links.js";

/** What an embed needs to know about the note it is written in. */
export interface EmbedContext {
  readonly vault: string;
  /** The open note's canonical identity — element 0 of every resolution stack. */
  readonly note: string;
  /** Injectable so a test can drive the outcomes without a server. */
  readonly resolve?: typeof resolveEmbed;
}

/**
 * One embed, at one depth, as plain DOM.
 *
 * Owns its request, its children and its listeners, and `destroy` releases all three — an
 * embed is created and thrown away every time a pane is closed or a note navigated (§8.2),
 * so a leaked fetch or listener here is a fast leak rather than a slow one.
 */
export class EmbedBlock {
  readonly dom: HTMLElement;

  private readonly bar: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly aborter = new AbortController();
  private readonly children: EmbedBlock[] = [];
  private readonly onToggle: () => void;
  private readonly onBodyClick: (event: MouseEvent) => void;
  private collapsed = false;
  /** The note this embed resolved to, once it has. What jump-to-source opens. */
  private note: string | undefined;
  private destroyed = false;

  constructor(
    private readonly context: EmbedContext,
    private readonly request: EmbedRequest,
    private readonly stack: EmbedStack,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "note-embed";
    // The attribute rather than the property: it is what ProseMirror reads to decide this
    // subtree is not the document, and not every DOM implementation reflects one onto the
    // other.
    this.dom.setAttribute("contenteditable", "false");
    this.dom.dataset["embedState"] = "loading";

    this.bar = document.createElement("span");
    this.bar.className = "note-embed-bar";

    this.toggle = document.createElement("button");
    this.toggle.type = "button";
    this.toggle.className = "note-embed-toggle";
    this.toggle.setAttribute("aria-expanded", "true");
    this.onToggle = () => this.setCollapsed(!this.collapsed);
    this.toggle.addEventListener("click", this.onToggle);

    this.body = document.createElement("span");
    this.body.className = "note-embed-body";
    this.onBodyClick = (event) => this.followLink(event);
    this.body.addEventListener("click", this.onBodyClick);

    this.dom.append(this.bar, this.body);
    this.showStatus("Loading the embedded note…");
    void this.load();
  }

  /** Releases the request, the listeners and every nested embed. */
  destroy(): void {
    this.destroyed = true;
    this.aborter.abort();
    this.toggle.removeEventListener("click", this.onToggle);
    this.body.removeEventListener("click", this.onBodyClick);
    for (const child of this.children) child.destroy();
    this.children.length = 0;
  }

  private async load(): Promise<void> {
    const resolve = this.context.resolve ?? resolveEmbed;
    const outcome = await resolve(this.context.vault, this.request, this.stack, {
      signal: this.aborter.signal,
    });
    // The pane can be closed while the request is in flight, which under tabs and splits
    // happens constantly. Rendering into a detached element is harmless; mounting children
    // that nobody will ever destroy is not.
    if (this.destroyed) return;
    this.render(outcome);
  }

  private render(outcome: EmbedOutcome): void {
    this.dom.dataset["embedState"] = outcome.state;
    this.bar.replaceChildren();
    this.body.replaceChildren();
    switch (outcome.state) {
      case "content": {
        this.note = outcome.content.note;
        const label = embedLabel(outcome.content.note, outcome.content.title);
        this.bar.append(this.toggle, this.sourceButton(label, outcome.content.note));
        this.toggle.setAttribute("aria-label", `Collapse ${label}`);
        this.fill(outcome.content.html);
        this.setCollapsed(this.collapsed);
        break;
      }
      case "no-section": {
        this.note = outcome.note;
        const label = embedLabel(outcome.note, outcome.title);
        this.bar.append(this.sourceButton(label, outcome.note));
        // Deliberately not "unavailable": the note is there and readable, and it simply has
        // no such heading or block. Saying nothing about it would report a typo in a
        // reference as a permission boundary.
        this.showStatus(
          this.request.anchorKind === "block"
            ? `That note has no block ^${this.request.anchor ?? ""}.`
            : `That note has no section “${this.request.anchor ?? ""}”.`,
        );
        break;
      }
      case "cycle":
        this.bar.append(
          this.linkButton(embedLabel(outcome.note, null), outcome.note, true),
          badge("circular embed"),
        );
        break;
      case "depth":
        this.bar.append(
          this.linkButton(this.request.target, this.request.target, false),
          badge("embed limit reached"),
        );
        break;
      default:
        // why: no name, no path, no reason. §6.5 requires a target the reader may not see to
        // be indistinguishable from one that is not there, and this is the placeholder both
        // land on — so anything specific here, including which of the two it is, would be
        // the leak the whole enforcement point exists to prevent.
        this.showStatus("Content unavailable.");
        break;
    }
  }

  /**
   * Inserts the server's fragment and mounts whatever is nested inside it.
   *
   * The fragment is built by `mb-core`'s HTML renderer — the same one the share-link path
   * uses — which escapes every text node and neutralises every URL scheme that executes. It
   * is note content, so it is not trusted, and that renderer is what makes it safe;
   * `innerHTML` here would be a hole with any other producer.
   */
  private fill(html: string): void {
    this.body.innerHTML = html;
    // why: the ids come from `^block-id` anchors, and this is a *copy* of the target's
    // blocks on a page that may already contain the original — or two embeds of it. A
    // duplicated id makes `#^anchor` ambiguous and points every label that uses one at
    // whichever came first.
    for (const element of this.body.querySelectorAll("[id]")) element.removeAttribute("id");
    for (const anchor of this.body.querySelectorAll<HTMLElement>("a[data-embed='true']")) {
      const reference = referenceOf(anchor);
      if (reference === undefined || this.note === undefined) continue;
      const child = new EmbedBlock(this.context, reference, [...this.stack, this.note]);
      this.children.push(child);
      anchor.replaceWith(child.dom);
    }
  }

  private showStatus(text: string): void {
    const status = document.createElement("span");
    status.className = "note-embed-status";
    status.textContent = text;
    this.body.replaceChildren(status);
  }

  private sourceButton(label: string, note: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-embed-source";
    button.textContent = label;
    button.setAttribute("aria-label", `Open ${label}`);
    button.addEventListener("click", (event) => this.open(note, true, openIntent(event)));
    return button;
  }

  /** §9.2's refusal: a plain link, so the reader can still get to the note. */
  private linkButton(label: string, target: string, resolved: boolean): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-embed-link";
    button.textContent = label;
    button.addEventListener("click", (event) => this.open(target, resolved, openIntent(event)));
    return button;
  }

  private setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.dom.dataset["embedCollapsed"] = collapsed ? "true" : "false";
    this.toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    this.toggle.textContent = collapsed ? "▸" : "▾";
  }

  /** A wikilink inside the embedded content opens in the app, not as a page load. */
  private followLink(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest<HTMLElement>("a[data-target]");
    if (anchor === null || !this.body.contains(anchor)) return;
    const reference = referenceOf(anchor);
    if (reference === undefined) return;
    event.preventDefault();
    requestOpenNote(this.dom, {
      ...reference,
      intent: openIntent(event),
      resolved: false,
      // The link was written in the note this embed is *showing*, not in the note the pane
      // is on, and which note it means depends on which of the two it is read from (§4.3).
      ...(this.note === undefined ? {} : { from: this.note }),
    });
  }

  private open(target: string, resolved: boolean, intent: OpenNoteIntent): void {
    requestOpenNote(this.dom, {
      target,
      // Jumping to the source opens the note, not the section: a reader who followed an
      // embed of one heading wants the note it came from.
      anchorKind: "none",
      anchor: null,
      intent,
      resolved,
    });
  }
}

/**
 * The ProseMirror node view for a wikilink.
 *
 * Registered for every wikilink because node views are keyed by node type, and an `![[…]]`
 * and a `[[…]]` are one type with one attribute between them. A plain link falls back to the
 * schema's own rendering rather than to a second copy of it here — `schema.ts` is generated
 * from the Rust-owned contract, and a hand-written duplicate would be the drift it exists to
 * prevent.
 */
class WikiLinkView implements NodeView {
  readonly dom: HTMLElement;
  private readonly embed: EmbedBlock | undefined;
  private readonly onClick: ((event: MouseEvent) => void) | undefined;

  constructor(context: EmbedContext, private node: ProseMirrorNode) {
    if (node.attrs["embed"] !== true) {
      this.dom = renderBySchema(node);
      // why: a listener on the element rather than ProseMirror's `handleClickOn`. That hook
      // is reached through `posAtCoords`, which needs layout — so under jsdom it never
      // fires, and a test for it would be a test that cannot fail (`AGENTS.md` §2.3). The
      // link is an atom node with its own element; hearing the click on it is both simpler
      // and observable.
      this.onClick = (event) => {
        if (event.button !== 0) return;
        const reference = referenceFromAttrs(node);
        if (reference === undefined) return;
        event.preventDefault();
        requestOpenNote(this.dom, {
          ...reference,
          intent: openIntent(event),
          resolved: false,
        });
      };
      this.dom.addEventListener("click", this.onClick);
      return;
    }
    const anchorKind = node.attrs["anchor_kind"];
    const anchorText = node.attrs["anchor_text"];
    const request: EmbedRequest = {
      target: typeof node.attrs["target"] === "string" ? node.attrs["target"] : "",
      anchorKind: anchorKind === "heading" || anchorKind === "block" ? anchorKind : "none",
      anchor: typeof anchorText === "string" ? anchorText : null,
    };
    this.embed = new EmbedBlock(context, request, [context.note]);
    this.dom = this.embed.dom;
  }

  /**
   * Accepts a later state of the same node only when the reference has not changed.
   *
   * Rejecting the update makes ProseMirror rebuild the view, which is exactly right when the
   * target changed: the content of an embed *is* its attributes, so a new reference is a new
   * request rather than a re-render.
   */
  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (!node.sameMarkup(this.node)) return false;
    this.node = node;
    return true;
  }

  /** Everything in here is ours: there is no editable content inside an embed (§9.2). */
  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(): boolean {
    return this.embed !== undefined;
  }

  destroy(): void {
    this.embed?.destroy();
    if (this.onClick !== undefined) this.dom.removeEventListener("click", this.onClick);
  }
}

/** The reference a wikilink *node* carries, as `links.ts` reads one off an element. */
function referenceFromAttrs(
  node: ProseMirrorNode,
): { target: string; anchorKind: EmbedAnchorKind; anchor: string | null } | undefined {
  const target = node.attrs["target"];
  if (typeof target !== "string" || target === "") return undefined;
  const kind = node.attrs["anchor_kind"];
  const text = node.attrs["anchor_text"];
  if (kind === "heading" || kind === "block") {
    return { target, anchorKind: kind, anchor: typeof text === "string" ? text : null };
  }
  return { target, anchorKind: "none", anchor: null };
}

/** The node's own `renderHTML`, so a plain wikilink has exactly one rendering. */
function renderBySchema(node: ProseMirrorNode): HTMLElement {
  const spec = node.type.spec.toDOM?.(node);
  if (spec === undefined) {
    const fallback = document.createElement("span");
    fallback.textContent = `[[${String(node.attrs["target"] ?? "")}]]`;
    return fallback;
  }
  const { dom } = DOMSerializer.renderSpec(document, spec);
  return dom instanceof HTMLElement ? dom : wrap(dom);
}

function wrap(node: Node): HTMLElement {
  const span = document.createElement("span");
  span.append(node);
  return span;
}

function badge(text: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "note-embed-badge";
  element.textContent = text;
  return element;
}

/**
 * Registers the wikilink node view.
 *
 * Takes the context rather than reading it from anywhere: the vault and the open note are
 * what `note-surface.ts` already knows, and an editor with no server behind it — the
 * `npm run dev` local-only replica — simply does not add this extension, so an embed there
 * renders as the plain link it was before.
 */
export function embedViews(context: EmbedContext): Extension {
  return Extension.create({
    name: "memberberryEmbedView",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("memberberryEmbedView"),
          props: {
            nodeViews: {
              wikilink: (node) => new WikiLinkView(context, node),
            },
          },
        }),
      ];
    },
  });
}

/** The anchor kinds a reference may carry, re-exported for callers building one. */
export type { EmbedAnchorKind };
