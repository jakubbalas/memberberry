// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Doc } from "yjs";
import { Awareness } from "y-protocols/awareness";

import {
  DEFAULT_IDLE_TIMINGS,
  PRESENCE_CLIENT_ATTRIBUTE,
  createPresenceActivity,
  paintPresence,
  presenceCursorBuilder,
  trackPresenceIdle,
} from "./presence.js";

const TIMINGS = { labelAfterMs: 3_000, cursorAfterMs: 60_000 };

describe("createPresenceActivity", () => {
  it("treats a client that just moved as active", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(7, 1_000);

    expect(activity.state(7, 1_000)).toBe("active");
    expect(activity.state(7, 2_999)).toBe("active");
  });

  it("fades the label after three seconds of stillness", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(7, 0);

    expect(activity.state(7, 3_000)).toBe("label-idle");
    expect(activity.state(7, 59_999)).toBe("label-idle");
  });

  it("fades the caret after sixty seconds of stillness", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(7, 0);

    expect(activity.state(7, 60_000)).toBe("stale");
  });

  it("brings a label back the moment the client moves again", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(7, 0);
    expect(activity.state(7, 10_000)).toBe("label-idle");

    activity.touch(7, 10_000);

    expect(activity.state(7, 10_000)).toBe("active");
  });

  it("treats an unknown client as stale rather than active", () => {
    // Fail quiet: a caret with no recorded activity is more likely a leftover decoration
    // than a live participant, and showing it at full strength would be a lie.
    expect(createPresenceActivity(TIMINGS).state(99, 0)).toBe("stale");
  });

  it("forgets a client that left", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(7, 0);

    activity.forget(7);

    expect(activity.state(7, 0)).toBe("stale");
  });

  it("adopts newly present clients as active and drops absent ones", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(1, 0);

    activity.retain([2, 3], 500);

    expect(activity.state(1, 500)).toBe("stale");
    expect(activity.state(2, 500)).toBe("active");
    expect(activity.state(3, 500)).toBe("active");
  });

  it("does not reset an already-tracked client when retaining", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(1, 0);

    activity.retain([1], 4_000);

    expect(activity.state(1, 4_000)).toBe("label-idle");
  });

  it("ships the timings SPEC 7.5 asks for", () => {
    expect(DEFAULT_IDLE_TIMINGS).toEqual({ labelAfterMs: 3_000, cursorAfterMs: 60_000 });
  });
});

describe("presenceCursorBuilder", () => {
  it("tags the caret with its client so it can be aged individually", () => {
    const caret = presenceCursorBuilder({ name: "bob", color: "var(--presence-1)" }, 42);

    expect(caret.getAttribute(PRESENCE_CLIENT_ATTRIBUTE)).toBe("42");
    expect(caret.className).toContain("ProseMirror-yjs-cursor");
    expect(caret.textContent).toBe("bob");
    expect(caret.style.getPropertyValue("border-color")).toBe("var(--presence-1)");
  });

  it("renders a name as text rather than markup", () => {
    // A display name reaches here from another user's awareness state. Building the label
    // with textContent means a name containing markup stays a name.
    const caret = presenceCursorBuilder({ name: "<img src=x onerror=alert(1)>", color: "red" }, 1);

    expect(caret.querySelector("img")).toBeNull();
    expect(caret.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it.each([
    ["a missing user", undefined],
    ["a null user", null],
    ["a user with no name", { color: "red" }],
    ["a user whose name is not a string", { name: 7, color: "red" }],
  ])("falls back to a neutral label for %s", (_label, user) => {
    const caret = presenceCursorBuilder(user, 3);

    expect(caret.textContent).toBe("Someone");
    expect(caret.getAttribute(PRESENCE_CLIENT_ATTRIBUTE)).toBe("3");
  });
});

describe("paintPresence", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = `
      <span ${PRESENCE_CLIENT_ATTRIBUTE}="1"></span>
      <span ${PRESENCE_CLIENT_ATTRIBUTE}="2"></span>
      <span class="not-presence"></span>
    `;
  });

  it("marks active, idle and stale clients differently", () => {
    const activity = createPresenceActivity(TIMINGS);
    activity.touch(1, 100_000);
    activity.touch(2, 0);

    paintPresence(root, activity, 100_000);

    const [first, second] = [...root.querySelectorAll(`[${PRESENCE_CLIENT_ATTRIBUTE}]`)];
    expect(first?.classList.contains("is-active")).toBe(true);
    expect(first?.classList.contains("is-idle")).toBe(false);
    expect(second?.classList.contains("is-stale")).toBe(true);
    expect(second?.classList.contains("is-active")).toBe(false);
  });

  it("leaves elements that are not presence decorations alone", () => {
    paintPresence(root, createPresenceActivity(TIMINGS), 0);

    expect(root.querySelector(".not-presence")?.className).toBe("not-presence");
  });
});

describe("trackPresenceIdle", () => {
  function fixture() {
    const document_ = new Doc();
    const awareness = new Awareness(document_);
    const root = document.createElement("div");
    let now = 0;
    let tick: (() => void) | undefined;
    let stopped = 0;
    const handle = trackPresenceIdle({
      awareness,
      root,
      timings: TIMINGS,
      clock: () => now,
      schedule: (run) => {
        tick = run;
        return () => {
          stopped += 1;
        };
      },
    });
    const caret = document.createElement("span");
    return {
      awareness,
      root,
      handle,
      caret,
      advance: (ms: number) => {
        now += ms;
      },
      run: () => tick?.(),
      stopped: () => stopped,
      /** Mirrors a remote client into awareness the way a server broadcast would. */
      arrive: (client: number) => {
        caret.setAttribute(PRESENCE_CLIENT_ATTRIBUTE, String(client));
        root.append(caret);
        awareness.states.set(client, { user: { name: "bob", color: "var(--presence-1)" } });
        awareness.emit("change", [{ added: [client], updated: [], removed: [] }, "remote"]);
      },
    };
  }

  it("ages a caret from active through label-idle to stale", () => {
    const world = fixture();
    world.arrive(5);
    expect(world.caret.classList.contains("is-active")).toBe(true);

    world.advance(3_000);
    world.run();
    expect(world.caret.classList.contains("is-active")).toBe(false);
    expect(world.caret.classList.contains("is-stale")).toBe(false);

    world.advance(57_000);
    world.run();
    expect(world.caret.classList.contains("is-stale")).toBe(true);

    world.handle.destroy();
  });

  it("revives a caret when its client moves again", () => {
    const world = fixture();
    world.arrive(5);
    world.advance(10_000);
    world.run();
    expect(world.caret.classList.contains("is-active")).toBe(false);

    world.awareness.emit("change", [{ added: [], updated: [5], removed: [] }, "remote"]);

    expect(world.caret.classList.contains("is-active")).toBe(true);
    world.handle.destroy();
  });

  it("never ages the local client, which has no remote caret", () => {
    const world = fixture();
    world.awareness.setLocalStateField("user", { name: "me", color: "var(--presence-0)" });
    world.advance(120_000);

    world.run();

    expect(world.handle.activity.state(world.awareness.clientID, 120_000)).toBe("stale");
    world.handle.destroy();
  });

  it("stops its ticker and listener on destroy", () => {
    const world = fixture();
    world.arrive(5);

    world.handle.destroy();
    world.advance(120_000);
    world.awareness.emit("change", [{ added: [], updated: [5], removed: [] }, "remote"]);

    expect(world.stopped()).toBe(1);
    // The class the caret had when the tracker stopped, not one applied afterwards.
    expect(world.caret.classList.contains("is-stale")).toBe(false);
  });

  it("defaults to a real clock and interval when none is injected", () => {
    vi.useFakeTimers();
    try {
      const document_ = new Doc();
      const awareness = new Awareness(document_);
      const root = document.createElement("div");
      // Awareness runs its own staleness interval, so compare against the baseline rather
      // than zero — otherwise this asserts y-protocols' behaviour instead of ours.
      const baseline = vi.getTimerCount();
      const handle = trackPresenceIdle({ awareness, root });
      expect(vi.getTimerCount()).toBe(baseline + 1);

      vi.advanceTimersByTime(2_000);
      handle.destroy();

      expect(vi.getTimerCount()).toBe(baseline);
      awareness.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
