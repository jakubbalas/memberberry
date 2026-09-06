/**
 * The browser half of the harness: the scenarios, on both device classes of `SPEC.md` §21.1.
 *
 * **What "mobile" means here, stated up front because it is the harness's biggest honest
 * limit.** §21.1 writes the budgets against a mid-range 2023–24 Android — Pixel 7a class.
 * This runs Chromium on the developer's or the runner's machine with its viewport, pixel
 * ratio and touch pointer emulated and its CPU throttled by a fixed factor. That is an
 * approximation of a slower device, not that device. It catches the thing a laptop-only
 * measurement cannot — work that is cheap at 1x and expensive at 4x — and it cannot tell you
 * about the phone's GPU, its memory pressure, its thermal behaviour or its browser version.
 * Every mobile number the harness prints carries the throttling factor next to it so it is
 * never quoted as a phone measurement.
 *
 * Every timing is taken **inside the page** from `performance.now()`, never across the
 * WebSocket to the driver. A number that includes the CDP round trip measures the harness.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

import type { DeviceClass } from "./budgets.ts";
import { PERF_NOTE, PERF_QUERY, PERF_SLUG, PERF_USER } from "./server.ts";

const EDITOR = ".editor-surface .tiptap";
// why: a CSS selector rather than `getByRole`, because these measurements are taken inside
// the page and the selector has to be one `querySelector` understands. It matches the
// element, not the role: `Palette.svelte` renders a native `<dialog>`, whose dialog role is
// implicit, so `[role="dialog"]` matches nothing at all — which is how the first run of this
// harness spent 30 s waiting for a switcher that was already open.
const SWITCHER = 'dialog.palette[aria-label="Open a note"]';
const SWITCHER_INPUT = `${SWITCHER} .palette-input`;

/** How many times each scenario runs. Enough for a p95 to mean something, few enough to run. */
const REPEATS = { coldStart: 5, warmStart: 5, openNote: 12, keystrokes: 60, switcher: 12, graphFrames: 90 } as const;

/**
 * Fewest samples a browser measurement may be reported from.
 *
 * why: a median of one sample is not a median. When a scenario loses most of its samples —
 * which the quick switcher does on the throttled profile — reporting the survivor produces a
 * confident-looking number with no distribution behind it. Below this the metric is dropped,
 * which the report then prints as a budget nothing measured. A hole is honest; a median of
 * one is not.
 */
const MIN_SAMPLES = 3;

export interface DeviceProfile {
  readonly name: DeviceClass;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  /** CDP `Emulation.setCPUThrottlingRate`. 1 is no throttling. */
  readonly cpuThrottle: number;
}

/**
 * The two device classes.
 *
 * The mobile factor is 4x, which is Lighthouse's mobile default and the most widely
 * understood number to quote. It is a convention, not a calibration: nobody here has
 * measured a Pixel 7a to derive it. Override it with `MB_PERF_CPU_THROTTLE` when you have.
 */
export const PROFILES: readonly DeviceProfile[] = [
  {
    name: "desktop",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    cpuThrottle: 1,
  },
  {
    name: "mobile",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    cpuThrottle: Number.parseFloat(process.env["MB_PERF_CPU_THROTTLE"] ?? "4"),
  },
];

/** One metric's samples, as measured. Reduced to a median or a p95 by the report. */
export interface Measurement {
  readonly id: string;
  readonly samples: readonly number[];
  /** How the samples should be reduced for the budget comparison. */
  readonly reduce: "median" | "p95" | "max";
  /** Anything a reader needs in order not to over-read the number. */
  readonly caveat?: string;
}

export interface DeviceRun {
  readonly device: DeviceClass;
  readonly cpuThrottle: number;
  readonly measurements: readonly Measurement[];
  /** Scenarios that produced nothing usable on this device, and why. */
  readonly lost: readonly string[];
  /** Bytes the browser actually received for scripts and wasm on a cold editor load. */
  readonly observedTransfer: number;
  /** Whether any of those responses arrived compressed. */
  readonly observedCompressed: boolean;
}

/**
 * Instrumentation installed before any page script runs.
 *
 * why: `addInitScript`, not `evaluate`. A long task during bootstrap — which is where the
 * expensive ones are — is over before an `evaluate` could subscribe to it, and the M0→M7
 * WASM growth means bootstrap is exactly where to look.
 */
const INSTRUMENT = `
  window.__mbLongTasks = [];
  window.__mbInteractions = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__mbLongTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.interactionId > 0) window.__mbInteractions.push(entry.duration);
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 0 });
`;

/**
 * How long any single in-page measurement may take before it is called a failure.
 *
 * why: every scenario here waits on a DOM condition inside the page, and a condition that
 * never becomes true is a promise that never settles — the harness then hangs forever with
 * no output, which is exactly how the first mobile run went. Playwright's own timeouts do not
 * cover an `evaluate` that resolves on its own schedule, so the deadline has to be inside it.
 */
const IN_PAGE_TIMEOUT_MS = 10_000;

/** Reads a number array the instrumentation left on `window`. */
async function readNumbers(page: Page, name: "__mbLongTasks" | "__mbInteractions" | "__mbKeys") {
  return page.evaluate((key) => {
    const store = (globalThis as unknown as Record<string, unknown>)[key];
    return Array.isArray(store) ? store.filter((n): n is number => typeof n === "number") : [];
  }, name);
}

/** Whatever `BrowserContext.storageState()` returns — the session cookie, in practice. */
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * The signed session cookie, obtained once by driving the real sign-in form.
 *
 * why: the real form rather than a forged cookie. The harness measures the production
 * bundle against the production server, and a hand-built cookie would be the one part of
 * the path that was not the real one.
 */
async function signedInState(browser: Browser, origin: string): Promise<StorageState> {
  const context = await browser.newContext({ baseURL: origin });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("textbox", { name: "Username" }).fill(PERF_USER.username);
  await page.getByLabel("Password").fill(PERF_USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "Vaults" }).waitFor();
  const state = await context.storageState();
  await context.close();
  return state;
}

/**
 * Everything the browser complained about during the current device run.
 *
 * why: the harness watches for these for the same reason the E2E suite's `failures` fixture
 * does (SPEC §22.6) — a number measured on a page that threw is not a measurement of the
 * application, it is a measurement of the application's wreckage. The E2E suite learned this
 * the hard way: its first run found an uncaught exception out of the socket handler that 31
 * passing unit tests had never seen.
 */
let problems: string[] = [];

function watch(context: BrowserContext): void {
  context.on("page", (page) => {
    page.on("pageerror", (error) => problems.push(`uncaught exception: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`);
    });
  });
}

async function newContext(
  browser: Browser,
  profile: DeviceProfile,
  origin: string,
  storageState: StorageState,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: origin,
    storageState,
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  });
  watch(context);
  // why: 10 s rather than Playwright's 30 s default. Every wait here is on something that
  // either happens promptly or is not going to; three of them at 30 s each turned a lost
  // sample into a two-minute stall, and twelve of those into a harness nobody would wait for.
  context.setDefaultTimeout(10_000);
  await context.addInitScript(INSTRUMENT);
  return context;
}

/**
 * Waits for the page's main thread to report itself idle.
 *
 * why: every scenario has to start from an idle thread or it measures the tail of the one
 * before it. `requestIdleCallback` is the browser's own answer to "are you busy", which is
 * why this is not a `waitForTimeout` — a guessed sleep is both slower and less true, and
 * AGENTS.md §2.3 is explicit about sleeps standing in for a signal.
 *
 * This is not a nicety. Without it the first `Mod+K` after the 60-keystroke burst was
 * **dropped** — the shell never saw it, a second press worked, and the harness reported the
 * quick switcher as broken. See HANDOFF.md: whether a shortcut pressed into a saturated main
 * thread should survive is a real question about the shell, but a harness that starts its
 * scenarios in the middle of the previous one cannot be the thing that asks it.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestIdleCallback(() => resolve(), { timeout: 3_000 });
      }),
  );
}

/** Applies the device's CPU throttling to one page. */
async function throttle(context: BrowserContext, page: Page, rate: number): Promise<void> {
  if (rate === 1) return;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
}

/**
 * Navigates to a note and returns the in-page milliseconds from navigation start until the
 * editor surface exists.
 *
 * `waitUntil: "commit"` so the observer is installed while the document is still loading;
 * the initial `querySelector` covers the case where it beat us to it anyway.
 */
async function timeToEditor(page: Page, url: string): Promise<number> {
  await page.goto(url, { waitUntil: "commit" });
  return page.evaluate(
    ([selector, deadline]) =>
      new Promise<number>((resolve, reject) => {
        if (document.querySelector(selector) !== null) {
          resolve(performance.now());
          return;
        }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`${selector} never appeared within ${deadline} ms of navigating`));
        }, deadline);
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector) === null) return;
          observer.disconnect();
          clearTimeout(timer);
          // One frame later: the element existing is not the same as it having been painted.
          requestAnimationFrame(() => resolve(performance.now()));
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }),
    [EDITOR, IN_PAGE_TIMEOUT_MS] as const,
  );
}

/**
 * Cold start → interactive, warm service-worker cache (§21.2).
 *
 * The other half of the cold-start pair, and the one M6 unblocked: a returning visit, where
 * the build is already in cache storage and the page fetches only the note's own HTML. One
 * context for the whole scenario — that is what makes the cache warm — and a fresh page per
 * sample, which is what still makes it a start.
 *
 * **If the worker never takes control, this returns no samples.** A page that was measured
 * before the worker claimed it is measuring the network, and a number like that is worse
 * than a hole: the report would show a budget met by a feature that was not running. §21.4's
 * rule is that a measurement which cannot observe its own subject is not a measurement.
 */
async function warmCacheStart(
  browser: Browser,
  profile: DeviceProfile,
  origin: string,
  storageState: StorageState,
): Promise<{ samples: number[]; controlled: boolean }> {
  const url = `/v/${PERF_SLUG}/${PERF_NOTE}`;
  const context = await newContext(browser, profile, origin, storageState);
  try {
    const first = await context.newPage();
    await throttle(context, first, profile.cpuThrottle);
    await timeToEditor(first, url);
    const controlled = await controlledByWorker(first);
    await first.close();
    if (!controlled) return { samples: [], controlled };

    const samples: number[] = [];
    for (let attempt = 0; attempt < REPEATS.warmStart; attempt += 1) {
      const page = await context.newPage();
      await throttle(context, page, profile.cpuThrottle);
      samples.push(await timeToEditor(page, url));
      await page.close();
    }
    return { samples, controlled };
  } finally {
    await context.close();
  }
}

/** Whether a service worker is installed, activated and controlling this page. */
async function controlledByWorker(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const claimed = new Promise<boolean>((resolve) => {
      if (navigator.serviceWorker.controller !== null) {
        resolve(true);
        return;
      }
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), {
        once: true,
      });
    });
    // `ready` resolves on activation, one step before control: registration is asked for
    // after the load event, so on a first visit this waits for both.
    await navigator.serviceWorker.ready;
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 5_000);
    });
    return Promise.race([claimed, timeout]);
  });
}

/**
 * Cold start → interactive, first ever visit (§21.2).
 *
 * A fresh context per sample, which is what makes it cold: no HTTP cache, no IndexedDB
 * replica, no service worker. The session cookie is carried in because signing in is not part
 * of what this budget measures.
 *
 * Also the run that collects the long-task figure, because bootstrap is where the long tasks
 * are and a metric measured on an idle page would report zero and look like compliance.
 */
async function coldStart(
  browser: Browser,
  profile: DeviceProfile,
  origin: string,
  storageState: StorageState,
): Promise<{ samples: number[]; longTasks: number[]; transfer: number; compressed: boolean }> {
  const samples: number[] = [];
  const longTasks: number[] = [];
  let transfer = 0;
  let compressed = false;

  for (let attempt = 0; attempt < REPEATS.coldStart; attempt += 1) {
    const context = await newContext(browser, profile, origin, storageState);
    const page = await context.newPage();
    await throttle(context, page, profile.cpuThrottle);

    // Only the first sample's transfer is recorded: they are identical, and summing them
    // would report five page loads as one.
    if (attempt === 0) {
      page.on("response", (response) => {
        const url = response.url();
        if (!/\.(?:js|wasm)(?:\?|$)/.test(url)) return;
        void response
          .headerValue("content-length")
          .then((length) => {
            transfer += Number.parseInt(length ?? "0", 10) || 0;
          })
          .catch(() => undefined);
        void response
          .headerValue("content-encoding")
          .then((encoding) => {
            if (encoding !== null && encoding !== "identity") compressed = true;
          })
          .catch(() => undefined);
      });
    }

    samples.push(await timeToEditor(page, `/v/${PERF_SLUG}/${PERF_NOTE}`));
    // why: one figure per load — the worst task in it — rather than every task from every
    // load pooled together. The Long Tasks API only reports a task once it exceeds 50 ms,
    // which is also this budget, so a load with no entries means nothing crossed the line.
    // Pooling made that load contribute *nothing*, and a device with no long tasks anywhere
    // then had the metric dropped for want of samples — reported as a hole when it was
    // actually the best possible result.
    const observed = await readNumbers(page, "__mbLongTasks");
    longTasks.push(observed.length === 0 ? 0 : Math.max(...observed));
    await context.close();
  }
  return { samples, longTasks, transfer, compressed };
}

/**
 * The two notes the "open note" scenario alternates between, and the text that proves which
 * one is on screen.
 *
 * The markers are chosen so neither appears in the other note. The measurement resolves when
 * the editor is showing the target's text, and a marker present in both would resolve
 * immediately and report a switch that never happened as a very fast one.
 */
const NOTES = [
  { path: PERF_NOTE, marker: "Note 0" },
  { path: "folder-27/note-00777.md", marker: "Note 777", title: "Note 777" },
] as const;

/**
 * How the active note is switched — which is not the same control on the two layouts.
 *
 * §8.3 gives mobile no tab strip at all. A harness that clicked `[role="tab"]` on both would
 * not measure mobile; it would fail on it, which is how the first run of this file went.
 */
interface TabSwitch {
  /** Selector for the clickable switch targets, one per open note, in tab order. */
  readonly selector: string;
  /** Run untimed before each switch — opening mobile's sheet, for instance. */
  prepare(page: Page): Promise<void>;
}

const DESKTOP_TABS: TabSwitch = {
  selector: '[role="tab"]',
  prepare: () => Promise.resolve(),
};

/**
 * Mobile switches through the bottom-sheet tab switcher (§8.3), so the sheet is opened first
 * and that is deliberately outside the timed window: §21.2 budgets rendering the note, not
 * the animation of the control that asked for it.
 */
const MOBILE_SHEET: TabSwitch = {
  selector: "dialog.tab-sheet .tab-sheet-open",
  async prepare(page: Page): Promise<void> {
    await page.locator(".mobile-bar-tabs").click();
    await page.locator("dialog.tab-sheet .tab-sheet-open").first().waitFor();
  },
};

/**
 * Clicks the `index`-th switch target and returns the in-page milliseconds until the editor
 * is showing `marker`.
 *
 * The click is issued inside the page so the number carries no CDP round trip, and the
 * observer resolves on **the editor's own text** rather than on the first mutation anywhere:
 * on mobile the first mutation is the sheet closing, which would time the sheet instead of
 * the note.
 */
async function timeSwitch(
  page: Page,
  selector: string,
  index: number,
  marker: string,
): Promise<number> {
  return page.evaluate(
    ([target, which, want, editor, deadline]) =>
      new Promise<number>((resolve, reject) => {
        const targets = document.querySelectorAll(target);
        const element = targets[which];
        if (!(element instanceof HTMLElement)) {
          reject(
            new Error(`${target}[${which}] is not there — ${targets.length} elements match`),
          );
          return;
        }
        const showing = (): string => document.querySelector(editor)?.textContent ?? "";
        if (showing().includes(want)) {
          reject(new Error(`the editor already shows "${want}", so there is nothing to time`));
          return;
        }
        const start = performance.now();
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`the editor never showed "${want}" within ${deadline} ms`));
        }, deadline);
        const observer = new MutationObserver(() => {
          if (!showing().includes(want)) return;
          observer.disconnect();
          clearTimeout(timer);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now() - start)),
          );
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        element.click();
      }),
    [selector, index, marker, EDITOR, IN_PAGE_TIMEOUT_MS] as const,
  );
}

/**
 * Open note ≤ 5k words, locally resident (§21.2).
 *
 * Both notes are opened first, so both replicas are local, and then the harness alternates
 * between them. That is the only reading of an 80 ms budget that can be true: no page load
 * completes in 80 ms on any device, so "open note, locally resident" means switching to a
 * note the session already holds.
 */
async function openNote(page: Page, tabs: TabSwitch): Promise<number[]> {
  await page.goto(`/v/${PERF_SLUG}/${NOTES[0].path}`);
  await page.locator(EDITOR).first().waitFor();
  await openViaSwitcher(page, NOTES[1].title);
  await page.locator(EDITOR).first().filter({ hasText: NOTES[1].marker }).waitFor();

  const samples: number[] = [];
  for (let attempt = 0; attempt < REPEATS.openNote; attempt += 1) {
    const index = attempt % 2;
    const target = index === 0 ? NOTES[0] : NOTES[1];
    await settle(page);
    await tabs.prepare(page);
    samples.push(await timeSwitch(page, tabs.selector, index, target.marker));
  }
  return samples;
}

/**
 * Presses the quick-switcher shortcut and waits for the dialog.
 *
 * why: its own function, with its own diagnostics. `Palette.svelte` renders the `<dialog>`
 * whether or not it is open, so Playwright's message for "the shortcut did nothing" is
 * "timeout waiting for a hidden dialog to be visible" — which says nothing about the cause.
 * Where the focus was at the time is the first thing anyone wants to know, so it is in the
 * error rather than in the next person's debugging session.
 */
async function openSwitcher(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  try {
    await page.locator(SWITCHER).waitFor({ timeout: 10_000 });
  } catch (cause) {
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      return active === null
        ? "nothing"
        : `${active.tagName.toLowerCase()}.${active.className}`.slice(0, 120);
    });
    const dialogs = await page.evaluate(() =>
      [...document.querySelectorAll("dialog")].map((d) => `${d.className}:${d.open}`).join(", "),
    );
    throw new Error(
      `Mod+K did not open the quick switcher. Focus was on ${focus}; dialogs: ${dialogs}. ` +
        "SPEC §8.4 requires the shortcut to work from inside the editor, so this is either a " +
        `regression there or a modal already holding the key. The browser reported: ` +
        `${problems.length === 0 ? "nothing" : problems.join(" | ")}`,
      { cause },
    );
  }
}

/**
 * Opens the quick switcher and opens the note whose label is exactly `title`.
 *
 * why: the *exact* label rather than the first result or Enter. "Note 777" is a prefix of
 * "Note 7770", which also exists in a 10 000-note vault, so which of the two the ranker puts
 * first is a detail of the ranker — and a scenario that silently opened the wrong note would
 * still produce plausible numbers for the wrong thing.
 */
async function openViaSwitcher(page: Page, title: string): Promise<void> {
  await openSwitcher(page);
  await setQuery(page, title);
  await optionExactly(page, title).click();
  await page.locator(SWITCHER).waitFor({ state: "hidden" });
}

/** A string as an anchored regex, for matching a label exactly. */
function exactly(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/**
 * The switcher option whose label is exactly `label`.
 *
 * why: `hasText` with an anchored regex rather than `:text-is`. A query that matches the whole
 * label wraps the whole label in one `<mark>`, and `:text-is` matches the *smallest* element
 * holding the text — so it finds the `<mark>` and never the `.palette-label`, which reads as
 * "the note is not in the list" for the one note that matched best.
 */
function optionExactly(page: Page, label: string) {
  return page
    .locator(`${SWITCHER} [role="option"]`)
    .filter({ has: page.locator(".palette-label", { hasText: exactly(label) }) })
    .first();
}

/**
 * Puts `query` in the switcher's input the way a person would, and proves it landed.
 *
 * Three things this has to work around, all of them found by getting them wrong:
 *
 * 1. **The switcher keeps its last query when reopened.** Typing therefore *appends*, and the
 *    harness ends up measuring a query nobody wrote ("Note 4242Note 424"). So it is cleared
 *    first, with select-all and a Backspace — the same two keys a person would use.
 * 2. **`fill()` does not survive.** The input is `value={query}` with an `oninput` handler
 *    rather than `bind:value`, so Svelte owns the value and re-asserts it. A programmatic
 *    `fill` reads back correctly and is then reverted a moment later, which showed up as a
 *    result list belonging to the *previous* query. Real keystrokes are what the component is
 *    built for, so real keystrokes are what this sends.
 * 3. **Focus arrives a beat after the shortcut.** Typing in the same breath can land nowhere,
 *    so the input is focused explicitly before anything is typed.
 */
async function setQuery(page: Page, query: string): Promise<void> {
  const input = page.locator(SWITCHER_INPUT);
  await input.waitFor();
  await input.focus();

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const cleared = await input.inputValue();
  if (cleared !== "") {
    throw new Error(
      `the switcher's query would not clear — it still holds ${JSON.stringify(cleared)}, so ` +
        "anything typed next would be appended to it",
    );
  }

  await page.keyboard.type(query, { delay: 10 });
  const value = await input.inputValue();
  if (value !== query) {
    throw new Error(
      `the switcher holds ${JSON.stringify(value)} rather than ${JSON.stringify(query)}, so ` +
        "the next measurement would be of the wrong query",
    );
  }
}

/**
 * Keystroke → paint, p95 (§21.2), and the interactions INP is computed from.
 *
 * The keystroke figure is a **double-`requestAnimationFrame`** measurement: from the
 * `keydown` to the frame after the one that rendered it. That includes the wait for the next
 * vsync boundary, so on an idle 60 Hz display it reads roughly one frame high and cannot
 * distinguish "made the next frame comfortably" from "took a full frame of work". It is
 * nonetheless the honest measurement to publish against a budget whose own wording is
 * "keystroke → paint": what it detects reliably is the failure this budget exists to catch,
 * a keystroke that costs two or three frames instead of one.
 *
 * Event Timing would give the processing duration directly, but Chromium rounds those entries
 * to 8 ms for privacy — useless granularity against a 16 ms budget, and fine against INP's
 * 100–200 ms, which is why INP is taken from there and this is not.
 */
async function keystrokes(page: Page): Promise<{ toPaint: number[]; interactions: number[] }> {
  await page.locator(EDITOR).first().click();
  await page.evaluate(() => {
    const store: number[] = [];
    (globalThis as unknown as Record<string, unknown>)["__mbKeys"] = store;
    document.addEventListener(
      "keydown",
      () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => store.push(performance.now() - start)),
        );
      },
      { capture: true },
    );
  });

  // A delay between keys, so each is measured against an otherwise idle main thread rather
  // than against the queue left by the one before it. `SPEC.md` §21.2 budgets one keystroke.
  await page.keyboard.type("x".repeat(REPEATS.keystrokes), { delay: 25 });

  return {
    toPaint: await readNumbers(page, "__mbKeys"),
    interactions: await readNumbers(page, "__mbInteractions"),
  };
}

/**
 * Frame time while the global graph is being moved (§21.2's graph row, §9.4).
 *
 * **What this measures, and what it does not.** The budget is a *sustained* frame rate over
 * a whole vault, so the picture has to be doing work on every frame — an idle canvas paints
 * nothing and would report a perfect 16 ms whatever the renderer cost. So this drives a wheel
 * event from inside an animation-frame loop: every frame changes the camera, which redraws
 * every node and every edge, and the interval between frames is what that costs. It does
 * **not** measure the force layout, which runs in a worker and is finished by the time this
 * starts — that is deliberate, because §21.2 budgets the frame rate of the picture rather
 * than how long it takes to settle.
 *
 * The zoom reverses every twenty frames so the camera stays in the middle of its range: run
 * one way for long enough and every node is off screen, which is a cheap frame that flatters
 * the number.
 *
 * The node count is the application's own: §9.4 caps a phone at the top 2,000 by degree and
 * gives a desktop the whole vault, which is exactly what §21.2 budgets the two columns at.
 * The count actually drawn is returned so the report can say which it measured.
 */
async function graphFrames(page: Page): Promise<{ samples: number[]; nodes: number }> {
  await settle(page);
  // The scenario before this one drives the quick switcher, and a palette left open would
  // swallow the hotkey below.
  await page.keyboard.press("Escape");
  await settle(page);
  // The command palette's binding rather than a click: the graph has no chrome outside it,
  // and this is the path §8.4 registers (`Mod+Shift+G`).
  await page.keyboard.press("ControlOrMeta+Shift+G");
  const surface = page.locator(".graph-view-surface");
  await surface.waitFor({ state: "visible", timeout: 60_000 });

  // Wait for the layout to stop moving. `data-nodes` is the drawn count; the settled state is
  // what stops the picture from being measured mid-flight, when the worker is still posting.
  await page.waitForFunction(
    () => document.querySelector(".graph-view-surface")?.getAttribute("data-nodes") !== "0",
    undefined,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(4_000);
  const nodes = Number.parseInt(
    (await surface.getAttribute("data-nodes")) ?? "0",
    10,
  );

  const samples = await page.evaluate(async (frames: number) => {
    const surfaceElement = document.querySelector(".graph-view-surface");
    if (surfaceElement === null) return [];
    const box = surfaceElement.getBoundingClientRect();
    const middleX = box.left + box.width / 2;
    const middleY = box.top + box.height / 2;
    const intervals: number[] = [];
    return new Promise<number[]>((resolve) => {
      let previous = performance.now();
      let count = 0;
      const step = (now: number): void => {
        // The first interval spans whatever the page was doing before this started.
        if (count > 0) intervals.push(now - previous);
        previous = now;
        count += 1;
        surfaceElement.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: count % 40 < 20 ? 40 : -40,
            clientX: middleX,
            clientY: middleY,
            bubbles: true,
            cancelable: true,
          }),
        );
        if (count <= frames) requestAnimationFrame(step);
        else resolve(intervals);
      };
      requestAnimationFrame(step);
    });
  }, REPEATS.graphFrames);

  await page.keyboard.press("Escape");
  return { samples, nodes };
}

/**
 * Quick-switcher results over 10k notes (§21.2).
 *
 * The switcher fetches the note index once when first opened and ranks client-side after
 * that, so the budgeted number is the **per-keystroke re-rank**: the harness types all but
 * the last character, then measures from that last keystroke until the rendered list has
 * changed and been painted.
 */
async function quickSwitcher(page: Page): Promise<{ samples: number[]; skipped: string[] }> {
  const samples: number[] = [];
  const skipped: string[] = [];
  let consecutiveLosses = 0;
  const head = PERF_QUERY.slice(0, -1);
  const tail = PERF_QUERY.slice(-1);

  for (let attempt = 0; attempt < REPEATS.switcher; attempt += 1) {
    // why: give up after three losses in a row, whether or not earlier samples worked. Each
    // loss costs the in-page deadline, so twelve of them is minutes spent demonstrating the
    // same thing over and over — and a harness slow enough to be skipped measures nothing.
    if (consecutiveLosses >= 3) {
      skipped.push(`abandoned after ${consecutiveLosses} consecutive losses`);
      break;
    }
    // why: a failed sample is skipped rather than fatal, and reported. Under a 4x CPU
    // throttle the palette's rendered list transiently disagrees with its input — it goes on
    // showing the previous query's results after the input has changed — so this scenario is
    // reliable on desktop and not on the throttled profile. Aborting the whole run over it
    // would throw away six metrics that measured fine, and pretending it succeeded would be
    // worse. What the report says instead is how many samples it got and why it lost the
    // rest, which is the honest answer and the one that says what to go and look at.
    try {
      samples.push(await sampleSwitcher(page, head, tail));
      consecutiveLosses = 0;
    } catch (error) {
      consecutiveLosses += 1;
      skipped.push(error instanceof Error ? error.message : String(error));
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  return { samples, skipped };
}

/** One quick-switcher sample: set the query up to its last character, then time that key. */
async function sampleSwitcher(page: Page, head: string, tail: string): Promise<number> {
  {
    await settle(page);
    await openSwitcher(page);
    await setQuery(page, head);
    // why: wait for the list `head` produces, not merely for *a* list. The switcher keeps
    // the previous sample's results on screen until the new ones are ranked, and capturing
    // the signature at that moment recorded the *final* query's list as the "before" — so
    // the last keystroke then changed nothing measurable and the sample timed out. "Note
    // 424" is in the head query's results and not in the full query's, which makes it the
    // marker that says the list has caught up.
    await optionExactly(page, head).waitFor();

    const pending = page.evaluate(
      (deadline) =>
        new Promise<number>((resolve, reject) => {
          // why: the dialog's body, not `#palette-list`. When a query stops matching
          // anything, Svelte swaps the `<ul id="palette-list">` for a "nothing matches"
          // paragraph — so an observer bound to the `<ul>` is watching a detached node and
          // never fires again. That is how the first mobile run came to hang.
          const body = document.querySelector("dialog.palette .palette-body");
          if (body === null) {
            reject(new Error("the switcher has no body to observe"));
            return;
          }
          // why: the whole rendered list, not "the top result changed". Which note the
          // ranker puts first for a given prefix is the ranker's business — for this vault
          // it already ranks "Note 4242" first while the query is still "Note 424" — and a
          // condition that assumes an answer measures whatever the ranker happens to do.
          // Adding a character to a query can only narrow the match set, so the rendered
          // list has to change; comparing against the signature captured *before* the
          // keystroke is also what makes a mutation batch left over from the earlier
          // characters unable to resolve this early.
          const signature = (): string =>
            [...body.querySelectorAll(".palette-label")].map((l) => l.textContent).join("|");
          const before = signature();
          let start = 0;
          document.addEventListener(
            "keydown",
            () => {
              start = performance.now();
            },
            { capture: true, once: true },
          );
          const timer = setTimeout(() => {
            observer.disconnect();
            reject(
              new Error(
                `the switcher's results did not change within ${deadline} ms of the last ` +
                  `keystroke. The list still reads ${before.slice(0, 120)}`,
              ),
            );
          }, deadline);
          const observer = new MutationObserver(() => {
            if (start === 0 || signature() === before) return;
            observer.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(performance.now() - start)),
            );
          });
          observer.observe(body, { childList: true, subtree: true, characterData: true });
        }),
      IN_PAGE_TIMEOUT_MS,
    );
    await page.keyboard.press(tail);
    const measured = await pending;
    // The measured keystroke has to have been the one intended, or the sample is of a
    // different query than the one this scenario claims to measure.
    const typed = await page.locator(SWITCHER_INPUT).inputValue();
    if (typed !== PERF_QUERY) {
      throw new Error(
        `the final keystroke left the query as ${JSON.stringify(typed)} rather than ` +
          `${JSON.stringify(PERF_QUERY)}`,
      );
    }
    await page.keyboard.press("Escape");
    await page.locator(SWITCHER).waitFor({ state: "hidden" });
    return measured;
  }
}

/**
 * Progress, on stderr.
 *
 * why: a full run takes minutes on the throttled profile, and a harness that prints nothing
 * until it finishes is one people assume has hung and kill — which is the same as not having
 * it. stderr so the report on stdout stays machine-readable.
 */
function report(profile: DeviceProfile, scenario: string): void {
  process.stderr.write(`  measured ${profile.name}: ${scenario}\n`);
}

/** Runs every browser scenario for one device class. */
export async function measureDevice(
  browser: Browser,
  profile: DeviceProfile,
  origin: string,
  storageState: StorageState,
): Promise<DeviceRun> {
  problems = [];
  const cold = await coldStart(browser, profile, origin, storageState);
  report(profile, "cold start");
  const warm = await warmCacheStart(browser, profile, origin, storageState);
  report(profile, "cold start, warm cache");

  const context = await newContext(browser, profile, origin, storageState);
  const page = await context.newPage();
  await throttle(context, page, profile.cpuThrottle);

  const noteSamples = await openNote(page, profile.isMobile ? MOBILE_SHEET : DESKTOP_TABS);
  report(profile, "open note");
  await settle(page);
  const keys = await keystrokes(page);
  report(profile, "keystrokes");
  await settle(page);
  const switcher = await quickSwitcher(page);
  report(profile, "quick switcher");
  await settle(page);
  const graph = await graphFrames(page);
  report(profile, "graph frame time");
  await context.close();

  if (problems.length > 0) {
    throw new Error(
      `${profile.name}: the browser reported problems, so these numbers describe a broken ` +
        `page rather than the application:\n  ${problems.join("\n  ")}`,
    );
  }

  const measurements: Measurement[] = [
    {
      id: "cold-start-first-visit",
      samples: cold.samples,
      reduce: "median",
      caveat: "fresh context per sample: no HTTP cache, no IndexedDB replica, no service worker",
    },
    {
      id: "cold-start-warm-cache",
      samples: warm.samples,
      reduce: "median",
      caveat:
        "one context across the samples, a fresh page for each: the service worker, the HTTP " +
        "cache and the IndexedDB replica are all warm, which is what a returning visit is. " +
        "The note's own HTML is still fetched — a navigation is network-first (§7.4)" +
        (warm.controlled ? "" : ". No worker ever took control, so these samples were dropped"),
    },
    {
      id: "open-note",
      samples: noteSamples,
      reduce: "median",
      caveat:
        "a ~120-word generated note. §21.2 bounds this row at 5k words, so the figure is " +
        "comfortably inside the bound and is not the worst case that budget allows",
    },
    {
      id: "keystroke-to-paint",
      samples: keys.toPaint,
      reduce: "p95",
      caveat: "double-rAF; includes the wait for the next vsync, so reads ~1 frame high",
    },
    {
      id: "inp",
      samples: keys.interactions,
      reduce: "p95",
      caveat: "Event Timing, rounded to 8 ms by Chromium",
    },
    {
      id: "longest-task",
      samples: cold.longTasks,
      reduce: "max",
      caveat:
        "worst task per cold-start load, where the long tasks are. The Long Tasks API only " +
        "reports a task over 50 ms — the same figure as this budget — so 0 ms means nothing " +
        "crossed that line on that load, not that no work happened",
    },
    {
      id: "quick-switcher",
      samples: switcher.samples,
      reduce: "median",
      caveat:
        "per-keystroke re-rank over 10 000 notes; the one-off index fetch is separate" +
        (switcher.skipped.length === 0
          ? ""
          : `. ${switcher.skipped.length} of ${REPEATS.switcher} samples were lost: ` +
            `${switcher.skipped[0] ?? ""}`),
    },
    {
      id: "graph-fps",
      samples: graph.samples,
      reduce: "p95",
      caveat:
        `${graph.nodes} nodes drawn, redrawn on every frame by a wheel event dispatched from ` +
        "an animation-frame loop. Frame *time*, not rate: 30 fps is 33.3 ms. It does not " +
        "include the force layout, which is finished before this starts and runs in a worker",
    },
  ];

  return {
    device: profile.name,
    cpuThrottle: profile.cpuThrottle,
    lost: measurements
      .filter((m) => m.samples.length < MIN_SAMPLES)
      .map(
        (m) =>
          `${m.id}: only ${m.samples.length} of the samples it needs survived (${MIN_SAMPLES} ` +
          `minimum)${m.id === "quick-switcher" && switcher.skipped[0] !== undefined ? ` — ${switcher.skipped[0]}` : ""}`,
      ),
    // Too few samples is dropped, which surfaces in the report as a budget nothing measured
    // — a hole — rather than as a number with no distribution behind it.
    measurements: measurements.filter((m) => m.samples.length >= MIN_SAMPLES),
    observedTransfer: cold.transfer,
    observedCompressed: cold.compressed,
  };
}

/** Opens a browser, signs in once, and measures every profile. */
export async function measureBrowser(
  origin: string,
  profiles: readonly DeviceProfile[] = PROFILES,
): Promise<readonly DeviceRun[]> {
  const browser = await chromium.launch();
  try {
    const storageState = await signedInState(browser, origin);
    const runs: DeviceRun[] = [];
    for (const profile of profiles) {
      runs.push(await measureDevice(browser, profile, origin, storageState));
    }
    return runs;
  } finally {
    await browser.close();
  }
}
