/**
 * A divergent reconnection, in a real browser (`SPEC.md` §3.5, §22.7).
 *
 * §22.7 asks for one thing this project cannot check any other way: "an offline edit
 * colliding with an external file edit produces exactly one conflict callout, containing both
 * versions... each resolution action leaves valid content and syncs". Every part of that needs
 * a browser and a server at once — the socket has to really close, the file watcher has to
 * really see the file change, and the two versions have to really meet on reconnect. jsdom can
 * assert the decision; only this can assert the outcome.
 *
 * It has already earned that. Written against a green unit suite, the first run of this file
 * found the callout being inserted and then reverted seconds later: the server's
 * external-change path recorded only its *own* writes as known, so every later sweep re-read
 * the same file as a fresh external edit and made the document match it again — deleting
 * whatever had arrived in between. See `mb-server/tests/sync.rs`.
 *
 * The collision is caused rather than simulated: the note is edited in the page with the
 * network off, and the *file* is edited on disk in the same window, which is §3.4's external
 * change path. That is the sequence §3.5 exists for, and the one a user hits by having
 * Obsidian open on a laptop and a phone on a train.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Browser, Locator, Page } from "@playwright/test";

import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

/** Every symptom of a browser with its network taken away, which these tests cause. */
function allowDisconnection(failures: { allow(pattern: RegExp): void }): void {
  failures.allow(/net::ERR_INTERNET_DISCONNECTED/);
  failures.allow(/net::ERR_NETWORK_CHANGED/);
  failures.allow(/Failed to load resource/);
  failures.allow(/Failed to fetch/);
  failures.allow(/WebSocket/);
}

/**
 * Opens a note and waits until this device and the server agree about it.
 *
 * The wait is what records §3.5's merge base: it is written when the server's whole state
 * arrives, and without it the merge that follows has nothing to compare against and falls back
 * to the two-way comparison — which would still mark this collision, and would make the test
 * pass for the wrong reason.
 */
async function openInSync(page: Page, note: string): Promise<Locator> {
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("A note this test may edit");
  // Hidden means connected with nothing pending, which only happens after the sync frame.
  await expect(page.locator(".connection-status")).toBeHidden({ timeout: 15_000 });
  return editor;
}

/**
 * A second, permanently online client on the same note.
 *
 * why: it is how the test knows the *server* has imported a file edit, and the ordering is
 * the whole difficulty. Writing a file proves nothing about the server — §3.4's watcher has
 * to see it, diff it against the CRDT and apply the difference — and reconnecting before that
 * happens is not a collision at all: the offline client flushes first, the external edit lands
 * afterwards as an ordinary update, and the two never meet.
 *
 * A second browser context rather than a second page, because `setOffline` is per context and
 * this one must stay connected. It is also the honest shape of the situation: somebody else's
 * laptop is what sees the Obsidian edit arrive.
 */
async function onlineObserver(browser: Browser, note: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("A note this test may edit");
  return {
    /** Resolves once the server has imported the file edit and broadcast it. */
    sees: async (text: string): Promise<void> => {
      await expect(editor).toContainText(text, { timeout: 20_000 });
    },
    close: (): Promise<void> => context.close(),
  };
}

/** Rewrites the note's file the way Obsidian or `git pull` would (§3.4). */
function editOnDisk(note: string, from: string, to: string): void {
  const path = join(E2E_VAULT, ...note.split("/"));
  const before = readFileSync(path, "utf8");
  expect(before).toContain(from);
  writeFileSync(path, before.replace(from, to), "utf8");
}

function fileOf(note: string): string {
  return readFileSync(join(E2E_VAULT, ...note.split("/")), "utf8");
}

test("an offline edit colliding with a file edit is marked, not silently merged", async ({
  page,
  context,
  browser,
  failures,
}, info) => {
  allowDisconnection(failures);
  const note = scratchNote("conflict", info.project.name);

  await signIn(page);
  const editor = await openInSync(page, note);
  const observer = await onlineObserver(browser, note);

  try {
    await context.setOffline(true);
    await expect(page.locator(".connection-status")).toHaveText(
      "Offline — you are editing alone",
    );

    // The paragraph, not the heading or the task: §3.5's example is a paragraph both sides
    // rewrote, and a heading and a task item have their own block rules on top of that.
    await editor.getByText("A note this test may edit").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Written on a train.");
    await expect(page.locator(".connection-status")).toContainText("unsent");

    // The same paragraph, changed differently, in the file — and not merely written: waited
    // for, until the server has it. Only then have the two versions genuinely diverged.
    editOnDisk(
      note,
      "A note this test may edit.",
      "A note this test may edit. Written at a desk.",
    );
    await observer.sees("Written at a desk.");

    await context.setOffline(false);

    // §3.5: the local version stays in place and the divergent one follows it as a callout.
    const callout = page.locator("aside[data-callout='conflict']");
    await expect(callout).toHaveCount(1, { timeout: 20_000 });
    await expect(callout).toContainText("Conflicting version — external edit");
    await expect(callout).toContainText("Written at a desk.");
    await expect(editor).toContainText("Written on a train.");

    // The count §3.5 asks for, and the three actions on the callout.
    await expect(page.locator(".conflict-count")).toHaveText(
      "1 unresolved conflict — choose a version below",
    );
    await expect(callout.locator(".conflict-action")).toHaveText([
      "Keep mine",
      "Keep theirs",
      "Keep both",
    ]);

    // C2: the callout is in the file, as Markdown a text editor shows as a labelled quote —
    // and it is still there a moment later, which is the part the server used to get wrong.
    await expect
      .poll(() => fileOf(note), { timeout: 20_000, intervals: [200] })
      .toContain("> [!conflict] Conflicting version");
    await expect(callout).toHaveCount(1);
    expect(fileOf(note)).toContain("Written on a train.");
    expect(fileOf(note)).toContain("> A note this test may edit. Written at a desk.");
  } finally {
    await observer.close();
  }
});

test("resolving a conflict keeps one version, and it reaches the file", async ({
  page,
  context,
  browser,
  failures,
}, info) => {
  allowDisconnection(failures);
  const note = scratchNote("conflict-resolve", info.project.name);

  await signIn(page);
  const editor = await openInSync(page, note);
  const observer = await onlineObserver(browser, note);

  try {
    await context.setOffline(true);
    await editor.getByText("A note this test may edit").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Mine.");
    await expect(page.locator(".connection-status")).toContainText("unsent");

    editOnDisk(note, "A note this test may edit.", "A note this test may edit. Theirs.");
    await observer.sees("Theirs.");

    await context.setOffline(false);
    const callout = page.locator("aside[data-callout='conflict']");
    await expect(callout).toHaveCount(1, { timeout: 20_000 });

    // Keep theirs: the hardest of the three, because it has to replace exactly the local block
    // in front of the callout rather than the whole run (§3.5, `mb_core::conflict::resolve`).
    await callout.getByRole("button", { name: "Keep theirs" }).click();

    await expect(page.locator("aside[data-callout='conflict']")).toHaveCount(0);
    await expect(page.locator(".conflict-count")).toBeHidden();
    await expect(editor).toContainText("Theirs.");
    await expect(editor).not.toContainText("Mine.");

    // §3.5: "resolution syncs". Two places can say so, and both are checked — the other
    // client, and the file a text editor would open.
    await observer.sees("Theirs.");
    await expect
      .poll(() => fileOf(note), { timeout: 20_000, intervals: [200] })
      .not.toContain("[!conflict]");
    const file = fileOf(note);
    expect(file).toContain("Theirs.");
    expect(file).not.toContain("Mine.");
  } finally {
    await observer.close();
  }
});
