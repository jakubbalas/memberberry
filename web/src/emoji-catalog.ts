import type { EmojiEntry } from "./notes.js";

type EmojiWasm = typeof import("./wasm/emoji/emoji.js");

let modulePromise: Promise<EmojiWasm> | undefined;
let readyPromise: Promise<void> | undefined;

/** Loads the catalog WASM only when autocomplete or the picker first needs it. */
export async function emojiCatalog(): Promise<readonly EmojiEntry[]> {
  modulePromise ??= import("./wasm/emoji/emoji.js");
  const module = await modulePromise;
  readyPromise ??= module.default().then(() => undefined);
  await readyPromise;
  return module.emojiCatalog() as readonly EmojiEntry[];
}
