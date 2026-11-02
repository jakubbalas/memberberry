// @vitest-environment jsdom
/**
 * Mounted 1,000-block host benchmark, excluding layout, network and physical-device input-to-paint.
 * Run from web/: npm exec -- vitest bench --run src/editor/custom-emoji.bench.ts --maxWorkers=1
 */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe, vi } from "vitest";
import { createMemberberryExtensions } from "./schema.js";
import { customEmojiViews } from "./custom-emoji.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const content = { type: "doc", content: Array.from({ length: 1000 }, (_, index) => ({
  type: "paragraph", content: [{ type: "text", text: index % 100 === 0 ? ":printer: Earlier text" : `Paragraph ${index}` }],
})) };
let baseline: Editor;
let artwork: Editor;
beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ shortcode: "printer", pack: "p", file: "p.png", aliases: [] }]))));
  baseline = new Editor({ extensions: createMemberberryExtensions(contract), content });
  artwork = new Editor({ extensions: [...createMemberberryExtensions(contract), customEmojiViews("bench")], content });
  await vi.waitFor(() => { if (artwork.view.dom.querySelectorAll(".custom-emoji-image").length !== 10) throw new Error("artwork not ready"); });
});
afterAll(() => { baseline.destroy(); artwork.destroy(); vi.unstubAllGlobals(); });
function edit(editor: Editor): void {
  const position = editor.state.doc.content.size - 1;
  editor.view.dispatch(editor.state.tr.insertText("x", position));
  editor.view.dispatch(editor.state.tr.delete(position, position + 1));
}
describe("custom emoji / editing an unrelated paragraph in 1,000 blocks", () => {
  bench("baseline", () => edit(baseline), { time: 200, warmupTime: 100 });
  bench("with existing emoji artwork", () => edit(artwork), { time: 200, warmupTime: 100 });
});
