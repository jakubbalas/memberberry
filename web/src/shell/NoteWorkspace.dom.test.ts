// @vitest-environment jsdom

/**
 * The Svelte root component (`SPEC.md` §5.1, decision A1).
 *
 * Mounted with Svelte's own `mount`/`unmount` rather than a testing library: this project
 * needs to open and close a component, and a dependency for that would be the framework for
 * one use case AGENTS.md §4.1 warns about.
 *
 * `openNoteSurface` is injected, so these tests never construct a Tiptap editor or a socket.
 * What is under test is the *lifecycle* — that the component starts the note once, tears it
 * down on unmount, and does not leak an editor when it is closed mid-startup. That last one
 * is a real bug class: a tab closed while IndexedDB is still restoring leaves an editor
 * mounted on a detached element with its socket open, and it only shows up under the fast
 * tab switching that splits and tabs make normal (§8.2).
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import NoteWorkspace from "./NoteWorkspace.svelte";
import type { NoteBootstrap } from "./bootstrap.js";
import type { NoteSurface, OpenNoteSurfaceOptions } from "./note-surface.js";

const BOOTSTRAP: NoteBootstrap = { vault: "personal", note: "Welcome.md", user: "alice" };

/** A recording stand-in for the real editor startup. */
function recorder() {
  const calls: OpenNoteSurfaceOptions[] = [];
  let destroyed = 0;
  let settle: ((surface: NoteSurface) => void) | undefined;

  const open = async (options: OpenNoteSurfaceOptions): Promise<NoteSurface> => {
    calls.push(options);
    const surface: NoteSurface = {
      destroy: async () => {
        destroyed += 1;
      },
    };
    // Resolved on demand, so a test can unmount while startup is still in flight.
    return new Promise<NoteSurface>((resolve) => {
      settle = resolve;
      queueMicrotask(() => {
        if (settle !== undefined) resolve(surface);
      });
    });
  };

  return {
    open,
    get calls() {
      return calls;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

/** Startup that resolves only when the test says so, for the closed-mid-startup case. */
interface PendingOpen {
  readonly open: () => Promise<NoteSurface>;
  /** Finish opening the note. */
  readonly resolve: () => void;
  /** How many times the resulting surface was destroyed. */
  readonly destroyed: () => number;
}

function pending(): PendingOpen {
  let destroyed = 0;
  let release: (() => void) | undefined;
  const open = async (): Promise<NoteSurface> =>
    new Promise<NoteSurface>((resolve) => {
      release = () => {
        resolve({
          destroy: async () => {
            destroyed += 1;
          },
        });
      };
    });
  return {
    open,
    resolve: () => release?.(),
    destroyed: () => destroyed,
  };
}

let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
});

/**
 * Lets promise callbacks run *and* Svelte re-render.
 *
 * why: both halves. `await Promise.resolve()` drains the microtask that resolves the note
 * surface; `tick()` waits for Svelte to apply the resulting state change to the DOM. With
 * only the first, an assertion about rendered markup reads the previous frame — which is how
 * the two error-path tests below first "passed" against the wrong text.
 */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
};

describe("mounting", () => {
  it("renders the note surface, the panel and the status region", () => {
    const stub = recorder();
    const app = mount(NoteWorkspace, { target, props: { bootstrap: BOOTSTRAP, open: stub.open } });
    try {
      expect(target.querySelector("#editor.editor-surface")).not.toBeNull();
      expect(target.querySelector(".editor-panel")?.getAttribute("aria-label")).toBe("Note editor");
      expect(target.querySelector(".offline-status")?.getAttribute("role")).toBe("status");
    } finally {
      unmount(app);
    }
  });

  it("titles the page with the note the server named", () => {
    const stub = recorder();
    const app = mount(NoteWorkspace, { target, props: { bootstrap: BOOTSTRAP, open: stub.open } });
    try {
      expect(target.querySelector("h1")?.textContent).toBe("Welcome.md");
    } finally {
      unmount(app);
    }
  });

  it("falls back to a local title when no server bootstrapped it", () => {
    // The `npm run dev` path: Vite serves `index.html` with the attributes still empty.
    const stub = recorder();
    const app = mount(NoteWorkspace, { target, props: { open: stub.open } });
    try {
      expect(target.querySelector("h1")?.textContent).toBe("Scratch note");
    } finally {
      unmount(app);
    }
  });

  it("opens the note exactly once, into its own elements", async () => {
    const stub = recorder();
    const app = mount(NoteWorkspace, { target, props: { bootstrap: BOOTSTRAP, open: stub.open } });
    try {
      await flush();
      expect(stub.calls).toHaveLength(1);
      const call = stub.calls[0];
      expect(call?.bootstrap).toEqual(BOOTSTRAP);
      expect(call?.surface).toBe(target.querySelector("#editor"));
      expect(call?.panel).toBe(target.querySelector(".editor-panel"));
      expect(call?.status).toBe(target.querySelector(".offline-status"));
    } finally {
      unmount(app);
    }
  });
});

describe("teardown", () => {
  it("destroys the note surface when the component unmounts", async () => {
    const stub = recorder();
    const app = mount(NoteWorkspace, { target, props: { bootstrap: BOOTSTRAP, open: stub.open } });
    await flush();
    expect(stub.destroyed).toBe(0);

    unmount(app);
    expect(stub.destroyed).toBe(1);
  });

  it("destroys a surface that finishes opening after the component is gone", async () => {
    // The leak. Nothing observable happens at unmount time — the editor does not exist yet —
    // so without the guard in the effect this passes silently and leaks in production.
    const late = pending();
    const app = mount(NoteWorkspace, { target, props: { bootstrap: BOOTSTRAP, open: late.open } });
    await flush();

    unmount(app);
    expect(late.destroyed()).toBe(0);

    late.resolve();
    await flush();
    expect(late.destroyed()).toBe(1);
  });
});

describe("when the note cannot be opened", () => {
  it("says so in an alert instead of rendering a silently blank page", async () => {
    const app = mount(NoteWorkspace, {
      target,
      props: {
        bootstrap: BOOTSTRAP,
        open: async () => {
          throw new Error("the sidecar is corrupt");
        },
      },
    });
    try {
      await flush();
      const status = target.querySelector(".offline-status");
      expect(status?.getAttribute("role")).toBe("alert");
      expect(status?.textContent).toContain("the sidecar is corrupt");
    } finally {
      unmount(app);
    }
  });

  it("reports a thrown non-error rather than rendering `undefined`", async () => {
    const app = mount(NoteWorkspace, {
      target,
      props: {
        bootstrap: BOOTSTRAP,
        // A rejected promise may carry anything, and the UI must not render "undefined"
        // if it does. Throwing a string is how that reaches the component.
        open: async () => {
          throw "not an error object";
        },
      },
    });
    try {
      await flush();
      const status = target.querySelector(".offline-status");
      expect(status?.textContent).toContain("could not be opened");
      expect(status?.textContent).not.toContain("undefined");
    } finally {
      unmount(app);
    }
  });
});
