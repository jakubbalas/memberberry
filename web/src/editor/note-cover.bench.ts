// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import { Doc } from "yjs";
import { afterAll, bench } from "vitest";
import { mountNoteCover } from "./note-cover.js";
import { createMemberberryExtensions } from "./schema.js";

const panel = document.createElement("section"); document.body.append(panel);
const contract: unknown = JSON.parse(readFileSync("../crates/mb-core/schema.json", "utf8"));
const editor = new Editor({ extensions: createMemberberryExtensions(contract) });
const documentModel = new Doc();
documentModel.getMap("frontmatter").set("cover", `media/aa/aa/${"a".repeat(64)}.png`);
const cover = mountNoteCover({ editor, panel, document: documentModel,
  status: document.createElement("p"), vault: "benchmark", canEdit: () => true });
bench("unchanged cover refresh on editor transaction", () => cover.refresh(), { time: 300 });
afterAll(() => { cover.destroy(); editor.destroy(); documentModel.destroy(); panel.remove(); });
