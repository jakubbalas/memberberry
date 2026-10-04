// @vitest-environment jsdom
/**
 * Task-heavy idle scroll and active-gesture overhead, without editor/layout/network work.
 * Run from web: taskset -c 0 nice -n 10 npm exec -- vitest bench --run src/editor/task-tap.bench.ts --maxWorkers=1
 * This host/jsdom comparison is not an Android input-to-paint or 60-fps measurement.
 */
import { afterAll, bench, describe } from "vitest";
import { bindTaskTap } from "./task-tap.js";

const plain = document.createElement("div");
const guarded = document.createElement("div");
const dispose: (() => void)[] = [];
for (let index = 0; index < 500; index += 1) {
  plain.append(document.createElement("button"));
  const control = document.createElement("button");
  guarded.append(control);
  dispose.push(bindTaskTap(control, () => { throw new Error("scroll/cancel activated a task"); }));
}
document.body.append(plain, guarded);
const target = guarded.firstElementChild;
if (target === null) throw new Error("missing control");
const scroll = new Event("scroll");
function pointer(type: string): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 100 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" }, isPrimary: { value: true } });
  return event;
}
const down = pointer("pointerdown");
const cancel = pointer("pointercancel");
const options = { time: 100, warmupTime: 30, iterations: 16 };
afterAll(() => { dispose.forEach((unbind) => unbind()); plain.remove(); guarded.remove(); });

describe("500 task controls / scroll and gesture listener cost", () => {
  bench("baseline scroll with plain native controls", () => { plain.dispatchEvent(scroll); }, options);
  bench("idle scroll with guarded controls (no per-control scroll listeners)", () => { guarded.dispatchEvent(scroll); }, options);
  bench("one active touch start/scroll/cancel among 500 controls", () => {
    target.dispatchEvent(down);
    guarded.dispatchEvent(scroll);
    document.dispatchEvent(cancel);
  }, options);
});
