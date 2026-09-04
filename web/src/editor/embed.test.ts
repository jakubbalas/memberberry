/**
 * The transclusion resolution stack (`SPEC.md` §9.2, §22.7).
 *
 * §22.7 asks for cycles, self-reference, depth limits, missing targets, unreadable targets
 * and deep nesting. All six are here, because all six are decisions this module makes: the
 * server answers for one reference and cannot see the chain, and `mb-core` slices a document
 * and cannot see the network. What the browser adds on top of these — that the placeholder
 * is actually visible and that a cycle does not hang the page — is in
 * `embed-view.dom.test.ts` and `web/e2e/embed.spec.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MAX_EMBED_DEPTH,
  embedLabel,
  embedUrl,
  readEmbed,
  resolveEmbed,
  revisits,
  tooDeep,
} from "./embed.js";

const BODY = { note: "Projects/Roadmap.md", title: "The Plan", html: "<p>Ship it.</p>", found: true };

/** A `fetch` answering every request with `body`, recording what was asked for. */
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

const REQUEST = { target: "Roadmap", anchorKind: "none", anchor: null } as const;

describe("the request", () => {
  it("asks about one reference, from the note it is written in", async () => {
    const { fetch, urls } = server(BODY);
    await resolveEmbed("personal", REQUEST, ["Projects/Q3.md"], { fetch });
    expect(urls).toEqual([
      "/api/v1/vaults/personal/embed/Roadmap?from=Projects%2FQ3.md",
    ]);
  });

  it("encodes a target's separators, which the route accepts", () => {
    expect(embedUrl("v", { ...REQUEST, target: "Projects/Roadmap" }, "A.md")).toContain(
      "/embed/Projects%2FRoadmap?",
    );
  });

  it("leaves no path segment the browser would normalise away", () => {
    // A wikilink target is note text and can be `../secrets`. Left as a segment, the browser
    // resolves it before sending, so the request lands on a route this function never named.
    const url = embedUrl("v", { ...REQUEST, target: "../secrets" }, "A.md");
    expect(url).toContain("/embed/..%2Fsecrets?");
    expect(url).not.toContain("/embed/../");
  });

  it("carries an anchor when there is one", () => {
    const url = embedUrl(
      "v",
      { target: "Roadmap", anchorKind: "heading", anchor: "Risks & More" },
      "A.md",
    );
    expect(url).toContain("anchor_kind=heading");
    expect(url).toContain("anchor=Risks+%26+More");
  });

  it("sends no anchor for a whole-note reference", () => {
    expect(embedUrl("v", REQUEST, "A.md")).not.toContain("anchor");
  });

  it("resolves from the innermost note, not the outermost", async () => {
    const { fetch, urls } = server(BODY);
    await resolveEmbed("v", REQUEST, ["Host.md", "Middle.md"], { fetch });
    expect(urls[0]).toContain("from=Middle.md");
  });

  it("does not ask at all without a note to resolve from", async () => {
    const { fetch, urls } = server(BODY);
    const outcome = await resolveEmbed("v", REQUEST, [], { fetch });
    expect(outcome).toEqual({ state: "unavailable" });
    expect(urls).toEqual([]);
  });
});

describe("the depth limit", () => {
  it("refuses beyond the limit without making a request", async () => {
    const { fetch, urls } = server(BODY);
    const stack = ["Host.md", "One.md", "Two.md", "Three.md"];
    expect(stack.length).toBeGreaterThan(MAX_EMBED_DEPTH);
    expect(await resolveEmbed("v", REQUEST, stack, { fetch })).toEqual({ state: "depth" });
    expect(urls).toEqual([]);
  });

  it("allows exactly the depth the spec allows", async () => {
    const { fetch } = server(BODY);
    const stack = ["Host.md", "One.md", "Two.md"];
    expect(stack.length).toBe(MAX_EMBED_DEPTH);
    expect(await resolveEmbed("v", REQUEST, stack, { fetch })).toEqual({
      state: "content",
      content: { note: "Projects/Roadmap.md", title: "The Plan", html: "<p>Ship it.</p>", found: true },
    });
  });

  it("is a fact about the stack, so nothing has to run to check it", () => {
    expect(tooDeep(["a", "b", "c"])).toBe(false);
    expect(tooDeep(["a", "b", "c", "d"])).toBe(true);
  });
});

describe("cycles", () => {
  it("refuses a note that is already being rendered", async () => {
    const { fetch } = server(BODY);
    const outcome = await resolveEmbed("v", REQUEST, ["Projects/Roadmap.md"], { fetch });
    expect(outcome).toEqual({ state: "cycle", note: "Projects/Roadmap.md" });
  });

  it("refuses a note further up the chain, not only the parent", async () => {
    const { fetch } = server(BODY);
    const stack = ["Projects/Roadmap.md", "Other.md"];
    expect(await resolveEmbed("v", REQUEST, stack, { fetch })).toEqual({
      state: "cycle",
      note: "Projects/Roadmap.md",
    });
  });

  it("compares the note the reference resolved to, not the name it was written by", async () => {
    // Two notes may share a name (§4.3), so `![[Roadmap]]` inside `Archive/Roadmap.md` is
    // not necessarily a cycle — and inside `Projects/Q3.md` it may be one. Only the
    // server's answer says which, which is why the check happens after the request.
    const { fetch } = server(BODY);
    expect(
      await resolveEmbed("v", REQUEST, ["Archive/Roadmap.md"], { fetch }),
    ).toMatchObject({ state: "content" });
    expect(revisits(["Archive/Roadmap.md"], "Projects/Roadmap.md")).toBe(false);
  });

  it("stops a self-embed before it can nest once", async () => {
    const { fetch, urls } = server({ ...BODY, html: '<a class="mb-embed" data-embed="true">x</a>' });
    const outcome = await resolveEmbed("v", REQUEST, ["Projects/Roadmap.md"], { fetch });
    expect(outcome.state).toBe("cycle");
    expect(urls).toHaveLength(1);
  });
});

describe("the answer", () => {
  it("reports a readable note with no such section separately from a denial", async () => {
    const { fetch } = server({ ...BODY, html: "", found: false });
    expect(await resolveEmbed("v", REQUEST, ["A.md"], { fetch })).toEqual({
      state: "no-section",
      note: "Projects/Roadmap.md",
      title: "The Plan",
    });
  });

  it("renders a denial and a missing note as one state", async () => {
    const denied = server({}, 404);
    expect(await resolveEmbed("v", REQUEST, ["A.md"], { fetch: denied.fetch })).toEqual({
      state: "unavailable",
    });
  });

  it("treats a server error as unavailable rather than throwing", async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error("offline"));
    const outcome = await resolveEmbed("v", REQUEST, ["A.md"], {
      fetch: failing as unknown as typeof globalThis.fetch,
    });
    expect(outcome).toEqual({ state: "unavailable" });
  });

  it("treats a body of the wrong shape as unavailable", async () => {
    for (const body of [
      null,
      [],
      "a string",
      { note: "", title: null, html: "", found: true },
      { note: "A.md", title: 7, html: "", found: true },
      { note: "A.md", title: null, html: 7, found: true },
      { note: "A.md", title: null, html: "", found: "yes" },
      { title: null, html: "", found: true },
    ]) {
      const { fetch } = server(body);
      expect(await resolveEmbed("v", REQUEST, ["A.md"], { fetch })).toEqual({
        state: "unavailable",
      });
    }
  });

  it("accepts a note with no title", () => {
    expect(readEmbed({ note: "A.md", title: null, html: "<p>a</p>", found: true })).toEqual({
      note: "A.md",
      title: null,
      html: "<p>a</p>",
      found: true,
    });
  });

  it("passes the abort signal through, so a destroyed view cancels its request", async () => {
    const seen: RequestInit[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init !== undefined) seen.push(init);
      return new Response(JSON.stringify(BODY), { status: 200 });
    });
    const controller = new AbortController();
    await resolveEmbed("v", REQUEST, ["A.md"], {
      fetch: fetch as unknown as typeof globalThis.fetch,
      signal: controller.signal,
    });
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe("the label", () => {
  it("prefers the title", () => {
    expect(embedLabel("Projects/Roadmap.md", "The Plan")).toBe("The Plan");
  });

  it("falls back to the filename without its extension", () => {
    expect(embedLabel("Projects/Roadmap.md", null)).toBe("Roadmap");
    expect(embedLabel("Projects/Roadmap.md", "")).toBe("Roadmap");
  });
});
