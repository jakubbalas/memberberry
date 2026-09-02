/**
 * Bringing up a workspace for a session (`SPEC.md` §8.1, §8.2).
 *
 * The order matters and is the whole reason this is a module rather than a few lines in the
 * component: the stored layout has to be fetched *before* the store exists, because a store
 * built on an empty workspace and then replaced would mount every pane twice — once empty,
 * once restored — and each mount is an editor and a socket.
 */

import { WorkspaceStore, sessionIds } from "./workspace-store.svelte.js";
import { type WorkspaceTransport, createWorkspaceTransport, deviceId } from "./workspace-sync.js";
import { createWorkspace } from "./workspace.js";

export interface StartWorkspaceOptions {
  readonly vault: string;
  /** Opened if the restored layout has nothing in it — the note the server served. */
  readonly note?: string | undefined;
  /** Injectable for tests; defaults to `localStorage`. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
  /** Injectable for tests; defaults to the real HTTP transport. */
  readonly transport?: WorkspaceTransport | undefined;
}

export interface StartedWorkspace {
  readonly store: WorkspaceStore;
  readonly transport: WorkspaceTransport;
  /** Writes any pending layout and stops saving. */
  destroy(): Promise<void>;
}

/**
 * Restores the workspace for this vault and device, or starts a fresh one.
 *
 * A layout that fails to load is not an error worth showing anyone: `parseWorkspace` has
 * already turned it into an empty workspace, and the note the server served is opened into
 * it, so the user gets a working page rather than a message about a file they did not know
 * existed.
 */
export async function startWorkspace(
  options: StartWorkspaceOptions,
): Promise<StartedWorkspace> {
  const ids = sessionIds();
  const storage = options.storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const transport =
    options.transport ??
    createWorkspaceTransport({
      vault: options.vault,
      device: storage === undefined ? "ephemeral" : deviceId(storage),
      ids,
    });

  const loaded = await transport.load();
  const store = new WorkspaceStore({
    initial: loaded.ok ? loaded.workspace : createWorkspace(options.vault, ids),
    ids,
    persistence: transport,
  });

  // Opening after construction rather than folding it into the initial workspace, so the
  // note is persisted like any other open — and so `reuse` applies: a restored layout that
  // already has this note focuses that tab instead of opening a second one.
  if (options.note !== undefined) store.open(options.note);

  return {
    store,
    transport,
    destroy: async (): Promise<void> => {
      // Flush before destroy: `destroy` cancels the pending write, and the last thing the
      // user did is exactly the thing most worth keeping. `final` because this runs from
      // `pagehide`, where an ordinary fetch is aborted as the document goes away.
      await transport.flush({ final: true });
      transport.destroy();
    },
  };
}
