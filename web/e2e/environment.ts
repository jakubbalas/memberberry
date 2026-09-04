/**
 * What the E2E server contains, as data.
 *
 * Deliberately free of side effects and of anything but `node:path`, because both the tests
 * and `serve.ts` import it. An earlier revision put these constants in `serve.ts` itself,
 * next to the code that provisions and spawns the server — so every Playwright worker
 * re-provisioned on import, wiped the data directory under the running server and failed
 * with `attempt to write a readonly database`. Constants and side effects do not share a
 * module.
 *
 * This is also the single source of truth the assertions read, so a test cannot claim a note
 * exists that was never written.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, from this file's location rather than the working directory. */
export const REPO: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** AGENTS.md §5.1 reserves this for the E2E server, clear of the dev server on 9010. */
export const E2E_PORT: number = 9012;
export const E2E_ORIGIN: string = `http://127.0.0.1:${E2E_PORT}`;

/** The account the suite signs in as. Throwaway, and never outside a temp directory. */
export const E2E_USER: { readonly username: string; readonly password: string } = {
  username: "alice",
  password: "correct horse battery staple",
};

/**
 * A note that exactly one test, in one viewport, may edit.
 *
 * `fullyParallel` runs both projects against **one** server and one vault, so a test that
 * types into a shared note is racing the same test in the other viewport *and* every other
 * test that touches that note. A test which changes a note takes its own from here; one
 * which only reads may use the read-only fixtures below.
 *
 * Both halves of the key matter, and getting either wrong is a real failure this suite has
 * already produced: sharing across viewports left a task ticked before the test that
 * asserted it was not, and sharing across tests in one viewport put a stray `/` into a
 * heading. Unknown keys throw rather than falling back, so a third editing test — or a
 * tablet project (§8.3) — fails loudly here instead of silently joining someone's race.
 */
export function scratchNote(purpose: string, project: string): string {
  const path = `Scratch/${purpose}.${project}.md`;
  if (!(path in E2E_NOTES)) {
    throw new Error(`no scratch note \`${path}\` — add \`${purpose}\` to SCRATCH_PURPOSES in environment.ts`);
  }
  return path;
}

/** One note per (editing test, viewport). The name is the test's, so a clash is visible. */
const SCRATCH_PURPOSES: readonly string[] = ["slash-menu", "task-toggle"];
const SCRATCH_PROJECTS: readonly string[] = ["desktop", "mobile"];

const SCRATCH_BODY = "# Scratch\n\nA note this test may edit.\n\n- [ ] Ship the workspace shell \u{1F4C5} 2026-09-30 \u{23EB}\n";

/** Notes the suite can rely on being present. Kept small and canonical on purpose. */
export const E2E_NOTES: Readonly<Record<string, string>> = {
  "Welcome.md": "# Welcome\n\nA note that already exists, for the reader to open.\n",
  // Read-only: nothing in the suite may edit this one, which is what lets a test assert on
  // the metadata it was provisioned with.
  "Projects/Roadmap.md": "# Roadmap\n\n- [ ] Ship the workspace shell \u{1F4C5} 2026-09-30 \u{23EB}\n",
  // Three adjacent tasks, so a test can check that neighbouring tap targets do not overlap.
  "Projects/Tasks.md": "# Tasks\n\n- [ ] First task\n- [ ] Second task\n- [x] Third task \u{2705} 2026-08-28\n",
  ...Object.fromEntries(
    SCRATCH_PURPOSES.flatMap((purpose) =>
      SCRATCH_PROJECTS.map((project) => [`Scratch/${purpose}.${project}.md`, SCRATCH_BODY] as const),
    ),
  ),
};

/** Everything the run creates, under `target/` so `cargo clean` and `.gitignore` cover it. */
export const E2E_ROOT: string = join(REPO, "target", "e2e");

/**
 * The vault root, exported so a test can read the `.md` files back.
 *
 * That is not incidental: C2 says a note is plain Markdown on disk, and the only way to
 * assert it is to open the file the way a text editor would.
 */
export const E2E_VAULT: string = join(E2E_ROOT, "vault");

export const E2E_DATA_DIR: string = join(E2E_ROOT, "data");
export const E2E_CONFIG: string = join(E2E_DATA_DIR, "server.toml");

/** Vite's production output, which the editor route serves. */
export const E2E_WEB_ROOT: string = join(REPO, "web", "dist");
