import type { OfflineStore, ReplicatedNote } from "./db.js";
import type { OfflineNoteLink } from "./offline-page.js";

/** The resident note bodies that the offline landing page can open. */
export async function availableOfflineNotes(store: OfflineStore): Promise<readonly OfflineNoteLink[]> {
  const links: OfflineNoteLink[] = [];
  for (const vault of await store.vaults()) {
    const notes = await store.getNotes(vault) ?? [];
    const metadata = new Map(notes.map((note: ReplicatedNote): [string, ReplicatedNote] => [note.path, note]));
    for (const body of await store.residents(vault)) {
      const note = metadata.get(body.note);
      links.push({ vault, note: body.note, title: note?.title ?? null });
    }
  }
  return links.sort((left, right) =>
    `${left.vault}/${left.note}`.localeCompare(`${right.vault}/${right.note}`),
  );
}
