/**
 * The backlinks client: what it validates, and what it does when two notes race.
 *
 * `mb-index` owns which links exist and who may see them. What is testable here is the part
 * the server cannot get wrong for us — a malformed response reaching the DOM, and a slow
 * answer for the previous note landing in the panel.
 */

import { describe, expect, it, vi } from "vitest";

import {
  type BacklinksResponse,
  fetchBacklinks,
  readBacklinks,
  sourceLabel,
} from "./backlinks.js";
import { BacklinkView } from "./backlinks.svelte.js";

const LINK = {
  context: "We should ship Roadmap this quarter.",
  source_block: null,
  embed: false,
  anchor_kind: "none",
  anchor: null,
};

const MENTION = {
  path: "Mentions.md",
  title: "Mentions",
  contexts: ["The Roadmap is agreed."],
};

const BODY = {
  note: "Projects/Roadmap.md",
  sources: [{ path: "Q3.md", title: "Third quarter", links: [LINK] }],
  mentions: [MENTION],
};

/** A `fetch` that answers every request with `body`, recording the URLs asked for. */
function server(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetch = async (url: RequestInfo | URL): Promise<Response> => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, urls };
}

describe("readBacklinks", () => {
  it("keeps a well-formed response", () => {
    const parsed = readBacklinks(BODY);
    expect(parsed?.note).toBe("Projects/Roadmap.md");
    expect(parsed?.sources[0]?.path).toBe("Q3.md");
    expect(parsed?.sources[0]?.links[0]?.context).toBe("We should ship Roadmap this quarter.");
  });

  it("reads an anchor and an embed", () => {
    const parsed = readBacklinks({
      note: "A.md",
      mentions: [],
      sources: [
        {
          path: "B.md",
          title: null,
          links: [{ ...LINK, embed: true, anchor_kind: "heading", anchor: "Goals" }],
        },
      ],
    });
    expect(parsed?.sources[0]?.links[0]).toMatchObject({
      embed: true,
      anchorKind: "heading",
      anchor: "Goals",
    });
  });

  it("rejects a body that is not a backlinks response", () => {
    for (const body of [
      null,
      42,
      "sources",
      {},
      { note: "A.md" },
      { sources: [] },
      // A response with links but no mentions field at all: a server this client did not
      // come from, which is a refusal rather than a silently missing section.
      { note: "A.md", sources: [] },
    ]) {
      expect(readBacklinks(body)).toBeUndefined();
    }
  });

  it("drops a source whose path is not a usable string", () => {
    // why: this reaches a `data-path` attribute and an open command. A number here is a
    // crash in the renderer at best.
    const parsed = readBacklinks({
      note: "A.md",
      mentions: [],
      sources: [
        { path: 7, title: null, links: [LINK] },
        { path: "", title: null, links: [LINK] },
        { path: "Good.md", title: null, links: [LINK] },
      ],
    });
    expect(parsed?.sources.map((source) => source.path)).toEqual(["Good.md"]);
  });

  it("drops a source whose every link is malformed rather than naming it with no reason", () => {
    const parsed = readBacklinks({
      note: "A.md",
      mentions: [],
      sources: [
        { path: "Bad.md", title: null, links: [{ context: 7 }] },
        { path: "AlsoBad.md", title: null, links: [{ ...LINK, anchor_kind: "elsewhere" }] },
        { path: "Untyped.md", title: null, links: [{ ...LINK, embed: "yes" }] },
      ],
    });
    expect(parsed?.sources).toEqual([]);
  });

  it("keeps the good links from a source that also has a bad one", () => {
    const parsed = readBacklinks({
      note: "A.md",
      mentions: [],
      sources: [{ path: "B.md", title: null, links: [{ context: 7 }, LINK] }],
    });
    expect(parsed?.sources[0]?.links).toHaveLength(1);
  });

  it("keeps a mention with its contexts in the order the server sent them", () => {
    const parsed = readBacklinks({
      note: "A.md",
      sources: [],
      mentions: [{ path: "B.md", title: null, contexts: ["second", "first"] }],
    });
    expect(parsed?.mentions).toEqual([
      { path: "B.md", title: null, contexts: ["second", "first"] },
    ]);
  });

  it("drops a mention with no usable path, title or sentence", () => {
    // why: a mention row is a path reaching a click handler and prose reaching the DOM, with
    // no link behind it to make either self-evident. A row with no sentence would name a note
    // and give no reason, which is the one thing a mention has to do.
    const parsed = readBacklinks({
      note: "A.md",
      sources: [],
      mentions: [
        { path: 7, title: null, contexts: ["text"] },
        { path: "", title: null, contexts: ["text"] },
        { path: "NoTitleType.md", title: 7, contexts: ["text"] },
        { path: "NoContexts.md", title: null, contexts: [] },
        { path: "NotAnArray.md", title: null, contexts: "text" },
        { path: "AllNumbers.md", title: null, contexts: [1, 2] },
        { path: "Good.md", title: null, contexts: [3, "kept"] },
      ],
    });
    expect(parsed?.mentions.map((mention) => mention.path)).toEqual(["Good.md"]);
    expect(parsed?.mentions[0]?.contexts).toEqual(["kept"]);
  });

  it("accepts a null title and rejects a non-string one", () => {
    expect(
      readBacklinks({
        note: "A.md",
        mentions: [],
        sources: [{ ...BODY.sources[0], title: null }],
      })?.sources[0]?.title,
    ).toBeNull();
    expect(
      readBacklinks({ note: "A.md", mentions: [], sources: [{ ...BODY.sources[0], title: 7 }] })
        ?.sources,
    ).toEqual([]);
  });
});

describe("sourceLabel", () => {
  it("prefers the title", () => {
    expect(sourceLabel({ path: "Q3.md", title: "Third quarter" })).toBe("Third quarter");
  });

  it("falls back to the filename without its extension or folders", () => {
    expect(sourceLabel({ path: "Projects/Q3.md", title: null })).toBe("Q3");
    expect(sourceLabel({ path: "Projects/Q3.md", title: "" })).toBe("Q3");
  });
});

describe("fetchBacklinks", () => {
  it("asks for the note under the vault, path segments encoded", () => {
    const { fetch, urls } = server(BODY);
    return fetchBacklinks("my vault", "Projects/Q3 plan.md", { fetch }).then(() => {
      expect(urls).toEqual(["/api/v1/vaults/my%20vault/backlinks/Projects/Q3%20plan.md"]);
    });
  });

  it("keeps the path separators unencoded", () => {
    // Not because the server needs it: `%2F` routes too, which
    // `backlinks_accept_a_note_path_with_its_separators_encoded` in `mb-server/tests/http.rs`
    // pins rather than leaving to be assumed. This is about the URL a person reads in a log
    // or a network panel while looking for a note.
    const { fetch, urls } = server(BODY);
    return fetchBacklinks("v", "a/b/c.md", { fetch }).then(() => {
      expect(urls[0]).toContain("/backlinks/a/b/c.md");
    });
  });

  it("returns undefined for a denial rather than an empty list", async () => {
    const { fetch } = server({}, 404);
    expect(await fetchBacklinks("v", "A.md", { fetch })).toBeUndefined();
  });

  it("returns undefined when the network fails instead of throwing", async () => {
    const fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchBacklinks("v", "A.md", { fetch })).toBeUndefined();
  });

  it("returns undefined for a body that is not JSON", async () => {
    const fetch = (async () =>
      new Response("<html>nope</html>", { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await fetchBacklinks("v", "A.md", { fetch })).toBeUndefined();
  });
});

describe("BacklinkView", () => {
  /** The same fixture as the wire body above, already validated into client shape. */
  const PARSED = readBacklinks(BODY) as BacklinksResponse;

  /** A loader whose answers are released by hand, so ordering is the test's to decide. */
  function deferred() {
    const pending = new Map<string, (value: Awaited<ReturnType<typeof fetchBacklinks>>) => void>();
    const load = (_vault: string, note: string) =>
      new Promise<Awaited<ReturnType<typeof fetchBacklinks>>>((resolve) => {
        pending.set(note, resolve);
      });
    return { load: load as unknown as typeof fetchBacklinks, pending };
  }

  it("loads the note it is shown", async () => {
    const load = vi.fn(async () => PARSED);
    const view = new BacklinkView({ vault: "v", load: load as unknown as typeof fetchBacklinks });
    view.show("Projects/Roadmap.md");
    expect(view.loading).toBe(true);
    await vi.waitUntil(() => !view.loading);
    expect(view.sources[0]?.path).toBe("Q3.md");
    expect(view.mentions[0]?.path).toBe("Mentions.md");
    expect(view.empty).toBe(false);
  });

  it("reports no links as empty even when the note is mentioned", async () => {
    // The two sections are separate statements: "nothing links here yet" is exactly the
    // thing worth saying when six notes name the note without linking to it.
    const load = (async () => ({
      note: "A.md",
      sources: [],
      mentions: [MENTION],
    })) as unknown as typeof fetchBacklinks;
    const view = new BacklinkView({ vault: "v", load });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    expect(view.empty).toBe(true);
    expect(view.mentions).toHaveLength(1);
  });

  it("clears the previous note's mentions before the next answer arrives", async () => {
    const { load, pending } = deferred();
    const view = new BacklinkView({ vault: "v", load });
    view.show("First.md");
    pending.get("First.md")?.(PARSED);
    await vi.waitUntil(() => !view.loading);
    expect(view.mentions).toHaveLength(1);
    view.show("Second.md");
    expect(view.mentions).toEqual([]);
  });

  it("does not re-fetch the note it is already showing", async () => {
    const load = vi.fn(async () => PARSED);
    const view = new BacklinkView({ vault: "v", load: load as unknown as typeof fetchBacklinks });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    view.show("A.md");
    view.show("A.md");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refresh re-asks for the same note", async () => {
    const load = vi.fn(async () => PARSED);
    const view = new BacklinkView({ vault: "v", load: load as unknown as typeof fetchBacklinks });
    view.show("A.md");
    await vi.waitUntil(() => !view.loading);
    view.refresh();
    await vi.waitUntil(() => !view.loading);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores a late answer for a note that is no longer open", async () => {
    // The bug this exists for: switch tabs while the first request is in flight, and the
    // panel ends up showing the previous note's backlinks under the new note's heading.
    const { load, pending } = deferred();
    const view = new BacklinkView({ vault: "v", load });
    view.show("First.md");
    view.show("Second.md");
    pending.get("Second.md")?.({ note: "Second.md", sources: [], mentions: [] });
    pending.get("First.md")?.(PARSED);
    await vi.waitUntil(() => !view.loading);
    expect(view.note).toBe("Second.md");
    expect(view.sources).toEqual([]);
    expect(view.empty).toBe(true);
  });

  it("reports an unanswered request as unavailable rather than as empty", async () => {
    const load = (async () => undefined) as unknown as typeof fetchBacklinks;
    const view = new BacklinkView({ vault: "v", load });
    view.show("A.md");
    await vi.waitUntil(() => view.unavailable);
    expect(view.empty).toBe(false);
    expect(view.sources).toEqual([]);
  });

  it("clears when there is no note open", () => {
    const load = vi.fn(async () => PARSED);
    const view = new BacklinkView({ vault: "v", load: load as unknown as typeof fetchBacklinks });
    view.show(undefined);
    expect(view.note).toBeUndefined();
    expect(view.loading).toBe(false);
    expect(view.empty).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});
