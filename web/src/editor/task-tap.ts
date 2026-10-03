/** Native task controls must distinguish an intentional tap from a cancelled scroll. */
const TAP_SLOP = 10;

/**
 * Binds click activation without taking over native touch scrolling or keyboard activation.
 * Document listeners exist only while a touch/pen is down and are removed on release/cancel
 * or teardown. The returned disposer also removes the control's own listeners.
 */
export function bindTaskTap(control: HTMLElement, activate: () => void): () => void {
  const document = control.ownerDocument;
  let pointer: { readonly id: number; readonly x: number; readonly y: number } | undefined;
  let blocked = false;

  const detach = (): void => {
    if (pointer === undefined) return;
    pointer = undefined;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("pointerdown", additionalPointer, true);
    document.removeEventListener("scroll", scroll, true);
  };
  const move = (event: PointerEvent): void => {
    if (pointer === undefined || event.pointerId !== pointer.id) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > TAP_SLOP) blocked = true;
  };
  const up = (event: PointerEvent): void => {
    if (pointer === undefined || event.pointerId !== pointer.id) return;
    move(event);
    detach();
  };
  const cancel = (event: PointerEvent): void => {
    if (pointer === undefined || event.pointerId !== pointer.id) return;
    blocked = true;
    detach();
  };
  const additionalPointer = (event: PointerEvent): void => {
    if (pointer !== undefined && event.pointerId !== pointer.id) blocked = true;
  };
  const scroll = (event: Event): void => {
    // why: another pane scrolling is not evidence this control's tap became a scroll.
    if (event.target instanceof Node && event.target.contains(control)) blocked = true;
  };
  const down = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    detach();
    blocked = false;
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    // why: no preventDefault, pointer capture or touch-action override. The browser must
    // remain free to pan, dispatch pointercancel and deliver movement outside the button.
    const options = { capture: true, passive: true };
    document.addEventListener("pointermove", move, options);
    document.addEventListener("pointerup", up, options);
    document.addEventListener("pointercancel", cancel, options);
    document.addEventListener("pointerdown", additionalPointer, options);
    document.addEventListener("scroll", scroll, options);
  };
  const click = (event: MouseEvent): void => {
    // why: retain the rejection until the next pointerdown, not a timer. A cancelled
    // gesture may never click; neither a later keyboard click (detail=0) nor a new tap
    // should be swallowed, while a delayed compatibility click must not mutate the note.
    const fromPointer = event.detail > 0 || ("pointerType" in event && event.pointerType !== "");
    if (fromPointer && (blocked || pointer !== undefined)) {
      event.preventDefault();
      return;
    }
    activate();
  };
  control.addEventListener("pointerdown", down, { passive: true });
  control.addEventListener("click", click);
  return () => {
    detach();
    control.removeEventListener("pointerdown", down);
    control.removeEventListener("click", click);
  };
}
