/**
 * The design-token contract, as the browser resolves it (SPEC.md §20.1).
 *
 * `scripts/token-check.py` proves every token is declared and used; `tokens.test.ts` pins
 * the two values TypeScript also owns. Neither can tell you the tokens actually *reach* an
 * element. A missing stylesheet, an unresolved `@import` or a contract the server forgot to
 * inline all produce a page that is structurally perfect and visually unstyled — which is
 * the exact shape of the M5 asset bug, and invisible to everything but a browser.
 */

import { expect, signIn, test, tokenValue } from "./fixtures.js";

/** What the surface and text roles resolve to in each colour scheme. */
const THEMES = {
  light: { canvas: "#f4f0e8", text: "#24332c", note: "#fffdf8" },
  dark: { canvas: "#18231f", text: "#f2efe6", note: "#22312a" },
} as const;

/** `getComputedStyle` returns colours as `rgb(...)`; the contract writes them as hex. */
function toRgb(hex: string): string {
  const channel = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`;
}

for (const [scheme, expected] of Object.entries(THEMES)) {
  test(`the server-rendered pages resolve the contract in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme as "light" | "dark" });
    await signIn(page);

    // The pages carry no external assets on purpose (§17.2), so the contract has to be
    // inlined. If the `include_str!` ever goes, these fall back to the browser default.
    expect(await tokenValue(page, "body", "--surface-canvas")).toBe(expected.canvas);
    await expect(page.locator("body")).toHaveCSS("background-color", toRgb(expected.canvas));
    await expect(page.locator("body")).toHaveCSS("color", toRgb(expected.text));
  });

  test(`the editor page resolves the contract in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme as "light" | "dark" });
    await signIn(page);
    await page.goto("/v/personal/Welcome.md");
    await expect(page.locator(".editor-surface .tiptap")).toBeVisible();

    // This is the app bundle's stylesheet rather than the inlined one, so it also proves
    // Vite resolved `@import "./tokens.css"` into the built CSS.
    expect(await tokenValue(page, "body", "--surface-canvas")).toBe(expected.canvas);
    // The reading surface is `--surface-note`, which differs from the canvas behind it in
    // both themes — so this also catches a theme block that forgot one of the two.
    await expect(page.locator(".editor-panel")).toHaveCSS(
      "background-color",
      toRgb(expected.note),
    );
  });
}

test("the note surface is styled, not merely present", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");

  const panel = page.locator(".editor-panel");
  await expect(panel).toBeVisible();
  // An unstyled page has no radius, no border and no shadow. Asserting one of each is how a
  // "the CSS never loaded" failure shows up as a test result rather than a screenshot
  // nobody looks at. Deliberately *not* an exact radius: desktop uses `--radius-lg` and
  // mobile `--radius-md`, so pinning a number here would assert the viewport, not the CSS.
  await expect(panel).not.toHaveCSS("border-radius", "0px");
  await expect(panel).not.toHaveCSS("box-shadow", "none");
  await expect(page.locator(".eyebrow")).toHaveCSS("text-transform", "uppercase");
});

test("every interactive control clears the 44px touch floor on mobile", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the floor is a mobile requirement (SPEC §8.3)");

  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();

  // SPEC §8.3 and §20.3: 44px, and `--touch-target-min` is only worth having if the
  // controls that reference it actually end up that size once laid out.
  //
  // Only the visible ones: the slash menu is collapsed until opened, and a control with no
  // box is hidden rather than too small. Its size is checked when the menu that owns it is
  // open, not here.
  const controls = await page.locator(".editor-control").all();
  const measured: Array<{ label: string; width: number; height: number }> = [];
  for (const control of controls) {
    const box = await control.boundingBox();
    if (box === null) continue;
    measured.push({
      label: (await control.textContent())?.trim() ?? "(unlabelled)",
      width: box.width,
      height: box.height,
    });
  }

  expect(measured.length, "the editor should offer controls to press").toBeGreaterThan(0);
  const tooSmall = measured.filter((c) => c.width < 44 || c.height < 44);
  expect(tooSmall, "every visible control must be reachable by a finger").toEqual([]);
});
