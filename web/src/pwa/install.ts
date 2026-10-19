/** The browser owns installation; retain its prompt only until a user invokes it. */
interface InstallEvent extends Event {
  prompt(): Promise<unknown>;
}

/** Watches native installation availability and releases every listener on teardown. */
export function watchInstallation(target: EventTarget, standalone: boolean, available: (value: boolean) => void): {
  install(): Promise<void>;
  destroy(): void;
} {
  let prompt: InstallEvent | undefined;
  let disposed = false;
  const beforeInstall = (event: Event): void => {
    if (standalone || !("prompt" in event) || typeof event.prompt !== "function") return;
    event.preventDefault();
    prompt = event as InstallEvent;
    available(true);
  };
  const installed = (): void => { prompt = undefined; available(false); };
  target.addEventListener("beforeinstallprompt", beforeInstall);
  target.addEventListener("appinstalled", installed);
  return {
    install: async (): Promise<void> => {
      const pending = prompt;
      prompt = undefined;
      available(false);
      try { await pending?.prompt(); } catch { /* the native menu remains available */ }
      if (!disposed) available(false);
    },
    destroy: (): void => {
      disposed = true;
      prompt = undefined;
      target.removeEventListener("beforeinstallprompt", beforeInstall);
      target.removeEventListener("appinstalled", installed);
    },
  };
}
