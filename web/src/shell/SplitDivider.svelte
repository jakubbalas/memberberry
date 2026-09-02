<!--
  The draggable boundary between two panes (`SPEC.md` §8.2).

  It is a `separator` with a tabindex, not a `div` with a pointer handler, because §8.4 says
  no mouse-only feature ships. Arrow keys move it, Home/End send it to the usable extremes,
  and a screen reader is told the orientation and the current position — a drag handle with
  none of that is a feature only some people have.
-->
<script lang="ts">
  import type { SplitNode } from "./workspace.js";
  import { MIN_RATIO } from "./workspace.js";

  interface Props {
    readonly split: SplitNode;
    /** The element the ratio is measured against — the split's own box. */
    readonly container: HTMLElement | undefined;
    readonly onresize: (ratio: number) => void;
  }

  const { split, container, onresize }: Props = $props();

  /** One arrow press. Coarse enough to be useful, fine enough to land on a value you want. */
  const KEYBOARD_STEP = 0.02;

  const vertical = $derived(split.direction === "vertical");
  const percent = $derived(Math.round(split.ratio * 100));

  /** Turns a pointer position into a ratio of the container, clamped by the model. */
  function ratioAt(clientX: number, clientY: number): number | undefined {
    if (container === undefined) return undefined;
    const box = container.getBoundingClientRect();
    const span = vertical ? box.width : box.height;
    if (span <= 0) return undefined;
    const offset = vertical ? clientX - box.left : clientY - box.top;
    return offset / span;
  }

  function onpointerdown(event: PointerEvent): void {
    // why: pointer capture rather than window listeners. The pointer leaves this 6px element
    // on the first frame of any real drag, and capture is what keeps the events coming
    // without a global handler that has to be torn down correctly.
    event.preventDefault();
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    handle.setPointerCapture(event.pointerId);
  }

  function onpointermove(event: PointerEvent): void {
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement) || !handle.hasPointerCapture(event.pointerId)) return;
    const ratio = ratioAt(event.clientX, event.clientY);
    if (ratio !== undefined) onresize(ratio);
  }

  function onpointerup(event: PointerEvent): void {
    const handle = event.currentTarget;
    if (handle instanceof HTMLElement && handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forward = vertical ? "ArrowRight" : "ArrowDown";
    const moves: Record<string, number | undefined> = {
      [back]: split.ratio - KEYBOARD_STEP,
      [forward]: split.ratio + KEYBOARD_STEP,
      Home: MIN_RATIO,
      End: 1 - MIN_RATIO,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    onresize(next);
  }
</script>

<!--
  A `button` carrying `role="separator"`, not a `div`.

  The ARIA window-splitter pattern needs something focusable that reports `aria-valuenow`
  and responds to arrow keys. Building that on a `div` means a `tabindex`, keyboard handlers
  and two suppressed accessibility warnings; a button is focusable and keyboard-reachable
  already, and the role tells assistive technology what it actually is. Suppressing the
  warnings would have been the wrong fix to the right complaint.
-->
<!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -- the rule models
     `separator` as always non-interactive. ARIA defines two kinds: a static one, and the
     focusable "window splitter" that takes `aria-valuenow` and arrow keys, which is this.
     There is no element that satisfies both the rule and the pattern, and the pattern is
     what §8.4 requires — a resize handle only a mouse can reach does not ship. -->
<button
  type="button"
  class="pane-divider"
  role="separator"
  aria-orientation={vertical ? "vertical" : "horizontal"}
  aria-label="Resize panes"
  aria-valuenow={percent}
  aria-valuemin={Math.round(MIN_RATIO * 100)}
  aria-valuemax={Math.round((1 - MIN_RATIO) * 100)}
  data-direction={split.direction}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  {onkeydown}
></button>
