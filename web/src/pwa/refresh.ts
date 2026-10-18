/** Coalesces background work while retaining one follow-up requested during an active run. */
export function serialRefresh(run: () => Promise<void>): { refresh(): void; destroy(): void } {
  let running = false;
  let requested = false;
  let disposed = false;
  const refresh = (): void => {
    if (disposed) return;
    requested = true;
    if (running) return;
    running = true;
    void Promise.resolve().then(async () => {
      while (requested && !disposed) {
        requested = false;
        try { await run(); } catch { /* unavailable offline storage/network is retried on return */ }
      }
    }).finally(() => { running = false; if (requested && !disposed) refresh(); });
  };
  return { refresh, destroy: () => { disposed = true; requested = false; } };
}
