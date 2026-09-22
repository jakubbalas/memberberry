/**
 * Opening a switcher from a control rather than a keystroke (`SPEC.md` §8.4).
 *
 * The palette lives in `CommandCenter`, which is a sibling of the top bar rather than its
 * parent, so the bar cannot call into it directly. An event is how the rest of this shell
 * already crosses that gap — `TEMPLATE_PALETTE_EVENT` in `templates.ts` does exactly this —
 * and it keeps the bar ignorant of which component owns the palette, which is the point:
 * there is one palette, reached two ways, and neither way is a second implementation.
 */

/** The event a control dispatches to open a switcher. */
export const PALETTE_EVENT = "memberberry:palette";

/** Which list the palette should open with. Mirrors `CommandCenter`'s own modes. */
export type PaletteRequest = "commands" | "notes" | "vaults" | "templates" | "create"
  | { readonly kind: "create"; readonly from: string };

/**
 * Asks whichever `CommandCenter` is listening to open `request`.
 *
 * `target` is injectable for the same reason the shell's other listeners are: a test should
 * not have to touch `window` to prove a button is wired.
 */
export function requestPalette(request: PaletteRequest, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<PaletteRequest>(PALETTE_EVENT, { detail: request }));
}

/**
 * The request carried by `event`, or `undefined` if it is not one.
 *
 * A listener validates rather than casts: this event can be dispatched by anything on the
 * page, and §4.3 says data crossing a boundary is narrowed, not asserted.
 */
export function paletteRequest(event: Event): PaletteRequest | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (typeof detail === "object" && detail !== null && "kind" in detail
    && detail.kind === "create" && "from" in detail && typeof detail.from === "string") {
    return { kind: "create", from: detail.from };
  }
  return detail === "commands" || detail === "notes" || detail === "vaults" || detail === "templates" || detail === "create"
    ? detail
    : undefined;
}
