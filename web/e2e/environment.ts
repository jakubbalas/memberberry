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
const SCRATCH_PURPOSES: readonly string[] = [
  "slash-menu",
  "task-toggle",
  "outline",
  // A rename moves a file and rewrites another one, so it needs both ends to itself (§6.6).
  "rename",
  "rename-source",
  // Typed into with the network off, then read off disk once it comes back (§7.4).
  "offline-edit",
  // Edited offline *and* on disk at the same time, which is §3.5's collision. Two, because
  // the second one resolves the conflict and a resolution is not repeatable.
  "conflict",
  "conflict-resolve",
];
const SCRATCH_PROJECTS: readonly string[] = ["desktop", "mobile"];

const SCRATCH_BODY = "# Scratch\n\nA note this test may edit.\n\n- [ ] Ship the workspace shell \u{1F4C5} 2026-09-30 \u{23EB}\n";

/**
 * Sections for the outline pane (§9.5), long enough that the note actually scrolls.
 *
 * Its own body rather than `SCRATCH_BODY`: reordering sections rewrites this file, and the
 * assertions are about the order of headings in it — a shared body would mean the outline
 * test and the task test each had an opinion about the same bytes. The filler paragraphs are
 * what give the surface something to scroll, which is the one thing only a browser can check.
 */
const OUTLINE_BODY = [
  "# Outline scratch",
  "",
  "Front matter, above every heading. See also [[Outline/Other]].",
  "",
  "## Alpha",
  "",
  ...Array.from({ length: 12 }, (_, line) => `Alpha line ${line + 1}.\n`),
  "### Alpha detail",
  "",
  ...Array.from({ length: 12 }, (_, line) => `Detail line ${line + 1}.\n`),
  "## Beta",
  "",
  // Long enough that `Beta` can actually reach the top of the viewport when the outline
  // scrolls to it: a heading in the last screenful of a note cannot, because the scroll is
  // clamped, and an assertion that ignored that would be asserting the clamp.
  ...Array.from({ length: 40 }, (_, line) => `Beta line ${line + 1}.\n`),
].join("\n");

/**
 * The body one scratch note is provisioned with.
 *
 * `project` matters for the rename pair only, and it matters a lot: the link has to name the
 * note *this* viewport will rename, or the desktop run rewrites the mobile run's fixture.
 */
function scratchBody(purpose: string, project: string): string {
  if (purpose === "outline") return OUTLINE_BODY;
  if (purpose === "rename") {
    return "# Rename scratch\n\nA note this test may rename.\n";
  }
  if (purpose === "rename-source") {
    // Two references, one plain and one embed, so the E2E assertion covers both kinds the
    // rewrite has to follow (§9.2). The bare name is unique in the vault, which is what
    // makes the rewritten link a bare name rather than a path (§6.6).
    return `# Rename source\n\nSee [[rename.${project}]] for the plan.\n\n![[rename.${project}]]\n`;
  }
  return SCRATCH_BODY;
}

/** Notes the suite can rely on being present. Kept small and canonical on purpose. */
export const E2E_NOTES: Readonly<Record<string, string>> = {
  "Welcome.md": "# Welcome\n\nA note that already exists, for the reader to open.\n",
  // Read-only: nothing in the suite may edit this one, which is what lets a test assert on
  // the metadata it was provisioned with.
  "Projects/Roadmap.md": "# Roadmap\n\n- [ ] Ship the workspace shell \u{1F4C5} 2026-09-30 \u{23EB}\n",
  // Two notes that link to `Projects/Roadmap.md`, so the backlinks panel (§9.5) has
  // something to show. Read-only: the panel's contents are asserted against the text
  // provisioned here, so an edit would be an edit to the assertion.
  "Links/Planning.md":
    "# Quarter planning\n\nWe should ship [[Roadmap]] this quarter. ^commitment\n",
  "Links/Notes.md": "# Loose notes\n\nSee also [[Projects/Roadmap#Goals]].\n",
  // Transclusion fixtures (§9.2). Read-only, and deliberately self-contained: they embed and
  // link only each other, so the backlinks assertions above keep counting the two sources
  // they were written for. `Host.md` carries one of every state the panel can render.
  "Embeds/Target.md":
    "# Embed target\n\nThe whole note body.\n\n## Details\n\nOnly this section.\n\nJust this block. ^pinned\n",
  // The order of the references is what the spec's assertions index by, and the plain link
  // comes *first* on purpose: on a phone the editor's control strip is pinned to the bottom
  // of the viewport and overlays the last line of the note, so a link written there cannot
  // be tapped. That is a real limitation, recorded in `HANDOFF.md`, and not one this fixture
  // should be demonstrating.
  "Embeds/Host.md":
    "# Embed host\n\nPlain: [[Embeds/Target]]\n\nWhole: ![[Embeds/Target]]\n\n"
    + "Section: ![[Embeds/Target#Details]]\n\nBlock: ![[Embeds/Target#^pinned]]\n\n"
    + "Gone: ![[Embeds/Nothing At All]]\n",
  // A note that embeds itself. §9.2 requires this to render as a link rather than to hang.
  "Embeds/Cycle.md": "# Cycling\n\n![[Embeds/Cycle]]\n",
  // Local-graph fixtures (§9.4). Read-only, in their own folder and linking only each other,
  // so a one-hop and a two-hop picture of `Graph/Hub.md` are exactly these notes however many
  // fixtures a later milestone adds elsewhere. `Graph/Missing` is deliberately never written:
  // it is the ghost, and the picture has to draw it the way it would draw a note the reader
  // may not see (§6.5). Nothing here embeds anything, so opening one makes no request that
  // can 404 — which is what the graph spec needs in order to assert that *no* request failed
  // while it was drawing.
  "Graph/Hub.md": "# Graph hub\n\nOn to [[Graph/Near]], and one day [[Graph/Missing]].\n",
  "Graph/Near.md": "# Graph near\n\nFurther out lies [[Graph/Far]].\n",
  "Graph/Far.md": "# Graph far\n\nTwo links from the hub, and nothing leads onward.\n",
  // The outline fixture (§9.5), read-only: three of the four outline tests only look at it,
  // and the fourth reorders sections and therefore takes its own scratch copy. `fullyParallel`
  // means those would otherwise race over the same bytes.
  "Outline/Sections.md": OUTLINE_BODY,
  // A second note in the same folder, so a test can open a second tab from a link inside a
  // note that is long enough to scroll. Nothing else links to it, so its backlink count is
  // this one link and stays that way.
  "Outline/Other.md": "# Other\n\nA second tab's worth of note.\n",
  // Nested-tag fixtures (§9.3). Read-only, in their own folder so the tag counts asserted in
  // `tags.spec.ts` are exactly these three notes and nothing a later fixture adds. The two
  // spellings of `#Project` are the point of the first two: case is not identity, so the pane
  // must show one node counting both.
  "Tags/Alpha.md": "# Alpha\n\n#Project/memberberry/spec\n",
  "Tags/Beta.md": "# Beta\n\n#project/memberberry\n",
  "Tags/Gamma.md": "# Gamma\n\n#reading\n",
  // Three adjacent tasks, so a test can check that neighbouring tap targets do not overlap.
  "Projects/Tasks.md": "# Tasks\n\n- [ ] First task\n- [ ] Second task\n- [x] Third task \u{2705} 2026-08-28\n",
  ...Object.fromEntries(
    SCRATCH_PURPOSES.flatMap((purpose) =>
      SCRATCH_PROJECTS.map(
        (project) =>
          [`Scratch/${purpose}.${project}.md`, scratchBody(purpose, project)] as const,
      ),
    ),
  ),
};

/**
 * A vault per project that starts with **no notes and no `access.toml`** (§6.10).
 *
 * Two things nothing else in this suite can check, and both were real defects.
 *
 * The first is `vault create` itself. Every other vault here has its `access.toml` written by
 * `serve.ts` *before* registration, which is convenient and which also meant the suite never
 * exercised what the CLI does when a vault has no policy — it wrote none, deny-by-default
 * made the newly registered vault invisible, and a first-time user saw a server with nothing
 * on it. Registering these through the CLI with no policy in place is what proves the CLI
 * writes one.
 *
 * The second is the empty vault as a place to stand. The workspace shell is served from a
 * note URL, so a vault with no notes cannot load it and cannot reach the palette — which
 * makes the vault index page the only way in, and the only thing that can prove it.
 *
 * One per project rather than one shared: `fullyParallel` runs both viewports against one
 * server, and "this vault has no notes" is not a claim two tests can make about one vault.
 */
export const E2E_EMPTY_SLUGS: Readonly<Record<string, string>> = {
  desktop: "empty-desktop",
  mobile: "empty-mobile",
};

/** The slug of the empty vault belonging to this project. */
export function emptyVaultSlug(project: string): string {
  const slug = E2E_EMPTY_SLUGS[project];
  if (slug === undefined) {
    throw new Error(`no empty vault for project \`${project}\` — add one to E2E_EMPTY_SLUGS`);
  }
  return slug;
}

/** Everything the run creates, under `target/` so `cargo clean` and `.gitignore` cover it. */
export const E2E_ROOT: string = join(REPO, "target", "e2e");

/**
 * The vault root, exported so a test can read the `.md` files back.
 *
 * That is not incidental: C2 says a note is plain Markdown on disk, and the only way to
 * assert it is to open the file the way a text editor would.
 */
export const E2E_VAULT: string = join(E2E_ROOT, "vault");

/** Where an empty vault's files go. Created, but deliberately left with nothing in it. */
export function emptyVaultRoot(project: string): string {
  return join(E2E_ROOT, emptyVaultSlug(project));
}

export const E2E_DATA_DIR: string = join(E2E_ROOT, "data");
export const E2E_CONFIG: string = join(E2E_DATA_DIR, "server.toml");

/** Vite's production output, which the editor route serves. */
export const E2E_WEB_ROOT: string = join(REPO, "web", "dist");
