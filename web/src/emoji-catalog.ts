import type { EmojiEntry } from "./notes.js";

type EmojiWasm = typeof import("./wasm/emoji/emoji.js");

let modulePromise: Promise<EmojiWasm> | undefined;
let readyPromise: Promise<void> | undefined;

/** Loads the catalog WASM only when autocomplete or the picker first needs it. */
export async function emojiCatalog(): Promise<readonly EmojiEntry[]> {
  // why: a failed load is forgotten, not kept. Kept, one offline moment — or a navigation
  // cancelling the load — would leave emoji unavailable until the page was reloaded.
  modulePromise ??= import("./wasm/emoji/emoji.js").catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  const module = await modulePromise;
  readyPromise ??= module.default().then(() => undefined);
  await readyPromise;
  return module.emojiCatalog() as readonly EmojiEntry[];
}
