/**
 * Layout mode and split limits (`SPEC.md` §8.2, §8.3).
 *
 * The breakpoints live in one module so the components and the media queries in `app.css`
 * cannot disagree about them. These tests pin the boundaries themselves, which is where a
 * "≥ 1024" written as "> 1024" hides.
 */

import { describe, expect, it } from "vitest";

import {
  DESKTOP_MIN_WIDTH,
  DESKTOP_QUERY,
  type LayoutMode,
  MOBILE_MAX_WIDTH,
  MOBILE_QUERY,
  type MediaMatcher,
  TABLET_MIN_WIDTH,
  currentLayoutMode,
  layoutModeForWidth,
  splitLimitFor,
  watchLayoutMode,
} from "./layout.js";

describe("the breakpoints", () => {
  it.each([
    [320, "mobile"],
    [767, "mobile"],
    [MOBILE_MAX_WIDTH, "mobile"],
    [TABLET_MIN_WIDTH, "tablet"],
    [1023, "tablet"],
    [DESKTOP_MIN_WIDTH, "desktop"],
    [1920, "desktop"],
  ])("put %ipx in the %s layout", (width, mode) => {
    expect(layoutModeForWidth(width)).toBe(mode);
  });

  it("place the boundaries exactly where §8 says", () => {
    // The off-by-one that matters: §8.2 is "≥ 1024px" and §8.3 is "< 768px", so 768 is a
    // tablet and 1024 is a desktop. Written as `>` or `<=` either one shifts a whole class
    // of device into the wrong layout.
    expect(layoutModeForWidth(767.99)).toBe("mobile");
    expect(layoutModeForWidth(768)).toBe("tablet");
    expect(layoutModeForWidth(1023.99)).toBe("tablet");
    expect(layoutModeForWidth(1024)).toBe("desktop");
  });
});

describe("split limits", () => {
  it("give the tablet at most one split, as §8.3 requires", () => {
    expect(splitLimitFor("tablet")).toBe(1);
  });

  it("give mobile none, because it renders a single leaf", () => {
    // A split on mobile is invisible, and an invisible pane still holds an editor, a Y.Doc
    // and a socket — a memory cost with nothing to show for it.
    expect(splitLimitFor("mobile")).toBe(0);
  });

  it("leave the desktop unlimited", () => {
    expect(splitLimitFor("desktop")).toBe(Number.POSITIVE_INFINITY);
  });
});

/** A controllable `MediaQueryList`. */
function matcher(matches: boolean) {
  const listeners = new Set<() => void>();
  const list: MediaMatcher = {
    matches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  return {
    list,
    set(value: boolean) {
      list.matches = value;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}

describe("reading the layout mode synchronously", () => {
  // The bug this exists for: a component seeding state from the *watcher* starts on the
  // default, because a Svelte effect runs after mount. On a phone that opened both sidebars
  // over the note, and every mobile E2E test then failed to click anything.
  it.each([
    [{ mobile: true, desktop: false }, "mobile"],
    [{ mobile: false, desktop: false }, "tablet"],
    [{ mobile: false, desktop: true }, "desktop"],
  ])("reports %o as %s without waiting for a change event", (state, expected) => {
    const mode = currentLayoutMode((query) =>
      matcher(query === MOBILE_QUERY ? state.mobile : state.desktop).list,
    );
    expect(mode).toBe(expected);
  });

  it("falls back to desktop with no matchMedia, matching the watcher", () => {
    expect(currentLayoutMode(undefined)).toBe("desktop");
  });
});

describe("watching the layout mode", () => {
  function watcher(initial: { mobile: boolean; desktop: boolean }) {
    const mobile = matcher(initial.mobile);
    const desktop = matcher(initial.desktop);
    const seen: LayoutMode[] = [];
    const stop = watchLayoutMode({
      match: (query) => (query === MOBILE_QUERY ? mobile.list : desktop.list),
      onChange: (mode) => seen.push(mode),
    });
    return { mobile, desktop, seen, stop };
  }

  it("reports the current mode immediately", () => {
    const { seen, stop } = watcher({ mobile: true, desktop: false });
    expect(seen).toEqual(["mobile"]);
    stop();
  });

  it("reports again when the viewport crosses a breakpoint", () => {
    // Rotating a phone or dragging a window edge, both of which have to move the layout
    // without a reload.
    const { mobile, desktop, seen, stop } = watcher({ mobile: false, desktop: true });
    expect(seen).toEqual(["desktop"]);

    desktop.set(false);
    expect(seen.at(-1)).toBe("tablet");

    mobile.set(true);
    expect(seen.at(-1)).toBe("mobile");
    stop();
  });

  it("releases both listeners when stopped", () => {
    // Every subscription has a matching teardown, and a test that proves it (AGENTS.md §4.3).
    const { mobile, desktop, stop } = watcher({ mobile: true, desktop: false });
    expect(mobile.listenerCount).toBe(1);
    expect(desktop.listenerCount).toBe(1);

    stop();
    expect(mobile.listenerCount).toBe(0);
    expect(desktop.listenerCount).toBe(0);
  });

  it("falls back to desktop where there is no matchMedia at all", () => {
    // Desktop is the safe default: it renders the whole tree, so nothing is hidden. Guessing
    // mobile would silently drop panes for anyone whose environment lacks the API.
    const seen: LayoutMode[] = [];
    const stop = watchLayoutMode({
      match: undefined as unknown as (query: string) => MediaMatcher,
      onChange: (mode) => seen.push(mode),
    });
    expect(seen).toEqual(["desktop"]);
    stop();
  });

  it("uses queries that say the same thing as the constants", () => {
    // `app.css` repeats these numbers in its own media queries; if they drift, the CSS and
    // the component disagree about which layout is showing.
    expect(MOBILE_QUERY).toContain(String(MOBILE_MAX_WIDTH));
    expect(DESKTOP_QUERY).toContain(String(DESKTOP_MIN_WIDTH));
    // And the query boundary must sit just under the logical one, not on it.
    expect(MOBILE_MAX_WIDTH).toBeLessThan(TABLET_MIN_WIDTH);
    expect(layoutModeForWidth(MOBILE_MAX_WIDTH)).toBe("mobile");
  });
});
