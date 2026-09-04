/**
 * The 10k-note vault and the server that serves it.
 *
 * `SPEC.md` §21 measures every budget against a **generated 10 000-note vault**
 * (`memberberry gen-vault`), so the harness provisions one rather than reusing the E2E
 * server's two notes: a quick switcher over two notes is not a measurement of anything.
 *
 * This is a deliberate sibling of `e2e/serve.ts` rather than a shared abstraction. AGENTS.md
 * §4.1 — two similar call sites are a coincidence, three are a pattern — and the two differ
 * in the ways that matter: this one owns the process lifecycle itself (one runner, not one
 * Playwright worker per test file), caches a 39 MB vault between runs, and must not be
 * imported for its constants because it does not have any that anything else needs.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** AGENTS.md §5.1 reserves this for the performance harness, clear of 9010-9012. */
export const PERF_PORT = 9013;
export const PERF_ORIGIN = `http://127.0.0.1:${PERF_PORT}`;

/** §21's corpus size. Every budget in §21.2 that mentions a vault means this many notes. */
export const PERF_NOTES = 10_000;

export const PERF_USER = { username: "perf", password: "correct horse battery staple" };
export const PERF_SLUG = "scale";

/** A note that exists in every generated vault, used as the "open a note" subject. */
export const PERF_NOTE = "folder-00/note-00000.md";

/**
 * What the quick switcher is asked for.
 *
 * It is a note title on purpose, and the harness asserts that this exact title comes back
 * ranked first — which is what makes "the results updated" a condition it can test rather
 * than guess at. Every prefix of it also matches, so the ranking work is real: "Note 424"
 * matches Note 424, Note 4240-4249 and every fuzzy subsequence in a 10 000-note vault.
 */
export const PERF_QUERY = "Note 4242";

const PERF_ROOT = join(REPO, "target", "perf");
const VAULT = join(PERF_ROOT, "vault");
const DATA_DIR = join(PERF_ROOT, "data");
const CONFIG = join(DATA_DIR, "server.toml");
const WEB_ROOT = join(REPO, "web", "dist");

/** Newest of the two build profiles — the same rule, and the same reason, as `e2e/serve.ts`. */
function binary(): string {
  return newestBuild().path;
}

/** The newest binary and which profile it came from. */
function newestBuild(): { readonly path: string; readonly profile: string } {
  const newest = ["debug", "release"]
    .map((profile) => ({ profile, path: join(REPO, "target", profile, "memberberry") }))
    .filter(({ path }) => existsSync(path))
    .map((build) => ({ ...build, at: statSync(build.path).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  if (newest === undefined) {
    throw new Error("no memberberry binary in target/{debug,release}. `make perf` builds one.");
  }
  return newest;
}

/** How many `.md` files the cached vault holds, or 0 if there is no cached vault. */
function cachedNoteCount(): number {
  const notes = join(VAULT, "notes");
  if (!existsSync(notes)) return 0;
  let total = 0;
  for (const folder of readdirSync(notes, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    total += readdirSync(join(notes, folder.name)).filter((n) => n.endsWith(".md")).length;
  }
  return total;
}

/**
 * Generates the corpus, unless a run already left one of the right size behind.
 *
 * why: cached. `gen-vault` is deterministic by construction — no clock, no RNG — so an
 * existing vault of the right size *is* the vault this run would have written. Regenerating
 * 39 MB every time would add ~20 s to a harness people are supposed to run often, and a
 * harness nobody runs measures nothing.
 */
export function ensureVault(notes: number = PERF_NOTES): void {
  if (cachedNoteCount() === notes) return;
  rmSync(VAULT, { recursive: true, force: true });
  mkdirSync(VAULT, { recursive: true });
  execFileSync(binary(), ["gen-vault", "--out", VAULT, "--notes", String(notes)], {
    stdio: "inherit",
  });
}

export interface PerfServer {
  readonly origin: string;
  /** The server process's pid, for the resident-memory measurement. */
  readonly pid: number;
  stop(): void;
}

/**
 * Provisions a throwaway data directory and admin, then runs the real binary against the
 * generated vault and waits for it to answer.
 *
 * The data directory is wiped every run; the vault is not (see `ensureVault`).
 */
export async function startServer(): Promise<PerfServer> {
  if (!existsSync(join(WEB_ROOT, "index.html"))) {
    throw new Error(
      `${WEB_ROOT}/index.html is missing. Every browser measurement loads the production ` +
        "bundle, so the harness needs `make web-build` first — `make perf` does it.",
    );
  }
  // why: refuse rather than reuse. A server left over from a previous run answers on this
  // port with a data directory this run is about to delete, so provisioning succeeds against
  // the new one while every measurement is taken against the old one — which shows up as
  // "sign-in timed out" and costs ten minutes to understand. Ask for the port before wiping
  // anything.
  if (await portAnswers()) {
    throw new Error(
      `something is already listening on ${PERF_ORIGIN}. The harness will not measure a ` +
        "server it did not provision — stop it first (`lsof -ti:9013 | xargs kill`).",
    );
  }
  ensureVault();

  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });

  // Deny by default (AGENTS.md §3.1). Without this the vault is correctly invisible and the
  // harness would be timing an empty server while reporting a 10k-note one.
  writeFileSync(
    join(VAULT, "access.toml"),
    `[[members]]\nuser = "${PERF_USER.username}"\nrole = "owner"\n`,
    "utf8",
  );
  writeFileSync(
    CONFIG,
    `bind = "127.0.0.1:${PERF_PORT}"\nweb_root = ${JSON.stringify(WEB_ROOT)}\n`,
    "utf8",
  );

  const mb = binary();
  const run = (args: readonly string[]): void => {
    execFileSync(mb, [...args, "--config", CONFIG], {
      input: `${PERF_USER.password}\n`,
      encoding: "utf8",
    });
  };
  run(["user", "setup", "--username", PERF_USER.username, "--password-stdin"]);
  run([
    "vault",
    "create",
    "--slug",
    PERF_SLUG,
    "--name",
    "Scale",
    "--path",
    VAULT,
    "--actor",
    PERF_USER.username,
    "--password-stdin",
  ]);

  const child: ChildProcess = spawn(mb, ["serve", "--config", CONFIG], { stdio: "ignore" });
  const { pid } = child;
  if (pid === undefined) {
    throw new Error("the server process did not start");
  }
  await waitForOrigin();
  return {
    origin: PERF_ORIGIN,
    pid,
    stop(): void {
      child.kill("SIGTERM");
    },
  };
}

/**
 * Times a full reindex of the generated vault, in milliseconds.
 *
 * §21.2's "Full reindex, 10k notes". `memberberry reindex` deletes the database before it
 * rebuilds, so this is a build from nothing rather than a reconcile that finds no work — the
 * two differ by three orders of magnitude (§21.8) and only the first one is what the budget
 * is about.
 *
 * Must run with the server stopped: the command removes the database file, and a running
 * server holds an open handle to the deleted inode and would go on writing to it.
 *
 * Depends on `startServer` having provisioned the config, which is the same dependency the
 * resident-memory measurement has on the server still being alive.
 */
export function measureReindex(): { readonly ms: number; readonly profile: string } {
  if (!existsSync(CONFIG)) {
    throw new Error(
      `${CONFIG} is missing: the reindex measurement runs after the server has been ` +
        "provisioned, so that the vault and the registry it reads already exist.",
    );
  }
  // why: the profile is reported, not just used. `make perf` builds the *debug* binary and
  // this picks the newest, so the figure is a debug build unless somebody rebuilt release
  // afterwards — and debug is ~5.8x slower here (5.5 s against 955 ms). A timing number
  // that silently changes by that much depending on which build is newer is a number nobody
  // can compare across runs, so it travels with the answer.
  const build = newestBuild();
  const started = performance.now();
  execFileSync(build.path, ["reindex", "--config", CONFIG, "--slug", PERF_SLUG], {
    stdio: "ignore",
  });
  return { ms: performance.now() - started, profile: build.profile };
}

/** Whether anything is listening on the harness's port right now. */
async function portAnswers(): Promise<boolean> {
  try {
    await fetch(PERF_ORIGIN, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

/** Polls the origin until it answers, rather than sleeping a guessed interval. */
async function waitForOrigin(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(PERF_ORIGIN, { redirect: "manual" });
      // Any answer at all proves it is listening; the sign-in page is a 200.
      if (response.status > 0) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`${PERF_ORIGIN} did not answer within ${timeoutMs} ms`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/**
 * Resident set size of a process, in bytes.
 *
 * why: `ps`, not anything in-process. §21.2 budgets the *server's* memory, and the only
 * honest source for that is the operating system's view of the process — a figure reported
 * from inside the process would exclude the allocator's own overhead, which is exactly the
 * part that grows unnoticed.
 */
export function residentBytes(pid: number): number {
  const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const kilobytes = Number.parseInt(out, 10);
  if (!Number.isFinite(kilobytes)) {
    throw new Error(`ps reported no resident size for pid ${pid}: ${JSON.stringify(out)}`);
  }
  return kilobytes * 1024;
}
