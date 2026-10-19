// @vitest-environment jsdom
/** Host/jsdom keystroke comparison; excludes browser paint and physical-device budgets. */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { createMemberberryExtensions } from "./schema.js";
import { dateMentions } from "./date-mentions.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const enabled = process.env["MEMBERBERRY_DATE_BENCH_BASELINE"] !== "1";
let large: Editor; let small: Editor;
beforeAll(() => {
  const extensions = () => [...createMemberberryExtensions(contract), ...(enabled ? [dateMentions] : [])];
  large = new Editor({ extensions: extensions(), content: { type: "doc", content: [
    ...Array.from({ length: 1_000 }, () => ({ type: "paragraph", content: [{ type: "text", text: "A date 2026-10-19" }] })),
    { type: "paragraph", content: [{ type: "text", text: "Writing here" }] },
  ] } });
  small = new Editor({ extensions: extensions(), content: { type: "doc", content: [{ type: "paragraph" }] } });
});
afterAll(() => { large.destroy(); small.destroy(); });

describe(`date mentions ${enabled ? "enabled" : "baseline"}`, () => {
  bench("ordinary key in note with 1,000 dates", () => {
    const pos = large.state.doc.content.size - 1;
    large.view.dispatch(large.state.tr.insertText("x", pos));
    if (large.state.doc.lastChild?.textContent !== "Writing herex") throw new Error("typing did not land");
    large.view.dispatch(large.state.tr.delete(pos, pos + 1));
  }, { time: 100, warmupTime: 50 });
  bench("ordinary key in a short paragraph", () => {
    small.view.dispatch(small.state.tr.insertText("x", 1));
    if (small.getText() !== "x") throw new Error("typing did not land");
    small.view.dispatch(small.state.tr.delete(1, 2));
  }, { time: 100, warmupTime: 50 });
});
