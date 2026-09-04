// @vitest-environment jsdom

/**
 * What a transclusion actually renders (`SPEC.md` §9.2, §22.7).
 *
 * `embed.test.ts` covers the decisions; this covers the DOM they produce, because a decision
 * nobody can see is not a feature. The M8 backlinks work is the precedent: the unit suite
 * stayed green with the panel set to `display: none`, and jsdom applies no stylesheet — so
 * what these assert is *structure and content*, and `web/e2e/embed.spec.ts` is what says a
 * reader can see it.
 *
 * Nested embeds are driven through {@link EmbedBlock} directly rather than through a mounted
 * editor. That is not a shortcut around the real thing: a nested embed genuinely is plain
 * DOM replacing an `<a data-embed>` in a fragment, and no ProseMirror node exists for it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import { EmbedBlock, embedViews } from "./embed-view.js";
import type { EmbedOutcome, EmbedRequest, resolveEmbed } from "./embed.js";
import { OPEN_NOTE_EVENT, type OpenNoteDetail } from "./links.js";
import { createMemberberryExtensions } from "./schema.js";

const contractPath = resolve(process.cwd(), "../crates/mb-core/schema.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;

const REQUEST: EmbedRequest = { target: "Roadmap", anchorKind: "none", anchor: null };

/** A resolver that answers with `outcome`, recording the stacks it was asked about. */
function resolver(...outcomes: readonly EmbedOutcome[]) {
  const stacks: string[][] = [];
  const queue = [...outcomes];
  const resolve: typeof resolveEmbed = async (_vault, _request, stack) => {
    stacks.push([...stack]);
    return queue.length > 1 ? (queue.shift() as EmbedOutcome) : (queue[0] as EmbedOutcome);
  };
  return { resolve, stacks };
}

function content(note: string, html: string, title: string | null = null): EmbedOutcome {
  return { state: "content", content: { note, title, html, found: true } };
}

/** Mounts one embed and waits for its request to settle. */
async function block(outcome: EmbedOutcome, request = REQUEST): Promise<EmbedBlock> {
  const { resolve } = resolver(outcome);
  const embed = new EmbedBlock({ vault: "v", note: "Host.md", resolve }, request, ["Host.md"]);
  document.body.append(embed.dom);
  await vi.waitFor(() => expect(embed.dom.dataset["embedState"]).not.toBe("loading"));
  return embed;
}

describe("an expanded embed", () => {
  it("renders the target's content", async () => {
    const embed = await block(content("Projects/Roadmap.md", "<p>Ship it.</p>", "The Plan"));
    expect(embed.dom.dataset["embedState"]).toBe("content");
    expect(embed.dom.querySelector(".note-embed-body")?.textContent).toContain("Ship it.");
    embed.destroy();
  });

  it("labels its jump-to-source with the target's title", async () => {
    const embed = await block(content("Projects/Roadmap.md", "<p>a</p>", "The Plan"));
    const source = embed.dom.querySelector<HTMLButtonElement>(".note-embed-source");
    expect(source?.textContent).toBe("The Plan");
    expect(source?.getAttribute("aria-label")).toBe("Open The Plan");
    embed.destroy();
  });

  it("falls back to the filename when the target has no title", async () => {
    const embed = await block(content("Projects/Roadmap.md", "<p>a</p>", null));
    expect(embed.dom.querySelector(".note-embed-source")?.textContent).toBe("Roadmap");
    embed.destroy();
  });

  it("collapses and expands, and says which it is", async () => {
    const embed = await block(content("A.md", "<p>body</p>"));
    const toggle = embed.dom.querySelector<HTMLButtonElement>(".note-embed-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(embed.dom.dataset["embedCollapsed"]).toBe("false");
    toggle?.click();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(embed.dom.dataset["embedCollapsed"]).toBe("true");
    toggle?.click();
    expect(embed.dom.dataset["embedCollapsed"]).toBe("false");
    embed.destroy();
  });

  it("strips the ids out of the copy it renders", async () => {
    // The fragment is a *copy* of the target's blocks, on a page that may already hold the
    // original or a second embed of it. Two elements with one id make every `#^anchor`
    // ambiguous.
    const embed = await block(content("A.md", '<p id="b-1">anchored</p>'));
    expect(embed.dom.querySelector("[id]")).toBeNull();
    expect(embed.dom.textContent).toContain("anchored");
    embed.destroy();
  });

  it("is not editable, so a reader clicks through to the source instead (§9.2)", async () => {
    const embed = await block(content("A.md", "<p>body</p>"));
    expect(embed.dom.getAttribute("contenteditable")).toBe("false");
    embed.destroy();
  });
});

describe("the placeholders", () => {
  it("says nothing at all about an unavailable target", async () => {
    // §6.5: a note the reader may not see is indistinguishable from one that is not there,
    // so the placeholder cannot name it, hint at it, or say which of the two it is.
    const embed = await block({ state: "unavailable" }, { ...REQUEST, target: "Secret" });
    expect(embed.dom.textContent).toBe("Content unavailable.");
    expect(embed.dom.textContent).not.toContain("Secret");
    expect(embed.dom.querySelector(".note-embed-source")).toBeNull();
    embed.destroy();
  });

  it("reports a readable note with no such section as its own state", async () => {
    const embed = await block(
      { state: "no-section", note: "Projects/Roadmap.md", title: "The Plan" },
      { target: "Roadmap", anchorKind: "heading", anchor: "Risks" },
    );
    expect(embed.dom.dataset["embedState"]).toBe("no-section");
    expect(embed.dom.textContent).toContain("Risks");
    expect(embed.dom.querySelector(".note-embed-source")?.textContent).toBe("The Plan");
    embed.destroy();
  });

  it("names the block for a block reference that is not there", async () => {
    const embed = await block(
      { state: "no-section", note: "A.md", title: null },
      { target: "A", anchorKind: "block", anchor: "b-1" },
    );
    expect(embed.dom.textContent).toContain("^b-1");
    embed.destroy();
  });

  it("renders a cycle as a plain link with a circular-embed affordance", async () => {
    const embed = await block({ state: "cycle", note: "Host.md" });
    expect(embed.dom.dataset["embedState"]).toBe("cycle");
    expect(embed.dom.querySelector(".note-embed-badge")?.textContent).toBe("circular embed");
    expect(embed.dom.querySelector(".note-embed-link")?.textContent).toBe("Host");
    embed.destroy();
  });

  it("renders the depth limit as a plain link too", async () => {
    const embed = await block({ state: "depth" });
    expect(embed.dom.dataset["embedState"]).toBe("depth");
    expect(embed.dom.querySelector(".note-embed-badge")?.textContent).toBe(
      "embed limit reached",
    );
    expect(embed.dom.querySelector(".note-embed-link")?.textContent).toBe("Roadmap");
    embed.destroy();
  });
});

describe("nesting", () => {
  it("mounts an embed inside an embed, one note deeper", async () => {
    const { resolve, stacks } = resolver(
      content("Outer.md", '<p>outer <a class="mb-embed" data-embed="true" data-target="Inner">Inner</a></p>'),
      content("Inner.md", "<p>inner</p>"),
    );
    const embed = new EmbedBlock({ vault: "v", note: "Host.md", resolve }, REQUEST, ["Host.md"]);
    document.body.append(embed.dom);
    await vi.waitFor(() => expect(embed.dom.textContent).toContain("inner"));
    expect(stacks).toEqual([["Host.md"], ["Host.md", "Outer.md"]]);
    expect(embed.dom.querySelectorAll(".note-embed").length).toBe(1);
    embed.destroy();
  });

  it("passes the nested reference's anchor along", async () => {
    const { resolve } = resolver(
      content(
        "Outer.md",
        '<p><a class="mb-embed" data-embed="true" data-target="Inner" data-anchor-kind="heading" data-anchor="Risks">Inner</a></p>',
      ),
      { state: "no-section", note: "Inner.md", title: null },
    );
    const embed = new EmbedBlock({ vault: "v", note: "Host.md", resolve }, REQUEST, ["Host.md"]);
    document.body.append(embed.dom);
    await vi.waitFor(() => expect(embed.dom.textContent).toContain("Risks"));
    embed.destroy();
  });

  it("destroys its children, so nothing is left holding a request", async () => {
    const destroyed: string[] = [];
    const { resolve } = resolver(
      content("Outer.md", '<p><a class="mb-embed" data-embed="true" data-target="Inner">i</a></p>'),
      content("Inner.md", "<p>inner</p>"),
    );
    const embed = new EmbedBlock({ vault: "v", note: "Host.md", resolve }, REQUEST, ["Host.md"]);
    document.body.append(embed.dom);
    await vi.waitFor(() => expect(embed.dom.textContent).toContain("inner"));
    const child = embed.dom.querySelector(".note-embed");
    if (child === null) throw new Error("no nested embed to destroy");
    child.addEventListener(OPEN_NOTE_EVENT, () => destroyed.push("nested"));
    embed.destroy();
    // The child's own listeners are gone: clicking what is left raises nothing.
    embed.dom.querySelector<HTMLButtonElement>(".note-embed-toggle")?.click();
    expect(destroyed).toEqual([]);
  });

  it("renders nothing deeper than a fragment that never resolved", async () => {
    // A nested embed can only be mounted once the parent has an identity to push onto the
    // stack. Without one there is nothing to compare against, and expanding anyway is how a
    // cycle becomes unbounded.
    const { resolve } = resolver({ state: "unavailable" });
    const embed = new EmbedBlock({ vault: "v", note: "Host.md", resolve }, REQUEST, ["Host.md"]);
    document.body.append(embed.dom);
    await vi.waitFor(() => expect(embed.dom.dataset["embedState"]).toBe("unavailable"));
    expect(embed.dom.querySelectorAll(".note-embed").length).toBe(0);
    embed.destroy();
  });
});

describe("following a link out of an embed", () => {
  /** The details raised at `element` while `run` executes. */
  async function opened(element: HTMLElement, run: () => void): Promise<OpenNoteDetail[]> {
    const seen: OpenNoteDetail[] = [];
    const listen = (event: Event): void => {
      if (event instanceof CustomEvent) seen.push(event.detail as OpenNoteDetail);
    };
    document.body.addEventListener(OPEN_NOTE_EVENT, listen);
    run();
    await Promise.resolve();
    document.body.removeEventListener(OPEN_NOTE_EVENT, listen);
    void element;
    return seen;
  }

  it("jumps to the source, already resolved", async () => {
    const embed = await block(content("Projects/Roadmap.md", "<p>a</p>", "The Plan"));
    const seen = await opened(embed.dom, () =>
      embed.dom.querySelector<HTMLButtonElement>(".note-embed-source")?.click(),
    );
    expect(seen).toEqual([
      {
        target: "Projects/Roadmap.md",
        anchorKind: "none",
        anchor: null,
        intent: "here",
        resolved: true,
      },
    ]);
    embed.destroy();
  });

  it("jumps to the note rather than to the section it embedded", async () => {
    const embed = await block(
      content("Projects/Roadmap.md", "<p>a</p>", "The Plan"),
      { target: "Roadmap", anchorKind: "heading", anchor: "Risks" },
    );
    const seen = await opened(embed.dom, () =>
      embed.dom.querySelector<HTMLButtonElement>(".note-embed-source")?.click(),
    );
    expect(seen[0]?.anchorKind).toBe("none");
    embed.destroy();
  });

  it("opens a wikilink inside the embedded content, from the embedded note", async () => {
    // §4.3 resolves a name collision relative to the note the reference was *written* in,
    // and this one was written in the note being transcluded.
    const embed = await block(
      content("Projects/Roadmap.md", '<p><a class="mb-wikilink" data-target="Q3">Q3</a></p>'),
    );
    const link = embed.dom.querySelector<HTMLElement>("a.mb-wikilink");
    const seen = await opened(embed.dom, () => link?.click());
    expect(seen).toEqual([
      {
        target: "Q3",
        anchorKind: "none",
        anchor: null,
        intent: "here",
        resolved: false,
        from: "Projects/Roadmap.md",
      },
    ]);
    embed.destroy();
  });

  it("leaves an ordinary external link alone", async () => {
    const embed = await block(
      content("A.md", '<p><a href="https://example.com">out</a></p>'),
    );
    const seen = await opened(embed.dom, () =>
      embed.dom.querySelector<HTMLElement>("a[href]")?.click(),
    );
    expect(seen).toEqual([]);
    embed.destroy();
  });
});

describe("the node view", () => {
  /** A document with one wikilink, embedded or not. */
  function noteWith(attrs: Readonly<Record<string, unknown>>) {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "wikilink", attrs: { target: "Roadmap", anchor_kind: "none", ...attrs } },
          ],
        },
      ],
    };
  }

  function mount(attrs: Readonly<Record<string, unknown>>, outcome: EmbedOutcome) {
    const element = document.createElement("div");
    document.body.append(element);
    const { resolve } = resolver(outcome);
    const editor = new Editor({
      element,
      extensions: [
        ...createMemberberryExtensions(contract),
        embedViews({ vault: "v", note: "Host.md", resolve }),
      ],
      content: noteWith(attrs),
    });
    return { editor, element };
  }

  it("renders an embed for `![[…]]`", async () => {
    const { editor, element } = mount({ embed: true }, content("A.md", "<p>embedded</p>"));
    await vi.waitFor(() => expect(element.textContent).toContain("embedded"));
    expect(element.querySelector(".note-embed")).not.toBeNull();
    editor.destroy();
  });

  it("leaves a plain `[[…]]` to the schema's own rendering", async () => {
    const { editor, element } = mount({ embed: false }, content("A.md", "<p>x</p>"));
    expect(element.querySelector(".note-embed")).toBeNull();
    const rendered = element.querySelector("[data-wikilink]");
    expect(rendered?.textContent).toBe("[[Roadmap]]");
    editor.destroy();
  });

  it("follows a plain `[[…]]` when it is clicked (§8.2)", async () => {
    const { editor, element } = mount({ embed: false }, content("A.md", "<p>x</p>"));
    const seen: OpenNoteDetail[] = [];
    element.addEventListener(OPEN_NOTE_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push(event.detail as OpenNoteDetail);
    });
    element.querySelector<HTMLElement>("[data-wikilink]")?.click();
    expect(seen).toEqual([
      { target: "Roadmap", anchorKind: "none", anchor: null, intent: "here", resolved: false },
    ]);
    editor.destroy();
  });

  it("carries a plain link's anchor along", async () => {
    const { editor, element } = mount(
      { embed: false, anchor_kind: "heading", anchor_text: "Risks" },
      content("A.md", "<p>x</p>"),
    );
    const seen: OpenNoteDetail[] = [];
    element.addEventListener(OPEN_NOTE_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push(event.detail as OpenNoteDetail);
    });
    element.querySelector<HTMLElement>("[data-wikilink]")?.click();
    expect(seen[0]).toMatchObject({ anchorKind: "heading", anchor: "Risks" });
    editor.destroy();
  });

  it("reads the modifiers as §8.2's three intents", async () => {
    const { editor, element } = mount({ embed: false }, content("A.md", "<p>x</p>"));
    const seen: OpenNoteDetail[] = [];
    element.addEventListener(OPEN_NOTE_EVENT, (event) => {
      if (event instanceof CustomEvent) seen.push(event.detail as OpenNoteDetail);
    });
    const link = element.querySelector<HTMLElement>("[data-wikilink]");
    for (const modifiers of [
      {},
      { metaKey: true },
      { ctrlKey: true },
      { metaKey: true, altKey: true },
      { altKey: true },
    ]) {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, ...modifiers }));
    }
    expect(seen.map((detail) => detail.intent)).toEqual([
      "here",
      "tab",
      "tab",
      "split",
      // Alt alone is not a modifier §8.2 gives a meaning to.
      "here",
    ]);
    editor.destroy();
  });

  it("stops listening once the editor is gone", async () => {
    const { editor, element } = mount({ embed: false }, content("A.md", "<p>x</p>"));
    const link = element.querySelector<HTMLElement>("[data-wikilink]");
    if (link === null) throw new Error("no rendered wikilink");
    const seen: Event[] = [];
    document.body.addEventListener(OPEN_NOTE_EVENT, (event) => seen.push(event));
    editor.destroy();
    document.body.append(link);
    link.click();
    expect(seen).toEqual([]);
  });

  it("releases the embed when the editor goes away", async () => {
    const { editor, element } = mount({ embed: true }, content("A.md", "<p>embedded</p>"));
    await vi.waitFor(() => expect(element.textContent).toContain("embedded"));
    editor.destroy();
    expect(element.querySelector(".note-embed")).toBeNull();
  });
});
