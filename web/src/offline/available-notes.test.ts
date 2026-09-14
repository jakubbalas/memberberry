import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { openOfflineStore } from "./db.js";
import { availableOfflineNotes } from "./available-notes.js";

describe("available offline notes", () => {
  it("lists resident bodies only, with stored titles and stable ordering", async () => {
    const store = await openOfflineStore(new IDBFactory());
    await store.putNotes("work", [
      { path: "Later.md", title: "Later", conflicts: 0 },
      { path: "Opened.md", title: "Opened", conflicts: 0 },
    ]);
    await store.putNotes("personal", [
      { path: "Journal.md", title: "Journal", conflicts: 0 },
    ]);
    await store.putResident({ vault: "work", note: "Opened.md", openedAt: 2, bytes: 0, dirty: false });
    await store.putResident({ vault: "personal", note: "Journal.md", openedAt: 1, bytes: 0, dirty: false });
    await store.putResident({ vault: "work", note: "Legacy.md", openedAt: 3, bytes: 0, dirty: false });

    await expect(availableOfflineNotes(store)).resolves.toEqual([
      { vault: "personal", note: "Journal.md", title: "Journal" },
      { vault: "work", note: "Legacy.md", title: null },
      { vault: "work", note: "Opened.md", title: "Opened" },
    ]);
    store.close();
  });
});
