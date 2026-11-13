// @vitest-environment jsdom

/** The banner on a recovered note (`SPEC.md` §7.6.7). */

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import RecoveredBanner from "./RecoveredBanner.svelte";
import type { RecoveredNote } from "./device-offline.js";

const note: RecoveredNote = {
  path: "Recovered/Plan (offline edits).md",
  original: "Projects/Plan.md",
  createAgainRefused: false,
};

let teardown: (() => void) | undefined;
afterEach(() => {
  teardown?.();
  teardown = undefined;
  document.body.replaceChildren();
});

function render(props: { note?: RecoveredNote; answer?: string | undefined } = {}) {
  const calls: (string | undefined)[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(RecoveredBanner, {
    target,
    props: {
      note: props.note ?? note,
      onplace: async (to?: string) => {
        calls.push(to);
        return props.answer;
      },
    },
  });
  teardown = () => unmount(app);
  return { calls };
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

async function settle(): Promise<void> {
  flushSync();
  await tick();
  await Promise.resolve();
  await tick();
}

describe("a recovered note's banner", () => {
  it("says what happened, the same for every cause", () => {
    render();
    expect(document.body.textContent).toContain(
      "This note is no longer available on the server. Your offline edits were kept here.",
    );
  });

  it("creates the note again where it was", async () => {
    const { calls } = render();
    button("Create the note again")?.click();
    await settle();
    expect(calls).toEqual([undefined]);
  });

  it("offers only a new note once creating it again was refused", () => {
    render({ note: { ...note, createAgainRefused: true } });
    expect(button("Create the note again")).toBeUndefined();
    expect(button("Make a new note")).toBeDefined();
  });

  it("makes a new note under the name the user gives, starting from the original's", async () => {
    const { calls } = render();
    button("Make a new note")?.click();
    await settle();
    const input = document.querySelector<HTMLInputElement>("#recovered-name-input");
    expect(input?.value).toBe("Plan");
    if (input === null) throw new Error("no name field");
    input.value = "Ideas/Plan kept";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button("Create")?.click();
    await settle();
    expect(calls).toEqual(["Ideas/Plan kept.md"]);
  });

  it("asks for a name rather than sending an empty one", async () => {
    const { calls } = render();
    button("Make a new note")?.click();
    await settle();
    const input = document.querySelector<HTMLInputElement>("#recovered-name-input");
    if (input === null) throw new Error("no name field");
    input.value = "  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button("Create")?.click();
    await settle();
    expect(calls).toEqual([]);
    expect(document.querySelector(".recovered-message")?.textContent).toBe("Give the note a name.");
  });

  it("shows the refusal it was given", async () => {
    render({ answer: "Memberberry could not create a note there." });
    button("Create the note again")?.click();
    await settle();
    expect(document.querySelector(".recovered-message")?.textContent).toBe(
      "Memberberry could not create a note there.",
    );
  });
});

describe("a recovered note's banner, after a refusal", () => {
  it("clears the refusal once the user starts naming a new note", async () => {
    render({ answer: "Memberberry could not create a note there." });
    button("Create the note again")?.click();
    await settle();
    button("Make a new note")?.click();
    await settle();
    expect(document.querySelector(".recovered-message")?.textContent).toBe("");
  });
});
