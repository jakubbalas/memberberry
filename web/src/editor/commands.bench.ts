// @vitest-environment jsdom
/**
 * Keystroke-path microbenchmark for the new inline-code input rule against plain text.
 * Run with one worker and short sample windows when checking a local change.
 * Host/jsdom timings include document reset, exclude layout and device input-to-paint,
 * and do not establish SPEC §21's mid-range Android performance budget.
 */
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, bench, describe } from "vitest";
import { memberberryInputRules } from "./commands.js";
import { createMemberberryExtensions } from "./schema.js";

const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
let editor: Editor;

beforeAll(() => {
  editor = new Editor({ extensions: [...createMemberberryExtensions(contract), memberberryInputRules] });
});
afterAll(() => editor.destroy());

function type(text: string): void {
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handle) => handle(
      editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to),
    ));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

describe("editor typing through input rules", () => {
  bench("ordinary text", () => {
    type("code");
    if (editor.getText() !== "code") throw new Error("ordinary input did not land");
  }, { time: 100, warmupTime: 50 });
  bench("paired single backticks", () => {
    type("`code`");
    if (editor.getJSON().content?.[0]?.content?.[0]?.marks?.[0]?.type !== "code") {
      throw new Error("inline-code input rule did not run");
    }
  }, { time: 100, warmupTime: 50 });
});
