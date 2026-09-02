/**
 * Presence idle behaviour (`SPEC.md` §7.5).
 *
 * Kept as plain logic over a Map with an injected clock, rather than a pile of
 * `setTimeout`s attached to DOM nodes: cursors appear and disappear constantly, and per-node
 * timers leak whenever a decoration is rebuilt. One tick reads the state of every client.
 */

import type { Awareness } from "y-protocols/awareness";

/** How long a client may be still before its name label and then its caret fade. */
export interface IdleTimings {
  readonly labelAfterMs: number;
  readonly cursorAfterMs: number;
}

/** §7.5: labels fade after ~3s of stillness, a caret idle for 60s fades. */
export const DEFAULT_IDLE_TIMINGS: IdleTimings = {
  labelAfterMs: 3_000,
  cursorAfterMs: 60_000,
};

/** How visible a remote participant should be right now. */
export type PresenceState = "active" | "label-idle" | "stale";

export interface PresenceActivity {
  /** Records that a client just moved. */
  touch(client: number, at: number): void;
  /** Drops a client that has left, so it cannot linger as stale forever. */
  forget(client: number): void;
  /** Replaces the tracked set, forgetting anyone absent from it. */
  retain(clients: Iterable<number>, at: number): void;
  /** The visibility a client should have at `at`. */
  state(client: number, at: number): PresenceState;
}

/**
 * Tracks when each remote client last moved.
 *
 * A client never seen before counts as active at the moment it is first observed, so a
 * cursor that appears mid-session shows its label rather than arriving pre-faded.
 */
export function createPresenceActivity(timings: IdleTimings = DEFAULT_IDLE_TIMINGS): PresenceActivity {
  const lastSeen = new Map<number, number>();
  return {
    touch(client: number, at: number): void {
      lastSeen.set(client, at);
    },
    forget(client: number): void {
      lastSeen.delete(client);
    },
    retain(clients: Iterable<number>, at: number): void {
      const keep = new Set(clients);
      for (const client of [...lastSeen.keys()]) {
        if (!keep.has(client)) lastSeen.delete(client);
      }
      for (const client of keep) {
        if (!lastSeen.has(client)) lastSeen.set(client, at);
      }
    },
    state(client: number, at: number): PresenceState {
      const seen = lastSeen.get(client);
      if (seen === undefined) return "stale";
      const still = at - seen;
      if (still >= timings.cursorAfterMs) return "stale";
      if (still >= timings.labelAfterMs) return "label-idle";
      return "active";
    },
  };
}

/** The attribute a remote caret carries so a tick can find it without a per-node timer. */
export const PRESENCE_CLIENT_ATTRIBUTE = "data-presence-client";

/**
 * Builds the caret decoration `y-prosemirror` renders for a remote user.
 *
 * The default builder emits no client id, which leaves no way to age one caret without
 * re-rendering all of them. Colours come from the user's awareness state, which the
 * transport has already overwritten with the server's answer — never the client's claim.
 */
export function presenceCursorBuilder(user: unknown, clientId: number): HTMLElement {
  const { name, color } = readUser(user);
  const caret = document.createElement("span");
  caret.className = "ProseMirror-yjs-cursor is-active";
  caret.setAttribute(PRESENCE_CLIENT_ATTRIBUTE, String(clientId));
  caret.style.setProperty("border-color", color);
  const label = document.createElement("div");
  label.style.setProperty("background-color", color);
  label.textContent = name;
  caret.append(label);
  return caret;
}

/** Applies `is-active` / `is-stale` to every caret and avatar under `root`. */
export function paintPresence(root: ParentNode, activity: PresenceActivity, at: number): void {
  for (const element of root.querySelectorAll(`[${PRESENCE_CLIENT_ATTRIBUTE}]`)) {
    const client = Number(element.getAttribute(PRESENCE_CLIENT_ATTRIBUTE));
    const state = Number.isFinite(client) ? activity.state(client, at) : "stale";
    element.classList.toggle("is-active", state === "active");
    element.classList.toggle("is-stale", state === "stale");
    element.classList.toggle("is-idle", state !== "active");
  }
}

export interface PresenceIdleOptions {
  readonly awareness: Awareness;
  readonly root: ParentNode;
  readonly timings?: IdleTimings;
  /** Injectable for tests; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Injectable for tests; defaults to `window.setInterval`. */
  readonly schedule?: (tick: () => void, everyMs: number) => () => void;
}

export interface PresenceIdleHandle {
  /** Exposed so a host can ask about a client without reaching into the DOM. */
  readonly activity: PresenceActivity;
  destroy(): void;
}

/** How often idle state is re-evaluated. Coarse: a fade is not a keystroke. */
const TICK_MS = 500;

/**
 * Ages remote presence over time, repainting only class names.
 *
 * Nothing here touches the document — §7.5 requires presence to render as decorations, and
 * a re-render on every fade would put presence squarely on the keystroke budget (§21).
 */
export function trackPresenceIdle(options: PresenceIdleOptions): PresenceIdleHandle {
  const clock = options.clock ?? (() => Date.now());
  const activity = createPresenceActivity(options.timings);
  const remote = (): number[] =>
    [...options.awareness.getStates().keys()].filter((client) => client !== options.awareness.clientID);

  activity.retain(remote(), clock());
  const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const at = clock();
    for (const client of [...added, ...updated]) {
      if (client !== options.awareness.clientID) activity.touch(client, at);
    }
    for (const client of removed) activity.forget(client);
    paintPresence(options.root, activity, at);
  };
  options.awareness.on("change", onChange);

  const schedule = options.schedule ?? defaultSchedule;
  const stop = schedule(() => paintPresence(options.root, activity, clock()), TICK_MS);
  paintPresence(options.root, activity, clock());

  return {
    activity,
    destroy: (): void => {
      options.awareness.off("change", onChange);
      stop();
    },
  };
}

function defaultSchedule(tick: () => void, everyMs: number): () => void {
  const handle = setInterval(tick, everyMs);
  return () => clearInterval(handle);
}

function readUser(value: unknown): { name: string; color: string } {
  if (typeof value === "object" && value !== null) {
    const user = value as { name?: unknown; color?: unknown };
    return {
      name: typeof user.name === "string" ? user.name : "Someone",
      color: typeof user.color === "string" ? user.color : "var(--presence-2)",
    };
  }
  return { name: "Someone", color: "var(--presence-2)" };
}
