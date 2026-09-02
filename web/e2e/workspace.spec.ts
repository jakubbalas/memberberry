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

test("renders one pane with the served note open in a tab", async ({ page }) => {
  await openWorkspace(page);

  await expect(page.locator(PANE)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: "Welcome" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
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

test("closing the last tab leaves a usable empty pane", async ({ page }) => {
  await openWorkspace(page);

  await page.getByRole("button", { name: "Close Welcome" }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No note open in this pane.")).toBeVisible();
  // Still one pane, still the shell: an empty workspace is a state, not a crash.
  await expect(page.locator(PANE)).toHaveCount(1);
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
