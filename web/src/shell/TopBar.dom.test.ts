// @vitest-environment jsdom

/**
 * The workspace top bar (`SPEC.md` §8.2).
 *
 * The bar holds the four session controls, and the one thing that must be true of all of
 * them is that they are reachable and say what they do — §8.4. The panel toggles get the
 * most attention here because they carry the accessibility contract the panels depend on:
 * they sit outside the region they collapse, they point at it with `aria-controls`, and
 * their name says which way they will move it.
 *
 * What the bar cannot be tested for in jsdom is that it *looks* like a bar. There is no
 * layout engine here, so its height, its position above the panels and the fact that it does
 * not cover the tab strip are all claims only a browser can make — `e2e/topbar.spec.ts`.
 */

import { mount, tick, unmount } from "svelte";
import { beforeEach, describe, expect, it } from "vitest";

import TopBar from "./TopBar.svelte";

let target: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  target = document.createElement("div");
  document.body.append(target);
});

interface Rendered {
  readonly toggled: ("left" | "right")[];
  readonly found: number[];
  readonly teardown: () => void;
}

function render(options: { left?: boolean; right?: boolean } = {}): Rendered {
  const toggled: ("left" | "right")[] = [];
  const found: number[] = [];
  const app = mount(TopBar, {
    target,
    props: {
      vault: "personal",
      leftCollapsed: options.left ?? false,
      rightCollapsed: options.right ?? false,
      ontoggle: (side: "left" | "right") => void toggled.push(side),
      onfind: () => void found.push(1),
      findHint: "⌘O",
      vaultTheme: "memberberry-light" as const,
      themeStorage: { getItem: () => null, setItem: () => undefined },
    },
  });
  return { toggled, found, teardown: () => unmount(app) };
}

const toggle = (side: "left" | "right"): HTMLButtonElement | null =>
  target.querySelector<HTMLButtonElement>(`.sidebar-toggle[data-side="${side}"]`);

describe("the top bar", () => {
  it("links the Memberberry brand to the current vault home", () => {
    const { teardown } = render();
    try {
      const home = target.querySelector<HTMLAnchorElement>('[aria-label="Memberberry home"]');
      expect(home?.getAttribute("href")).toBe("/v/personal");
      expect(home?.textContent).toContain("Memberberry");
    } finally {
      teardown();
    }
  });
  it("names each panel toggle by what pressing it will do", () => {
    const { teardown } = render({ left: false, right: true });
    try {
      expect(toggle("left")?.getAttribute("aria-label")).toBe("Hide Navigation");
      expect(toggle("right")?.getAttribute("aria-label")).toBe("Show Context");
    } finally {
      teardown();
    }
  });

  it("points each toggle at the panel it controls, and reports whether it is open", () => {
    const { teardown } = render({ left: true, right: false });
    try {
      expect(toggle("left")?.getAttribute("aria-controls")).toBe("sidebar-left");
      expect(toggle("left")?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle("right")?.getAttribute("aria-controls")).toBe("sidebar-right");
      expect(toggle("right")?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      teardown();
    }
  });

  it("asks for the side that was pressed, and only that side", () => {
    const { toggled, teardown } = render();
    try {
      toggle("right")?.click();
      toggle("left")?.click();
      expect(toggled).toEqual(["right", "left"]);
    } finally {
      teardown();
    }
  });

  it("reaches the toggles by keyboard, because they are real buttons", async () => {
    const { toggled, teardown } = render();
    try {
      const button = toggle("left");
      expect(button?.tagName).toBe("BUTTON");
      button?.focus();
      expect(document.activeElement).toBe(button);
      // A button's own behaviour: Enter and Space activate it. Asserting the click handler
      // is on a `<button>` is what makes that the browser's job rather than ours.
      button?.click();
      await tick();
      expect(toggled).toEqual(["left"]);
    } finally {
      teardown();
    }
  });

  it("links to the vault list, naming both this vault and where the link goes", () => {
    const { teardown } = render();
    try {
      const link = target.querySelector<HTMLAnchorElement>(".topbar-vault");
      expect(link?.getAttribute("href")).toBe("/");
      // Both halves matter: the slug is what the eye reads and "Your vaults" is what the
      // link does, and WCAG 2.5.3 asks for the visible label to be part of the spoken name.
      expect(link?.textContent).toContain("personal");
      expect(link?.textContent).toContain("Your vaults");
    } finally {
      teardown();
    }
  });

  it("offers quick find with its keystroke written the way this platform writes it", () => {
    const { found, teardown } = render();
    try {
      const find = target.querySelector<HTMLButtonElement>(".topbar-find");
      expect(find?.textContent).toContain("⌘O");
      // Named by an attribute rather than only by the text beside the icon: the label and
      // the hint are both hidden on a phone, and hidden text is not an accessible name.
      expect(find?.getAttribute("aria-label")).toBe("Quick find");
      find?.click();
      expect(found).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it("carries the appearance control, labelled, with the vault default named", () => {
    const { teardown } = render();
    try {
      const select = target.querySelector<HTMLSelectElement>(".theme-panel select");
      expect(select?.closest("label")?.textContent).toContain("Theme");
      expect(select?.selectedOptions.item(0)?.textContent).toBe("Vault default (Paper)");
    } finally {
      teardown();
    }
  });

  it("leaves quick find out entirely when there is nothing to open", () => {
    // A control that is present and does nothing is worse than one that is absent: §8.4's
    // palette is a command, and a button for a command that is not registered is a dead end.
    const app = mount(TopBar, {
      target,
      props: {
        vault: "personal",
        leftCollapsed: false,
        rightCollapsed: false,
        ontoggle: () => undefined,
        themeStorage: { getItem: () => null, setItem: () => undefined },
      },
    });
    try {
      expect(target.querySelector(".topbar-find")).toBeNull();
      // The toggles are not optional, and are still there.
      expect(target.querySelectorAll(".sidebar-toggle")).toHaveLength(2);
    } finally {
      void unmount(app);
    }
  });
});
