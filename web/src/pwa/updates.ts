/** Asks a waiting build whether it contains all critical assets used by this page. */
export function matchesBuild(worker: ServiceWorker, entry: string | readonly string[]): Promise<boolean | undefined> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (value: boolean | undefined): void => {
      clearTimeout(timer);
      channel.port1.close(); channel.port2.close();
      resolve(value);
    };
    timer = setTimeout(() => finish(undefined), 1500);
    channel.port1.onmessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      finish(typeof data === "object" && data !== null && "current" in data && typeof data.current === "boolean" ? data.current : undefined);
    };
    try { worker.postMessage({ type: "memberberry:build", assets: typeof entry === "string" ? [entry] : entry }, [channel.port2]); }
    catch { finish(undefined); }
  });
}

/** Observes updates and checks on return. It never activates a worker or reloads a page. */
export function watchAppUpdates(options: {
  readonly workers: ServiceWorkerContainer;
  readonly window: Window;
  readonly document: Document;
  readonly entry: string | readonly string[];
  readonly available: (value: boolean) => void;
}): () => void {
  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let checking = false;
  let inspection = 0;
  const observed = new Set<ServiceWorker>();
  const inspect = (): void => {
    if (disposed) return;
    const waiting = registration?.waiting;
    const request = ++inspection;
    if (waiting === undefined || waiting === null || options.workers.controller === null) {
      options.available(false);
      return;
    }
    void matchesBuild(waiting, options.entry).then(current => {
      if (!disposed && request === inspection) options.available(current !== true);
    });
  };
  const found = (): void => {
    const worker = registration?.installing;
    if (worker !== undefined && worker !== null && !observed.has(worker)) {
      observed.add(worker);
      worker.addEventListener("statechange", inspect);
    }
    inspect();
  };
  const check = (): void => {
    if (disposed || checking || registration === undefined || options.document.visibilityState !== "visible") return;
    checking = true;
    void registration.update().catch(() => undefined).finally(() => { checking = false; if (!disposed) { found(); } });
  };
  const focus = (event: Event): void => { if (event.target === options.window) check(); };
  options.window.addEventListener("focus", focus);
  options.window.addEventListener("online", check);
  options.document.addEventListener("visibilitychange", check);
  void options.workers.ready.then(ready => {
    if (disposed) return;
    registration = ready;
    registration.addEventListener("updatefound", found);
    found(); check();
  }).catch(() => undefined);
  return () => {
    disposed = true;
    inspection += 1;
    options.window.removeEventListener("focus", focus);
    options.window.removeEventListener("online", check);
    options.document.removeEventListener("visibilitychange", check);
    registration?.removeEventListener("updatefound", found);
    for (const worker of observed) worker.removeEventListener("statechange", inspect);
  };
}
