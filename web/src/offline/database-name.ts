/**
 * The replica database for one editor schema revision.
 *
 * why: separate from `db.ts` so a Node-side test harness can name the same database without
 * importing the bundled schema JSON.
 */
export function offlineDatabaseName(revision: number): string {
  return `memberberry:offline:schema:${String(revision)}`;
}
