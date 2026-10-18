import { expect, it, vi } from "vitest";
import { serialRefresh } from "./refresh.js";

it("coalesces a burst but retains a return requested during an in-flight download", async () => {
  let complete: () => void = () => { throw new Error("not started"); };
  const run = vi.fn(async () => { await new Promise<void>(resolve => { complete = resolve; }); });
  const refresh = serialRefresh(run);
  refresh.refresh(); refresh.refresh(); refresh.refresh();
  await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(1);
  refresh.refresh(); refresh.refresh();
  complete();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  expect(run).toHaveBeenCalledTimes(2);
  refresh.destroy(); complete();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  refresh.refresh();
  expect(run).toHaveBeenCalledTimes(2);
});

it("does not start queued downloads after teardown", async () => {
  const run = vi.fn(async () => undefined);
  const refresh = serialRefresh(run);
  refresh.refresh(); refresh.destroy();
  await Promise.resolve();
  expect(run).not.toHaveBeenCalled();
});
