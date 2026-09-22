/**
 * Opening a switcher from a control (`SPEC.md` §8.4).
 *
 * Two things worth pinning: the request reaches the target it was given, and a listener
 * cannot be talked into opening something by an event that carries junk. The second is the
 * one that matters — this event travels on `window` by default, so anything on the page can
 * dispatch it, and `detail` is `unknown` however it was constructed.
 */

import { describe, expect, it } from "vitest";

import { PALETTE_EVENT, paletteRequest, requestPalette } from "./palette.js";

describe("requesting a palette", () => {
  it("dispatches the request on the target it was handed", () => {
    const host = new EventTarget();
    const seen: unknown[] = [];
    host.addEventListener(PALETTE_EVENT, (event) => seen.push(paletteRequest(event)));

    requestPalette("notes", host);
    requestPalette("commands", host);

    expect(seen).toEqual(["notes", "commands"]);
  });

  it("does not reach a different target", () => {
    const host = new EventTarget();
    const other = new EventTarget();
    let heard = 0;
    other.addEventListener(PALETTE_EVENT, () => (heard += 1));

    requestPalette("notes", host);

    expect(heard).toBe(0);
  });
});

describe("reading a request", () => {
  it("carries the selected creation destination", () => {
    expect(paletteRequest(new CustomEvent(PALETTE_EVENT, {
      detail: { kind: "create", from: "Projects/" },
    }))).toEqual({ kind: "create", from: "Projects/" });
  });

  it("accepts every mode the palette has", () => {
    for (const mode of ["commands", "notes", "vaults", "templates", "create"] as const) {
      expect(paletteRequest(new CustomEvent(PALETTE_EVENT, { detail: mode }))).toBe(mode);
    }
  });

  it.each([
    ["a mode that does not exist", new CustomEvent(PALETTE_EVENT, { detail: "settings" })],
    ["no detail at all", new CustomEvent(PALETTE_EVENT)],
    ["an object", new CustomEvent(PALETTE_EVENT, { detail: { mode: "notes" } })],
    ["a non-string destination", new CustomEvent(PALETTE_EVENT, { detail: { kind: "create", from: 7 } })],
    ["a missing destination", new CustomEvent(PALETTE_EVENT, { detail: { kind: "create" } })],
    ["a plain event", new Event(PALETTE_EVENT)],
  ])("refuses %s", (_case, event) => {
    expect(paletteRequest(event)).toBeUndefined();
  });
});
