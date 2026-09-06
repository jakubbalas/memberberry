/**
 * The application with the network taken away (`SPEC.md` §7.4, §22.6).
 *
 * This is the only thing in the project that can say offline support works. jsdom has no
 * service worker scope, no cache storage and no way to disconnect, so every unit test around
 * §7.4 asserts a decision rather than an outcome — and the outcome is the entire feature.
 *
 * The three cases are the three answers a navigation can get with no network: the note you
 * had open, the shell for a note you did not, and an honest page for a route that needs a
 * server.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { E2E_VAULT, scratchNote } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

/** Resolves once a service worker is installed, activated and controlling this page. */
async function serviceWorkerReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    // `ready` resolves on activation, which is one step before control: a page loaded from
    // the network is uncontrolled until the worker claims it. Waiting for the claim is what
    // makes the next navigation go through the worker rather than the network.
    if (navigator.serviceWorker.controller === null) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      });
    }
  });
}

/** Every symptom of a disconnected browser, which these tests cause on purpose. */
function allowDisconnection(failures: { allow(pattern: RegExp): void }): void {
  failures.allow(/net::ERR_INTERNET_DISCONNECTED/);
  failures.allow(/net::ERR_NETWORK_CHANGED/);
  failures.allow(/Failed to load resource/);
  failures.allow(/Failed to fetch/);
  failures.allow(/WebSocket/);
  // The offline page answers 503, because a navigation that could not be served is not a
  // success. Allowed by status rather than by URL: the request is the note URL, not the
  // page's.
  failures.allow(/HTTP 503/);
}

test("the application declares itself installable", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");

  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const parsed = (await manifest.json()) as { name: string; start_url: string; icons: unknown[] };
  expect(parsed.name).toBe("Memberberry");
  expect(parsed.start_url).toBe("/");
  expect(parsed.icons.length).toBeGreaterThan(0);

  // An icon the manifest names and the server does not serve is an install that fails with
  // no message, which is exactly the shape of the M5 asset bug.
  const icon = await page.request.get("/icon.svg");
  expect(icon.status()).toBe(200);
});

test("a note that has been opened is still readable with no network", async ({ page, context, failures }) => {
  allowDisconnection(failures);

  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  // Wait for the note to arrive over the CRDT: the body is never in the HTML (§3.3), so this
  // is what says the local replica exists to be read back later.
  await expect(page.getByText("A note that already exists")).toBeVisible();
  await serviceWorkerReady(page);

  await context.setOffline(true);
  await page.goto("/v/personal/Welcome.md");

  // The page came from the cache, not the server: `mb-server` fills these attributes in and
  // the precached shell has them empty (§7.4).
  await expect(page.locator("#app")).toHaveAttribute("data-vault", "");
  // ...and the client worked out which note it is from the URL, then read the body out of
  // IndexedDB. Both halves have to hold for this text to be on screen.
  await expect(page.getByText("A note that already exists")).toBeVisible();
});

test("a note that was never opened still gets the application, not a browser error", async ({
  page,
  context,
  failures,
}) => {
  allowDisconnection(failures);

  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await serviceWorkerReady(page);

  await context.setOffline(true);
  await page.goto("/v/personal/Projects/Roadmap.md");

  // The shell renders the workspace for a note whose body was never downloaded. What it
  // cannot do is show the body — that is §7.2's tiered replication, and until it lands the
  // honest state is an empty editor rather than Chrome's dinosaur.
  await expect(page.locator("#app")).toHaveAttribute("data-vault", "");
  await expect(page.locator(".ProseMirror").first()).toBeVisible();
});

test("a route that needs a server says so rather than failing", async ({ page, context, failures }) => {
  allowDisconnection(failures);

  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await serviceWorkerReady(page);

  await context.setOffline(true);
  await page.goto("/");

  // The vault list is server-rendered and has no offline form of itself. Handing it the
  // shell would render an editor over a URL that has never been one (`offlineFallbackFor`).
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
});

test("an edit made offline reaches the server when the network comes back", async ({
  page,
  context,
  failures,
}, info) => {
  // The one that matters most in this file, and the bug it was written for is the one M5
  // shipped: an update produced while the socket was closed was applied locally, persisted to
  // IndexedDB and *never sent*. The note stayed correct on the device and wrong everywhere
  // else, silently, forever. Only a browser can produce that sequence — the socket has to
  // really close and really come back.
  allowDisconnection(failures);
  const note = scratchNote("offline-edit", info.project.name);

  await signIn(page);
  await page.goto(`/v/personal/${note}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("A note this test may edit");

  await context.setOffline(true);
  const status = page.locator(".connection-status");
  await expect(status).toHaveText("Offline — you are editing alone");

  // The middle paragraph rather than the last line: on a phone the editor's control strip is
  // pinned to the bottom of the viewport and overlays it (`HANDOFF.md`).
  await editor.getByText("A note this test may edit").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Written on a train.");

  // §7.4's count: the difference between "nothing is happening" and "four changes exist only
  // here" is the whole reason this indicator says a number.
  await expect(status).toContainText("unsent");
  await expect(status).toContainText("saved on this device");

  await context.setOffline(false);
  // Hidden again means connected with nothing left to send — the flush went out. It is a
  // stronger assertion than "online" because it is the pending count that has to reach zero.
  await expect(status).toBeHidden({ timeout: 15_000 });

  // C2: the proof is the file a text editor would open, not anything the browser says.
  const path = join(E2E_VAULT, ...note.split("/"));
  await expect
    .poll(() => readFileSync(path, "utf8"), { timeout: 15_000, intervals: [100] })
    .toContain("Written on a train.");
});
