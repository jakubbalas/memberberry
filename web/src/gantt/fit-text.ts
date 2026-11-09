/**
 * Shortening a label to fit (SPEC §13.2). Shared by the note's chart and the visual editor, so
 * it stays tiny, imports nothing, and is one of the files in `src/gantt/` the startup bundle may
 * contain.
 */

const ELLIPSIS = "…";

/**
 * The longest start of `full` that fits `max` with an ellipsis, or `full` itself when it fits.
 * Cuts between characters, never inside one (emoji stay whole). `measure` must grow with the
 * text, as a rendered width does.
 */
export function fitText(full: string, max: number, measure: (text: string) => number): string {
  if (measure(full) <= max) return full;
  const chars = [...full];
  const cut = (count: number): string => `${chars.slice(0, count).join("").trimEnd()}${ELLIPSIS}`;
  let low = 0;
  let high = chars.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(cut(middle)) <= max) low = middle;
    else high = middle - 1;
  }
  return cut(low);
}
