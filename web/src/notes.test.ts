/**
 * The WebAssembly boundary, against the real module.
 *
 * These run the actual Rust, not a fake. SPEC §5.2 rests the whole design on the client and
 * the server sharing one implementation, and the only way to know the bridge carries that
 * faithfully is to call across it and check what comes back — the same argument §22.2 makes
 * for the cross-language fixtures.
 *
 * Requires `make wasm` (or `npm run wasm`) to have produced `src/wasm/`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";
import { applyUpdate, Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";

import { extract, load, normalize, periodicPath, schema, title, toHtml, validateSearchSegment, updateFromMarkdown, markdownFromUpdate } from "./notes.js";

beforeAll(async () => {
  // Node cannot fetch a relative URL, so the bytes are handed in directly.
  const wasm = fileURLToPath(new URL("./wasm/mb_bg.wasm", import.meta.url));
  await load(readFileSync(wasm));
});

describe("normalize", () => {
  it("is the same canonical form the server writes", async () => {
    expect(await normalize("* item\n_em_\n")).toBe("- item\n  *em*\n");
  });

  it("converges in one pass", async () => {
    const once = await normalize("# Title\n\n1) a\n2) b\n");
    expect(await normalize(once)).toBe(once);
  });
});

describe("bounded namespace WASM boundary", () => {
  it("canonicalizes four independent dimensions and preserves native labels and protected atoms", async () => {
    const source = ':mb-style[مرحبا 😀 **bold** [link](https://example.test/a]b) [[Wiki]] #tag :berry: $x[y]$ `code]`]{size="large" background="yellow" color="red" underline="true"}';
    const canonical = await normalize(source);
    expect(await normalize(canonical)).toBe(canonical);
    expect(await markdownFromUpdate(await updateFromMarkdown(canonical))).toBe(canonical);
    const html = await toHtml(canonical, { note: "", media: "" });
    for (const name of ["mb-underline", "mb-color-red", "mb-background-yellow", "mb-size-large"]) expect(html).toContain(`class="${name}"`);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("style=");
    const facts = await extract(canonical);
    expect(facts.links.map(link => link.target)).toEqual(["Wiki"]);
    expect(facts.tags).toEqual(["tag"]);
  });

  it("keeps rejected declarations literal across the actual compiled boundary", async () => {
    for (const attrs of ['color="Red"', 'underline="false"', 'size="normal"', 'color="red" color="blue"', 'onclick="evil"']) {
      const source = `:mb-style[KEEP 彩色]{${attrs}} SENTINEL tail`;
      const html = await toHtml(source, { note: "", media: "" });
      expect(html).toContain(source);
      expect(html).not.toContain('<span class="mb-');
      const canonical = await normalize(source);
      expect(await markdownFromUpdate(await updateFromMarkdown(canonical))).toBe(canonical);
    }
  });

  it("rejects malformed constructed Yjs mark attributes without modifying that candidate", async () => {
    for (const [key, value] of Object.entries({
      mb_underline: { value: "true" }, mb_color: { value: "#ff0000" },
      mb_background: { value: "yellow", onclick: "evil" }, mb_size: { value: "normal" },
    })) {
      const doc = new Doc();
      try {
        applyUpdate(doc, await updateFromMarkdown("text"));
        const paragraph = doc.getXmlFragment("prosemirror").get(0);
        if (!(paragraph instanceof XmlElement)) throw new Error("actual paragraph required");
        const text = paragraph.get(0);
        if (!(text instanceof XmlText)) throw new Error("actual text required");
        text.format(0, text.length, { [key]: value });
        const before = encodeStateAsUpdate(doc);
        await expect(markdownFromUpdate(before)).rejects.toThrow();
        expect(encodeStateAsUpdate(doc)).toEqual(before);
      } finally { doc.destroy(); }
    }
  });
});

describe("calendar paths", () => {
  it("formats ISO weekly and monthly paths through the Rust boundary", async () => {
    await expect(periodicPath("weekly", "Weekly/", "%G-W%V.md", "2021-01-01"))
      .resolves.toBe("Weekly/2020-W53.md");
    await expect(periodicPath("monthly", "Monthly/", "%Y-%m.md", "2021-01-31"))
      .resolves.toBe("Monthly/2021-01.md");
  });
});

describe("toHtml", () => {
  it("renders blocks and inlines", async () => {
    const html = await toHtml("# T\n\n**b** and `c`\n", { note: "", media: "" });
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("<strong>b</strong>");
    expect(html).toContain("<code>c</code>");
  });

  it("applies the link prefixes it is given", async () => {
    const html = await toHtml("[[Some Note]]\n", { note: "/v/p/", media: "/m/" });
    expect(html).toContain('href="/v/p/Some%20Note"');
  });

  it("escapes note content, so the browser cannot be attacked through a note", async () => {
    const html = await toHtml("<script>alert(1)</script>\n\n[x](javascript:alert(2))\n", {
      note: "",
      media: "",
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("title", () => {
  it("prefers the first h1", async () => {
    expect(await title("## sub\n\n# Real\n")).toBe("Real");
  });

  it("is null when there is nothing titleable", async () => {
    expect(await title("***\n")).toBeNull();
  });
});

describe("extract", () => {
  it("returns the facts the index is built from", async () => {
    const facts = await extract(
      "---\ntags: [alpha]\n---\n\n# Title\n\nSee [[A]] and ![[B]] #beta ^anchor-1\n\n" +
        "- [ ] task 📅 2026-09-05\n\n![x](media/y.png)\n",
    );
    expect(facts.title).toBe("Title");
    expect(facts.tags).toEqual(["alpha", "beta"]);
    expect(facts.links.map((l) => l.target)).toEqual(["A", "B"]);
    expect(facts.links[1]?.embed).toBe(true);
    expect(facts.anchors).toEqual(["anchor-1"]);
    expect(facts.media).toEqual(["media/y.png"]);
    expect(facts.headings).toEqual([{ level: 1, text: "Title" }]);
    expect(facts.tasks).toHaveLength(1);
    expect(facts.tasks[0]).toMatchObject({ status: "todo", text: "task", due: "2026-09-05" });
    expect(facts.wordCount).toBeGreaterThan(0);
  });

  it("gives every task status the name the Rust side uses", async () => {
    const facts = await extract("- [ ] a\n- [x] b\n- [-] c\n");
    expect(facts.tasks.map((t) => t.status)).toEqual(["todo", "done", "cancelled"]);
  });

  it("returns empty collections rather than undefined for an empty note", async () => {
    const facts = await extract("");
    expect(facts).toMatchObject({ title: null, links: [], tags: [], tasks: [], wordCount: 0 });
  });
});

describe("schema", () => {
  it("is the same contract file the Rust side is held to", async () => {
    const parsed = (await schema()) as { topNode: string; nodes: Record<string, unknown> };
    expect(parsed.topNode).toBe("doc");
    // M3 generates the Tiptap schema from exactly this.
    expect(Object.keys(parsed.nodes)).toContain("task_item");
    expect(Object.keys(parsed.nodes)).toContain("callout");
  });
});

describe("inline maths", () => {
  it("accepts bodies the old parser refused", async () => {
    // Tokenised from source ahead of CommonMark, so the body is never reinterpreted.
    for (const source of ["$a*b$\n", "$\\alpha[i]$\n", "$P(A|B)$\n", "$_a_$\n"]) {
      expect(await normalize(source)).toBe(source);
    }
  });
});

describe("load", () => {
  it("is idempotent", async () => {
    await load();
    await load();
    expect(await normalize("x\n")).toBe("x\n");
  });
});

describe("compact client search", () => {
  it("rejects bytes that are not a validated binary-v1 segment", async () => {
    await expect(validateSearchSegment(new Uint8Array([1, 2, 3]))).rejects.toThrow("truncated");
  });
});
