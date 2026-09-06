/// <reference lib="webworker" />
/**
 * The layout worker (`SPEC.md` §9.4, §21.3).
 *
 * An entry shim, and nothing else: it exists so that a three-hundred-tick simulation over ten
 * thousand nodes runs **without the main thread stopping to paint**, which is §21.3's rule and
 * the difference between a graph that draws while you watch and a tab that goes white. What it
 * drives is `graph-layout-run.ts`, which is where everything testable lives — this file is
 * excluded from the coverage floors for the same reason `src/main.ts` is.
 */

import { type LayoutFrame, type LayoutMessage, startLayout } from "./graph-layout-run.js";

// why: the guard is `DedicatedWorkerGlobalScope` rather than a `self.postMessage` check. A
// window has a `self` with a `postMessage` too, so a looser test would install this listener
// on the page whenever anything imported this module for its types.
if (
  typeof DedicatedWorkerGlobalScope !== "undefined" &&
  self instanceof DedicatedWorkerGlobalScope
) {
  const scope: DedicatedWorkerGlobalScope = self;
  let cancel: (() => void) | undefined;
  scope.addEventListener("message", (event: MessageEvent<LayoutMessage>) => {
    cancel?.();
    cancel = undefined;
    const message = event.data;
    if (message.kind !== "layout") return;
    cancel = startLayout(
      message,
      (frame: LayoutFrame, transfer: ArrayBuffer[]) => {
        scope.postMessage(frame, transfer);
      },
      (step) => {
        setTimeout(step, 0);
      },
      () => performance.now(),
    );
  });
}
