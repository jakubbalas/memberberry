import { scratchNote } from "./environment.js";
import { expect, signIn, test, tokenValue } from "./fixtures.js";

test("a device theme overrides its vault and can return to the system default", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();

  const selector = page.getByRole("combobox", { name: /^Theme/ });
  if (!(await selector.isVisible())) {
    await page.getByRole("button", { name: "Show Context" }).click();
  }
  await expect(selector).toHaveValue("vault");
  expect(await tokenValue(page, "body", "--surface-canvas")).toBe("#19191c");

  await selector.selectOption("memberberry-light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "memberberry-light");
  expect(await tokenValue(page, "body", "--surface-canvas")).toBe("#f7f7f5");

  await page.reload();
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  if (!(await page.getByRole("combobox", { name: /^Theme/ }).isVisible())) {
    await page.getByRole("button", { name: "Show Context" }).click();
  }
  await expect(page.getByRole("combobox", { name: /^Theme/ })).toHaveValue("memberberry-light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "memberberry-light");

  await page.getByRole("combobox", { name: /^Theme/ }).selectOption("vault");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(await tokenValue(page, "body", "--surface-canvas")).toBe("#19191c");
  expect(
    await page.evaluate(() => localStorage.getItem("memberberry.theme.personal")),
  ).toBeNull();
});

for (const [theme, canvas, paper] of [
  ["memberberry-light", "#f7f7f5", "rgb(255, 255, 255)"],
  ["memberberry-dark", "#19191c", "rgb(34, 34, 37)"],
  ["memberberry-pastel", "#181825", "rgb(30, 30, 46)"],
] as const) {
  test(`the ${theme} notebook stays readable and remembers its appearance`, async ({ page }, info) => {
    await signIn(page);
    // why: concurrent readers add presence labels to the editor DOM; each text-preservation
    // check needs its own note so those transient names cannot enter the expected content.
    await page.goto(`/v/personal/${scratchNote(`theme-${theme}`, info.project.name)}`);
    const editor = page.locator(".editor-surface .tiptap");
    await expect(editor).toContainText("Make room for a good idea.");
    const content = await editor.textContent();
    const selector = page.getByRole("combobox", { name: /^Theme/ });
    if (!(await selector.isVisible())) {
      await page.getByRole("button", { name: "Show Context" }).click();
    }
    await selector.selectOption(theme);
    await expect(page.locator(".editor-panel")).toHaveCSS("background-color", paper);
    expect(await tokenValue(page, "body", "--surface-canvas")).toBe(canvas);
    await page.reload();
    await expect(editor).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(editor).toHaveText(content ?? "");
    if (info.project.name === "mobile") {
      const hide = page.getByRole("button", { name: "Hide Context" });
      if (await hide.isVisible()) await hide.click();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await page.screenshot({ path: info.outputPath(`${theme}.png`) });
  });
}

test("secondary tools stay tucked away until opened with the keyboard", async ({ page }) => {
  await signIn(page);
  await page.goto("/v/personal/Welcome.md");
  await expect(page.locator(".editor-surface .tiptap")).toBeVisible();
  const print = page.getByRole("button", { name: "Print note or save it as PDF" });
  await expect(print).toBeHidden();
  const more = page.locator(".editor-more > summary");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(print).toBeVisible();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(print).toBeHidden();
});
