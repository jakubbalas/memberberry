/**
 * Loading and saving the workspace layout against the server (`SPEC.md` §8.1, E15).
 *
 * The layout changes on every tab open, close, drag and pane resize — which is to say
 * constantly, and often several times per gesture. So writes are **debounced and coalesced**:
 * one request per quiet period, carrying the latest state rather than a queue of every
 * intermediate one. A layout is not content; losing the last 400ms of pane arrangement to a
 * closed laptop costs nothing, and §21.3 keeps work off the interaction path.
 *
 * Nothing here trusts the server's answer. `parseWorkspace` validates the loaded layout
 * against the same invariants the local operations maintain, and rejects it into a fresh
 * workspace rather than throwing (`AGENTS.md` §4.3 — the client does not trust the server
 * any more than the server trusts the client).
 */

import { type Workspace, type WorkspaceIds } from "./workspace.js";
import { type WorkspaceLoad, parseWorkspace, serializeWorkspace } from "./workspace-storage.js";

/**
 * How long the layout must stop changing before it is written.
 *
 * why: 500ms. Long enough that dragging a split emits one request rather than one per
 * frame, short enough that closing the tab straight after a change usually catches it —
 * and `flush` covers the case where it does not.
 */
export const SAVE_DEBOUNCE_MS = 500;

/** This device's stable identifier, as the server's `DeviceId` will accept it. */
export type DeviceId = string;

/** How this module reaches the network and the clock. Injected so tests need neither. */
export interface WorkspaceTransportOptions {
  readonly vault: string;
  readonly device: DeviceId;
  readonly ids: WorkspaceIds;
  /** Defaults to `globalThis.fetch`, bound so it can be replaced wholesale in a test. */
  readonly fetch?: typeof globalThis.fetch;
  readonly debounceMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => number;
  readonly clearTimer?: (handle: number) => void;
  /** Called when a save fails, so a shell can show that the layout is not being kept. */
  readonly onSaveError?: (error: unknown) => void;
}

export interface WorkspaceTransport {
  /** The stored layout, or a fresh workspace when there is none or it is unusable. */
  load(): Promise<WorkspaceLoad>;
  /** Records a new layout to be written after the debounce settles. */
  save(workspace: Workspace): void;
  /** Writes any pending layout immediately. Resolves when the request has completed. */
  flush(): Promise<void>;
  /** Cancels any pending write and releases the timer. */
  destroy(): void;
}

/** The endpoint for one vault and device. */
export function workspaceUrl(vault: string, device: DeviceId): string {
  return `/api/v1/vaults/${encodeURIComponent(vault)}/workspace/${encodeURIComponent(device)}`;
}

/**
 * A stable per-device id, created once and kept in `localStorage`.
 *
 * §8.1 keys the layout by device because a phone and a 32" monitor legitimately differ, so
 * this value has to survive a reload but must *not* travel between devices. It is not an
 * identifier of the person — the server keys the file by the authenticated user (E15) and
 * ignores any claim about identity made here.
 */
export const DEVICE_ID_KEY = "memberberry.device";

export function deviceId(store: Pick<Storage, "getItem" | "setItem">): DeviceId {
  const existing = store.getItem(DEVICE_ID_KEY);
  if (existing !== null && /^[A-Za-z0-9_-]{1,64}$/.test(existing)) return existing;
  // why: regenerated rather than repaired if it is malformed. The server refuses a device id
  // outside that character class, so a corrupted one means no layout is ever saved again —
  // silently, because a failed save is not something the user asked for.
  const fresh = randomDeviceId();
  store.setItem(DEVICE_ID_KEY, fresh);
  return fresh;
}

function randomDeviceId(): DeviceId {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createWorkspaceTransport(
  options: WorkspaceTransportOptions,
): WorkspaceTransport {
  const url = workspaceUrl(options.vault, options.device);
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle) => { globalThis.clearTimeout(handle); });

  let timer: number | undefined;
  let pending: Workspace | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let destroyed = false;

  const write = async (workspace: Workspace): Promise<void> => {
    try {
      const response = await request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: serializeWorkspace(workspace),
      });
      if (!response.ok) {
        throw new Error(`the server refused the layout: ${response.status}`);
      }
    } catch (error) {
      // A failed save is not worth interrupting anyone over — the layout is still correct in
      // memory, and the next change tries again. It is reported so a shell can say so.
      options.onSaveError?.(error);
    }
  };

  const drain = (): void => {
    timer = undefined;
    const workspace = pending;
    pending = undefined;
    if (workspace === undefined) return;
    // Chained rather than raced, so two saves can never land out of order and leave the
    // server holding the older layout.
    inFlight = inFlight.then(() => write(workspace));
  };

  return {
    load: async (): Promise<WorkspaceLoad> => {
      const fresh = (reason: string): WorkspaceLoad => ({
        ok: false,
        workspace: parseWorkspace("", options.vault, options.ids).workspace,
        rejection: { reason },
      });
      try {
        const response = await request(url, { headers: { accept: "application/json" } });
        // 404 is the normal "this device has never saved one", and also every denial (E15).
        if (!response.ok) return fresh(`the server has no layout for this device`);
        return parseWorkspace(await response.text(), options.vault, options.ids);
      } catch (error) {
        return fresh(error instanceof Error ? error.message : "the layout could not be fetched");
      }
    },

    save: (workspace: Workspace): void => {
      if (destroyed) return;
      pending = workspace;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(drain, debounceMs);
    },

    flush: async (): Promise<void> => {
      if (timer !== undefined) {
        clearTimer(timer);
        drain();
      }
      await inFlight;
    },

    destroy: (): void => {
      destroyed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
