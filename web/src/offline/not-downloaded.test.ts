// @vitest-environment jsdom

/**
 * The "body not downloaded" state (`SPEC.md` §7.2).
 *
 * Small, and worth its own tests for one reason: what it shows is the *metadata* tier, which
 * is the entire argument for replicating metadata eagerly. A state that could only say "not
 * available" would not need any of it.
 */

import { describe, expect, it } from "vitest";

import { notDownloaded } from "./not-downloaded.js";

describe("the not-downloaded state", () => {
  it("shows the replicated title", () => {
    const element = notDownloaded("Projects/Roadmap.md", {
      path: "Projects/Roadmap.md",
      title: "Roadmap",
      conflicts: 0,
    });
    expect(element.querySelector("h2")?.textContent).toBe("Roadmap");
  });

  it("falls back to the note's name when it has no title", () => {
    const element = notDownloaded("Projects/Roadmap.md", undefined);
    expect(element.querySelector("h2")?.textContent).toBe("Projects/Roadmap");
  });

  it("says plainly that the text is elsewhere, and how to fix it", () => {
    const element = notDownloaded("One.md", undefined);
    expect(element.textContent).toContain("has not been downloaded to this device");
    expect(element.textContent).toContain("pin it");
  });

  it("announces itself, because it replaces the thing the reader was looking at", () => {
    // §8.4: a pane that swaps its content for a message has to say so to a screen reader.
    expect(notDownloaded("One.md", undefined).getAttribute("role")).toBe("status");
  });

  it("is nothing to type into", () => {
    // The whole point. An empty editor here would merge whatever was typed with the body
    // that arrives on reconnect, and the note would look destroyed.
    const element = notDownloaded("One.md", undefined);
    expect(element.querySelector("textarea, input, [contenteditable]")).toBeNull();
  });
});
