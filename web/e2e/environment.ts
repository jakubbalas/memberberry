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

/** Notes the suite can rely on being present. Kept small and canonical on purpose. */
export const E2E_NOTES: Readonly<Record<string, string>> = {
  "Welcome.md": "# Welcome\n\nA note that already exists, for the reader to open.\n",
  "Projects/Roadmap.md": "# Roadmap\n\n- [ ] Ship the workspace shell\n",
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
