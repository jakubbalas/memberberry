/**
 * The workspace shell in a real browser (`SPEC.md` §8.2).
 *
 * The component tests cover the layout logic against jsdom. What only a browser can say is
 * whether the thing is *usable*: whether a split actually occupies two halves of the screen,
 * whether a pane scrolls instead of stretching the page, and whether the layout survives a
 * reload — which is the one claim that involves the server, the debounce and the ACL all at
 * once.
 *
 * jsdom has no layout engine at all, so every assertion here about a bounding box is one the
 * unit suite is structurally incapable of making.
 */

import { expect, signIn, test } from "./fixtures.js";

const PANE = ".pane";
const EDITOR = ".editor-surface .tiptap";

/** Opens the workspace on a note and waits for the editor to be live. */
async function openWorkspace(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();
}

test("renders one pane with the served note open in a tab", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the mobile layout has no tab strip (§8.3)");
  await openWorkspace(page);

  await expect(page.locator(PANE)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Welcome" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(EDITOR).first()).toContainText("A note that already exists");
});

test("opens the served note whichever layout is showing", async ({ page }) => {
  // The layout-independent half of the test above: whatever the chrome looks like, the note
  // the server served is the note on screen.
  await openWorkspace(page);
  await expect(page.locator(EDITOR).first()).toContainText("A note that already exists");
});

test("the shell fills the viewport and the pane scrolls rather than the page", async ({ page }) => {
  // The classic way this layout breaks: a nested grid child sizes to its content, so a long
  // note stretches the pane and the whole page scrolls. jsdom cannot see this.
  await openWorkspace(page);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const shell = await page.locator(".workspace-shell").boundingBox();
  expect(shell?.height ?? 0).toBeCloseTo(viewport?.height ?? 0, -1);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow, "the page itself must not scroll").toBeLessThanOrEqual(1);
});

test("splitting gives two panes that share the width", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the mobile layout renders one leaf (§8.3)");
  await openWorkspace(page);

  await page.locator(".workspace-shell").press("Meta+\\");
  await expect(page.locator(PANE)).toHaveCount(2);

  const [left, right] = await Promise.all([
    page.locator(PANE).nth(0).boundingBox(),
    page.locator(PANE).nth(1).boundingBox(),
  ]);
  expect(left?.width ?? 0).toBeGreaterThan(100);
  expect(right?.width ?? 0).toBeGreaterThan(100);
  // Side by side, not stacked: `vertical` means a vertical divider (§8.1).
  expect(Math.abs((left?.y ?? 0) - (right?.y ?? 0))).toBeLessThan(2);
  expect(right?.x ?? 0).toBeGreaterThan(left?.x ?? 0);
});

test("the divider resizes the panes and reports its position", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "no splits in the mobile layout (§8.3)");
  await openWorkspace(page);
  await page.locator(".workspace-shell").press("Meta+\\");

  const divider = page.getByRole("separator", { name: "Resize panes" });
  await expect(divider).toHaveAttribute("aria-valuenow", "50");

  const before = await page.locator(PANE).nth(0).boundingBox();
  // Keyboard, not a drag: §8.4 means the keyboard path is the one that must work, and this
  // is the assertion that the ARIA value and the actual geometry agree.
  await divider.focus();
  for (let press = 0; press < 5; press += 1) await divider.press("ArrowRight");

  await expect(divider).toHaveAttribute("aria-valuenow", "60");
  const after = await page.locator(PANE).nth(0).boundingBox();
  expect(after?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 20);
});

test("closing the last tab leaves a usable empty pane", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "mobile closes tabs from the sheet (§8.3)");
  await openWorkspace(page);

  await page.getByRole("button", { name: "Close Welcome" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No note open in this pane.")).toBeVisible();
  // Still one pane, still the shell: an empty workspace is a state, not a crash.
  await expect(page.locator(PANE)).toHaveCount(1);
});

test("a tab keeps its scroll position while another tab is in front", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "the tab strip is a desktop control (§8.3)");
  // §8.1: an inactive tab is "a row in the strip and a scroll offset in the model". Only the
  // active tab holds an editor, so coming back rebuilds one and puts it where it was — and
  // *where* is measured from the element that actually scrolls, which is the pane and not the
  // editor surface inside it. Binding the handler to the surface made this silently do
  // nothing for two milestones: it was written as 0 and restored as nothing, with no test
  // able to see it, because jsdom lays nothing out and so scrolls nothing.
  await signIn(page);
  await page.goto("/v/personal/Outline/Sections.md");
  await expect(page.locator(EDITOR).first()).toBeVisible();

  // A second tab in the same pane, from a link inside this note (§8.2).
  await page.locator(`${EDITOR} [data-wikilink]`).first().click({ modifiers: ["Meta"] });
  await expect(page.getByRole("tab")).toHaveCount(2);

  const scroller = page.locator(".note-pane").first();
  await page.getByRole("tab").first().click();
  await expect(page.locator(EDITOR).first()).toContainText("Outline scratch");
  await scroller.evaluate((element) => {
    element.scrollTop = 600;
  });
  await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).toBe(600);

  await page.getByRole("tab").nth(1).click();
  await expect(page.locator(EDITOR).first()).toContainText("A second tab");
  await page.getByRole("tab").first().click();
  await expect(page.locator(EDITOR).first()).toContainText("Outline scratch");

  await expect
    .poll(async () => scroller.evaluate((element) => element.scrollTop), { timeout: 10_000 })
    .toBe(600);
});

test("the layout survives a reload", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "splits are a desktop layout concern (§8.2)");
  // The end-to-end claim: the pane tree reached the server, was stored under this user and
  // device (E15), and came back. Nothing short of a reload tests the whole path.
  await openWorkspace(page);
  await page.locator(".workspace-shell").press("Meta+\\");
  await expect(page.locator(PANE)).toHaveCount(2);

  // The save is debounced; poll for the server to hold two panes rather than sleeping.
  await expect
    .poll(
      async () => {
        const stored = await page.request.get(
          `/api/v1/vaults/personal/workspace/${await deviceOf(page)}`,
        );
        if (stored.status() !== 200) return 0;
        // The stored layout is pretty-printed, so the pattern has to allow the space.
        return ((await stored.text()).match(/"kind":\s*"group"/g) ?? []).length;
      },
      { timeout: 10_000, intervals: [200] },
    )
    .toBe(2);

  await page.reload();
  await expect(page.locator(EDITOR).first()).toBeVisible();
  await expect(page.locator(PANE)).toHaveCount(2);
});

test("a second device gets its own layout, not this one", async ({ page }) => {
  // §8.1: not synced. A phone and a 32" monitor legitimately differ.
  await openWorkspace(page);
  const device = await deviceOf(page);

  const other = await page.request.get("/api/v1/vaults/personal/workspace/some-other-device");
  // 204, not 404: "nothing saved" is the normal first visit for any device, and answering
  // it with an error puts a 404 in the console on every fresh page load.
  expect(other.status(), "another device has saved nothing").toBe(204);
  expect(device).not.toBe("some-other-device");
});

test("the sidebars toggle and stay reachable", async ({ page }) => {
  await openWorkspace(page);

  // Asserted relative to the starting state rather than against `true`: on a wide viewport
  // the sidebars sit beside the content and start open, and below the §8.3 breakpoint they
  // are drawers over it and start closed. Both are correct, so the test pins the *toggle*.
  const toggle = page.getByRole("button", { name: /(Navigation|Show Navigation)$/ });
  const before = await toggle.getAttribute("aria-expanded");
  expect(before).not.toBeNull();

  await toggle.click();
  const after = page.getByRole("button", { name: /(Navigation|Show Navigation)$/ });
  await expect(after).toHaveAttribute("aria-expanded", before === "true" ? "false" : "true");

  // The control is still on screen and still hittable — toggling a sidebar must never
  // remove the only way back, which is a keyboard trap rather than a styling detail.
  const box = await after.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
});

/** This browser's device id, as the shell generated and stored it. */
async function deviceOf(page: import("@playwright/test").Page): Promise<string> {
  const device = await page.evaluate(() => localStorage.getItem("memberberry.device"));
  expect(device, "the shell should have created a device id").not.toBeNull();
  return device ?? "";
}

test.describe("the mobile layout (§8.3)", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "mobile", "these are the mobile-only rules");
  });

  test("shows one document, a nav bar, and no tab strip", async ({ page }) => {
    await openWorkspace(page);

    await expect(page.locator(".mobile-main")).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Navigation" })).toBeVisible();
  });

  test("the note fills the space above the bar, and the bar is reachable", async ({ page }) => {
    // The layout failure this catches: the bar overlaps the editor, or is pushed off the
    // bottom of the screen. jsdom has no layout engine and cannot see either.
    await openWorkspace(page);

    const viewport = page.viewportSize();
    const bar = await page.getByRole("navigation", { name: "Navigation" }).boundingBox();
    const pane = await page.locator(".note-pane").boundingBox();
    expect(bar).not.toBeNull();
    expect(pane).not.toBeNull();

    expect(bar?.height ?? 0).toBeGreaterThanOrEqual(44);
    // The bar sits below the note, not on top of it.
    expect(bar?.y ?? 0).toBeGreaterThanOrEqual((pane?.y ?? 0) + (pane?.height ?? 0) - 1);
    // And entirely on screen.
    expect((bar?.y ?? 0) + (bar?.height ?? 0)).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  });

  test("every control in the bar clears the 44px touch floor", async ({ page }) => {
    await openWorkspace(page);

    for (const name of ["Back", "Forward"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box?.width ?? 0, `${name} is too narrow to hit`).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0, `${name} is too short to hit`).toBeGreaterThanOrEqual(44);
    }
    const switcher = await page.locator(".mobile-bar-tabs").boundingBox();
    expect(switcher?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("the tab switcher opens as a sheet over the note and closes again", async ({ page }) => {
    await openWorkspace(page);

    await page.locator(".mobile-bar-tabs").click();
    const sheet = page.getByRole("dialog", { name: "Open notes" });
    await expect(sheet).toBeVisible();

    // A bottom sheet: anchored to the bottom of the screen, not floating in the middle.
    const viewport = page.viewportSize();
    const box = await sheet.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(viewport?.height ?? 0, -1);

    await page.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
  });

  test("Escape closes the sheet, because it is a real dialog", async ({ page }) => {
    // The reason for `<dialog>` over a styled div: Escape, focus trapping and an inert page
    // behind it are the browser's, and none of them was written here.
    await openWorkspace(page);

    await page.locator(".mobile-bar-tabs").click();
    const sheet = page.getByRole("dialog", { name: "Open notes" });
    await expect(sheet).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("closing the last note from the sheet leaves a usable empty pane", async ({ page }) => {
    await openWorkspace(page);

    await page.locator(".mobile-bar-tabs").click();
    await page.getByRole("button", { name: "Close Welcome" }).click();
    await expect(page.getByText("Nothing is open.")).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("No note open in this pane.")).toBeVisible();
  });

  test("an edge swipe opens the drawer", async ({ page }) => {
    // §8.3: "sidebars become swipe-in drawers". Unit tests cover the recogniser's rules; only
    // a browser can say the events actually reach it through the shell's handlers.
    await openWorkspace(page);
    const toggle = page.getByRole("button", { name: /Navigation$/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    const shell = page.locator(".workspace-shell");
    const common = { pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true };
    await shell.dispatchEvent("pointerdown", { ...common, clientX: 4, clientY: 400 });
    await shell.dispatchEvent("pointermove", { ...common, clientX: 140, clientY: 404 });

    await expect(page.getByRole("button", { name: /Navigation$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  test("a vertical drag near the edge scrolls instead of opening a drawer", async ({ page }) => {
    // The rule that matters most: the surface being swiped over is a text editor, and a
    // recogniser that is even slightly too eager steals scrolls and selection drags.
    await openWorkspace(page);

    const shell = page.locator(".workspace-shell");
    const common = { pointerId: 1, pointerType: "touch", isPrimary: true, bubbles: true };
    await shell.dispatchEvent("pointerdown", { ...common, clientX: 4, clientY: 200 });
    await shell.dispatchEvent("pointermove", { ...common, clientX: 10, clientY: 500 });

    await expect(page.getByRole("button", { name: /Navigation$/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  test("the sidebars start closed, so nothing covers the note", async ({ page }) => {
    // Below the breakpoint a sidebar is a drawer over the content. Open on arrival it covers
    // the note and swallows taps meant for what is beneath.
    await openWorkspace(page);

    for (const name of [/Navigation$/, /Context$/]) {
      await expect(page.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    }
    // And the editor is hittable, which is what "covered" would break.
    await expect(page.locator(EDITOR).first()).toBeVisible();
    await page.locator(EDITOR).first().click();
  });
});

test.describe("the command palette and switchers (§8.4)", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === "mobile", "the shortcuts are checked on desktop");
  });

  test("the command palette opens, filters and runs a command", async ({ page }) => {
    await openWorkspace(page);

    await page.keyboard.press("ControlOrMeta+Shift+P");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    // Ready to type into, which is the whole point of a palette.
    await expect(page.getByRole("combobox", { name: "Command palette" })).toBeFocused();

    await page.keyboard.type("split right");
    // Scoped to the palette: the editor's task-metadata `<select>` has real `<option>`
    // elements of its own, and an unscoped role locator finds those too.
    await expect(palette.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");

    await expect(palette).toBeHidden();
    await expect(page.locator(".pane")).toHaveCount(2);
  });

  test("the quick switcher finds a note by title and opens it", async ({ page }) => {
    // The end-to-end claim: the server parsed the title, the list was permission-filtered on
    // the way out, and the client ranked it. Nothing short of this exercises all three.
    await openWorkspace(page);

    await page.keyboard.press("ControlOrMeta+k");
    const switcher = page.getByRole("dialog", { name: "Open a note" });
    await expect(switcher).toBeVisible();

    await page.keyboard.type("roadmap");
    await expect(switcher.getByRole("option").first()).toContainText("Roadmap");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("tab", { name: "Roadmap" })).toBeVisible();
    await expect(page.locator(EDITOR).first()).toContainText("Ship the workspace shell");
  });

  test("the vault switcher lists the vaults this user can open", async ({ page }) => {
    await openWorkspace(page);

    await page.keyboard.press("ControlOrMeta+Shift+V");
    const switcher = page.getByRole("dialog", { name: "Switch vault" });
    await expect(switcher).toBeVisible();
    await expect(switcher.getByRole("option", { name: /Personal/ })).toBeVisible();
    // The current one is marked as such, whichever position it sorts into. Asserted on the
    // Personal row rather than on `.first()`: the server has had more than one vault since
    // §6.10 added the empty ones, and `.first()` was quietly asserting the sort order.
    await expect(switcher.getByRole("option", { name: /Personal/ })).toContainText("current");
    // The others are listed too, because the switcher is over every vault this user can open.
    await expect(switcher.getByRole("option", { name: /^Empty/ }).first()).toBeVisible();
  });

  test("Escape closes the palette without acting", async ({ page }) => {
    await openWorkspace(page);
    const before = await page.getByRole("tab").count();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Open a note" })).toBeVisible();
    await page.keyboard.press("Escape");


    await expect(page.getByRole("dialog", { name: "Open a note" })).toBeHidden();
    await expect(page.getByRole("tab")).toHaveCount(before);
  });

  test("a shortcut works from inside the editor, and typing does not trigger one", async ({
    page,
  }) => {
    // The rule that keeps the shell out of the editor's way: a Mod chord reaches the shell
    // from inside a note, a bare key does not. Getting the second wrong means typing a letter
    // opens a palette.
    await openWorkspace(page);
    await page.locator(EDITOR).first().click();

    await page.keyboard.type("pk");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(EDITOR).first()).toContainText("pk");

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Open a note" })).toBeVisible();
  });
});

test.describe("the note tree, bookmarks and breadcrumbs (§8.2)", () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name === "mobile", "the sidebar is a drawer on mobile (§8.3)");
  });

  test("lists the vault's readable notes, folders first", async ({ page }) => {
    // The end-to-end claim: the server listed the notes, filtered them, parsed their titles,
    // and the tree built a shape out of the paths.
    await openWorkspace(page);
    const tree = page.getByRole("tree", { name: "Notes" });
    await expect(tree).toBeVisible();

    await expect(tree.getByRole("treeitem", { name: /Projects/ })).toBeVisible();
    await expect(tree.getByRole("treeitem", { name: /Welcome/ })).toBeVisible();
    // Every folder comes before every loose note. Asserted as a partition rather than by
    // naming whichever folder happens to sort first: adding a note to the fixture vault
    // must not be able to break a test about ordering.
    const kinds = await tree
      .getByRole("treeitem")
      .evaluateAll((rows) => rows.map((row) => row.dataset["kind"] ?? ""));
    expect(kinds).toContain("folder");
    expect(kinds).toContain("note");
    expect(kinds.lastIndexOf("folder")).toBeLessThan(kinds.indexOf("note"));
  });

  test("expands a folder and opens the note inside it", async ({ page }) => {
    await openWorkspace(page);
    const tree = page.getByRole("tree", { name: "Notes" });

    const folder = tree.getByRole("treeitem", { name: /Projects/ });
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folder.click();
    await expect(tree.getByRole("treeitem", { name: /Projects/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    await tree.getByRole("treeitem", { name: /Roadmap/ }).click();
    await expect(page.getByRole("tab", { name: "Roadmap" })).toBeVisible();
    await expect(page.locator(EDITOR).first()).toContainText("Ship the workspace shell");
  });

  test("is navigable from the keyboard alone", async ({ page }, info) => {
    // §8.4: no mouse-only feature ships. One tab stop, then arrows — which is also the only
    // way to tell a real `tree` from a list of buttons.
    await openWorkspace(page);
    const tree = page.getByRole("tree", { name: "Notes" });
    await tree.focus();

    // Whichever folder the cursor starts on, rather than a named one — see the ordering
    // test above for why.
    const rows = tree.getByRole("treeitem");
    await tree.press("ArrowRight");
    await expect(rows.first()).toHaveAttribute("aria-expanded", "true");
    await tree.press("ArrowDown");
    // From the row's path rather than its label: the tree shows a note's *title* and a tab
    // shows its filename (`TabStrip.svelte` — a tab is narrow), so the two disagree for any
    // note whose title is not its filename.
    // The row's tooltip is its path (`NoteTree.svelte`).
    const path = (await rows.nth(1).getAttribute("title")) ?? "";
    const child = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    await tree.press("Enter");

    await expect(page.getByRole("tab", { name: child })).toBeVisible();
    expect(info.project.name).toBe("desktop");
  });

  test("bookmarks a note, and keeps it across a reload", async ({ page }) => {
    // The whole path: the star writes to the server, the server stores it under this user,
    // and the next session reads it back — filtered by what they can still see.
    await openWorkspace(page);
    const tree = page.getByRole("tree", { name: "Notes" });

    await tree.getByRole("treeitem", { name: /Welcome/ }).hover();
    await page.getByRole("button", { name: "Add bookmark for Welcome" }).click();
    await expect(page.getByRole("button", { name: "Remove bookmark for Welcome" })).toBeVisible();

    // The save is debounced; poll the server rather than sleeping.
    await expect
      .poll(
        async () => {
          const stored = await page.request.get("/api/v1/vaults/personal/bookmarks");
          return stored.ok() ? await stored.text() : "";
        },
        { timeout: 10_000, intervals: [200] },
      )
      .toContain("Welcome.md");

    await page.reload();
    await expect(page.locator(EDITOR).first()).toBeVisible();
    await expect(page.getByText("Bookmarks")).toBeVisible();
    await expect(page.locator(".bookmark-list")).toContainText("Welcome");
  });

  test("shows where the open note lives", async ({ page }) => {
    await openWorkspace(page);
    const crumbs = page.getByRole("navigation", { name: "Note location" });
    await expect(crumbs).toContainText("Welcome");

    // A note in a folder shows the folder too.
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("roadmap");
    await page.keyboard.press("Enter");
    await expect(crumbs).toContainText("Projects");
    await expect(crumbs).toContainText("Roadmap");
  });
});
