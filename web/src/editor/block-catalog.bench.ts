// @vitest-environment jsdom
/** Catalogue refresh/filter microbenchmarks; these do not measure Android input-to-paint. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { createMemberberryExtensions } from "./schema.js";
import { mountBlockCatalog } from "./block-catalog.js";

const fixtures: Array<{ editor: Editor; host: HTMLElement; catalog: ReturnType<typeof mountBlockCatalog>; menu: HTMLElement }> = [];
beforeAll(() => {
  const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
  for (const text of ["ordinary text", "/"]) {
    const host = document.createElement("div"); document.body.append(host);
    const editor = new Editor({ extensions: createMemberberryExtensions(contract),
      content: { type: "doc", content: Array.from({ length: 2000 }, (_, index) => ({ type: "paragraph", content: [{ type: "text", text: index === 1999 ? text : `Paragraph ${index}` }] })) } });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const catalog = mountBlockCatalog({ editor, host, status: document.createElement("p"), canInteract: () => true, emoji: () => undefined });
    catalog.sync();
    const menu = host.nextElementSibling;
    if (!(menu instanceof HTMLElement)) throw new Error("missing benchmark catalogue");
    fixtures.push({ editor, host, catalog, menu });
  }
});
describe("catalogue / 2000 mounted root blocks", () => {
  bench("closed catalogue refresh on ordinary typing", () => fixtures[0]?.catalog.sync(), { time: 300 });
  bench("unchanged open catalogue refresh", () => fixtures[1]?.catalog.sync(), { time: 300 });
  let query = 0;
  const queries = ["", "h", "heading", "date", "equation", "zzz"];
  bench("search input and grouped menu rendering", () => {
    const input = fixtures[1]?.menu.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("missing filter input");
    input.value = queries[query % queries.length] ?? ""; query++;
    input.dispatchEvent(new Event("input"));
  }, { time: 300 });
});
afterAll(() => { for (const fixture of fixtures) { fixture.catalog.destroy(); fixture.editor.destroy(); fixture.host.remove(); } });
