/**
 * Provisions a throwaway Memberberry server and runs it, for the E2E suite.
 *
 * Playwright's `webServer` wants one command that ends with something listening, but a
 * Memberberry server is not usable until it has an admin, a vault and an `access.toml` —
 * deny by default means an unprovisioned server correctly shows nothing at all. So this
 * script provisions first and then hands over to `memberberry serve`.
 *
 * Everything lives under a fresh directory that is removed on the way in, so a run never
 * inherits state from the last one. Passwords go in over a pipe (`--password-stdin`,
 * SPEC.md §6.8); before that flag existed this script could not have been written.
 *
 * **This module runs a server when loaded, so nothing imports it.** What the tests need is
 * in `environment.ts`. Node's type stripping (`--experimental-strip-types`) executes it
 * directly, which is why the import below carries an explicit `.ts` extension: there is no
 * bundler in the loop to resolve anything else.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  E2E_CONFIG,
  E2E_EMPTY_SLUGS,
  E2E_DATA_DIR,
  E2E_NOTES,
  E2E_PORT,
  E2E_ROOT,
  E2E_USER,
  E2E_VAULT,
  E2E_WEB_ROOT,
  REPO,
  emptyVaultRoot,
} from "./environment.ts";

/**
 * The built CLI — whichever of the two profiles was built most recently.
 *
 * why: not "release, else debug". A stale `target/release/memberberry` left behind by an old
 * `make prod` is a binary from an earlier milestone, and it fails in a thoroughly confusing
 * way: `unknown command 'user'`, from a server that predates authentication. Newest-wins
 * matches what the developer last asked for.
 */
function binary(): string {
  const newest = ["debug", "release"]
    .map((profile) => join(REPO, "target", profile, "memberberry"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) {
    throw new Error(
      "no memberberry binary in target/{debug,release}. Run `make e2e`, which builds it, " +
        "or `cargo build -p mb-cli` first.",
    );
  }
  return newest.path;
}

function provision(): string {
  if (!existsSync(join(E2E_WEB_ROOT, "index.html"))) {
    throw new Error(
      `${E2E_WEB_ROOT}/index.html is missing. The editor route serves the Vite build, so the ` +
        "suite needs `make web-build` first — `make e2e` does it.",
    );
  }

  rmSync(E2E_ROOT, { recursive: true, force: true });
  mkdirSync(E2E_DATA_DIR, { recursive: true });
  mkdirSync(E2E_VAULT, { recursive: true });

  for (const [rel, body] of Object.entries(E2E_NOTES)) {
    const path = join(E2E_VAULT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  }

  // Deny by default (AGENTS.md §3.1): without this the vault is correctly invisible, and the
  // suite would be testing an empty server while looking like it tested a full one.
  writeFileSync(
    join(E2E_VAULT, "access.toml"),
    `[[members]]\nuser = "${E2E_USER.username}"\nrole = "owner"\n`,
    "utf8",
  );

  // Written before `vault create`, which loads this file, appends its `[[vaults]]` entry and
  // saves it back — so registration goes through the real CLI path rather than being
  // hand-forged here. `web_root` is what makes the editor route serve the actual Vite bundle
  // instead of the read-only fallback page, which is the difference the M5 asset bug hid in.
  writeFileSync(
    E2E_CONFIG,
    `bind = "127.0.0.1:${E2E_PORT}"\nweb_root = ${JSON.stringify(E2E_WEB_ROOT)}\n`,
    "utf8",
  );

  const mb = binary();
  const run = (args: readonly string[]): string =>
    execFileSync(mb, [...args, "--config", E2E_CONFIG], {
      input: `${E2E_USER.password}\n`,
      encoding: "utf8",
    });

  run(["user", "setup", "--username", E2E_USER.username, "--password-stdin"]);
  run([
    "vault",
    "create",
    "--slug",
    "personal",
    "--name",
    "Personal",
    "--path",
    E2E_VAULT,
    "--actor",
    E2E_USER.username,
    "--password-stdin",
  ]);

  // One empty vault per project, and note what is *not* done to them: no notes are written,
  // and **no `access.toml` is written either**. That is the whole point. Every vault above
  // has its policy hand-written here before registration, which is why this suite could not
  // see that `vault create` wrote none of its own — deny by default then made a freshly
  // registered vault invisible to the person who had just created it. Registering these the
  // way a real first run does is what holds that fixed (§6.10).
  for (const [project, slug] of Object.entries(E2E_EMPTY_SLUGS)) {
    const root = emptyVaultRoot(project);
    mkdirSync(root, { recursive: true });
    run([
      "vault",
      "create",
      "--slug",
      slug,
      "--name",
      `Empty ${project}`,
      "--path",
      root,
      "--actor",
      E2E_USER.username,
      "--password-stdin",
    ]);
  }

  return mb;
}

const mb = provision();
const server = spawn(mb, ["serve", "--config", E2E_CONFIG], { stdio: "inherit" });
server.on("exit", (code: number | null) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}
