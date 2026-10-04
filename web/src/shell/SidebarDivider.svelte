<script lang="ts">
  import { onDestroy } from "svelte";
  import { MIN_SIDEBAR_WIDTH } from "./sidebar-preferences.js";
  interface Props {
    readonly side: "left" | "right";
    readonly label: string;
    readonly width: number;
    readonly maximum: number;
    readonly onresize: (width: number) => void;
  }
  const { side, label, width, maximum, onresize }: Props = $props();
  let drag: { readonly id: number; readonly x: number; readonly width: number; readonly element: HTMLElement } | undefined;
  const direction = $derived(side === "left" ? 1 : -1);
  function resize(value: number): void { onresize(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximum, value))); }
  function down(event: PointerEvent): void {
    if (drag !== undefined || event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag = { id: event.pointerId, x: event.clientX, width, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent): void {
    if (drag?.id === event.pointerId) resize(drag.width + (event.clientX - drag.x) * direction);
  }
  function release(): void {
    const started = drag;
    drag = undefined;
    if (started?.element.hasPointerCapture(started.id)) started.element.releasePointerCapture(started.id);
  }
  function end(event: PointerEvent): void {
    if (drag?.id === event.pointerId) release();
  }
  onDestroy(release);
  function key(event: KeyboardEvent): void {
    let next: number;
    if (event.key === "ArrowLeft") next = width - 16 * direction;
    else if (event.key === "ArrowRight") next = width + 16 * direction;
    else if (event.key === "Home") next = MIN_SIDEBAR_WIDTH;
    else if (event.key === "End") next = maximum;
    else return;
    event.preventDefault();
    resize(next);
  }
</script>

<!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -- ARIA's focusable window-splitter pattern is an interactive separator, unlike a static separator. -->
<button type="button" class="pane-divider sidebar-divider" role="separator" aria-label={`Resize ${label}`} aria-controls={`sidebar-${side}`} aria-orientation="vertical" aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels`} data-direction="vertical" data-side={side} onpointerdown={down} onpointermove={move} onpointerup={end} onpointercancel={end} onlostpointercapture={end} onkeydown={key}></button>
