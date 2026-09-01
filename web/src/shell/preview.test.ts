import { describe, expect, it, vi } from "vitest";

import type { Facts } from "../notes.js";
import { mount, render, summarise } from "./preview.js";

/** The smallest thing that behaves like the elements `mount` touches. */
function fakeElements() {
  const listeners = new Map<string, Set<() => void>>();
  const source = {
    value: "",
    addEventListener(type: string, fn: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    fire(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  const box = () => ({ innerHTML: "", textContent: "" });
  return { source, rendered: box(), canonical: box(), facts: box() };
}

const EMPTY: Facts = {
  title: null,
  links: [],
  tags: [],
  emoji: [],
  anchors: [],
  media: [],
  tasks: [],
  headings: [],
  wordCount: 0,
};

function deps(overrides: Partial<Parameters<typeof render>[0]> = {}) {
  const el = fakeElements();
  return {
    el,
    args: {
      source: el.source as unknown as HTMLTextAreaElement,
      rendered: el.rendered as unknown as HTMLElement,
      canonical: el.canonical as unknown as HTMLElement,
      facts: el.facts as unknown as HTMLElement,
      normalize: async (md: string) => `canonical:${md}`,
      toHtml: async (md: string) => `<p>${md}</p>`,
      extract: async () => EMPTY,
      ...overrides,
    },
  };
}

describe("render", () => {
  it("fills all three panes from one source", async () => {
    const { el, args } = deps();
    el.source.value = "hello";
    await render(args);
    expect(el.rendered.innerHTML).toBe("<p>hello</p>");
    expect(el.canonical.textContent).toBe("canonical:hello");
    expect(el.facts.textContent).toContain("words:    0");
  });

  it("passes the page's own link prefixes through", async () => {
    const toHtml = vi.fn(async () => "");
    const { args } = deps({ toHtml });
    await render(args);
    expect(toHtml).toHaveBeenCalledWith("", { note: "#", media: "" });
  });
});

describe("mount", () => {
  it("renders once immediately, without waiting for an edit", async () => {
    const { el, args } = deps();
    el.source.value = "first";
    mount(args);
    await vi.waitFor(() => expect(el.canonical.textContent).toBe("canonical:first"));
  });

  it("re-renders on input", async () => {
    const { el, args } = deps();
    mount(args);
    el.source.value = "edited";
    el.source.fire("input");
    await vi.waitFor(() => expect(el.canonical.textContent).toBe("canonical:edited"));
  });

  it("removes its listener on teardown", () => {
    // AGENTS §4.3: every listener has a matching teardown, and a test that proves it.
    const { el, args } = deps();
    const teardown = mount(args);
    expect(el.source.count("input")).toBe(1);
    teardown();
    expect(el.source.count("input")).toBe(0);
  });

  it("stops re-rendering once torn down", async () => {
    const { el, args } = deps();
    mount(args)();
    el.source.value = "after teardown";
    el.source.fire("input");
    await Promise.resolve();
    expect(el.canonical.textContent).not.toBe("canonical:after teardown");
  });
});

describe("summarise", () => {
  it("shows an em dash for every empty field rather than a blank", () => {
    const out = summarise(EMPTY);
    expect(out).toContain("title:    —");
    expect(out).toContain("links:    —");
    expect(out).toContain("tasks:    0");
  });

  it("lists links, tags, headings and tasks", () => {
    const out = summarise({
      ...EMPTY,
      title: "A Note",
      wordCount: 12,
      links: [{ target: "Other", anchor: null, alias: null, embed: false }],
      tags: ["alpha", "beta"],
      emoji: ["tada"],
      anchors: ["a1"],
      media: ["media/x.png"],
      headings: [{ level: 2, text: "Sub" }],
      tasks: [
        { status: "todo", text: "do it", due: "2026-09-05", anchor: null },
        { status: "done", text: "did it", due: null, anchor: null },
      ],
    });
    expect(out).toContain("title:    A Note");
    expect(out).toContain("words:    12");
    expect(out).toContain("links:    Other");
    expect(out).toContain("tags:     alpha, beta");
    expect(out).toContain("headings: h2 Sub");
    expect(out).toContain("[todo] do it (due 2026-09-05)");
    expect(out).toContain("[done] did it");
    expect(out).not.toContain("did it (due");
  });
});
