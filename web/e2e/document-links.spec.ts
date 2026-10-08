import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, signIn, test } from "./fixtures.js";
import { E2E_VAULT } from "./environment.js";

const EDITOR = ".editor-surface .tiptap";

async function activate(page: Page, name: string, mobile: boolean): Promise<void> {
  const link = page.locator(EDITOR).getByRole("link", { name, exact: true });
  if (mobile) await link.tap();
  else await link.click();
}

test("same-note heading and block links scroll without replacing the mounted editor", async ({ page }, info) => {
  await signIn(page);
  const source = `DocumentLinks/Anchors-${info.project.name}.md`;
  const filler = Array.from({ length: 60 }, (_, index) => `Long section ${index}.`).join("\n\n");
  await create(page, source, `# Anchor source\n\n[Goals](#Review%20Plan)\n\n${filler}\n\n## Review [[Projects/Roadmap|Plan]]\n\n[Pinned block](#^pinned)\n\n${filler}\n\nPinned destination. ^pinned\n`);
  await page.goto(`/v/personal/${source}`);
  await expect(page.locator(EDITOR)).toBeVisible();
  const original = await page.locator(EDITOR).elementHandle();
  await activate(page, "Goals", info.project.name === "mobile");
  await expect(page.locator(EDITOR).locator("h2").filter({ has: page.locator('[data-wikilink][data-target="Projects/Roadmap"]') })).toBeInViewport();
  await activate(page, "Pinned block", info.project.name === "mobile");
  await expect(page.locator(EDITOR).getByText("Pinned destination.", { exact: true })).toBeInViewport();
  expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
});

test("Markdown links inside a transclusion resolve from that embedded note and scroll to blocks", async ({ page }, info) => {
  await signIn(page);
  const suffix = info.project.name;
  const target = `DocumentLinks/Embedded/Target-${suffix}.md`;
  const embedded = `DocumentLinks/Embedded/Source-${suffix}.md`;
  const host = `DocumentLinks/EmbedHost-${suffix}.md`;
  const filler = Array.from({ length: 70 }, (_, index) => `Embedded destination paragraph ${index}.`).join("\n\n");
  await create(page, target, `# Embedded link destination\n\n${filler}\n\nEmbedded pinned destination. ^pinned\n`);
  await create(page, embedded, `# Embedded source\n\n[Embedded next](./Target-${suffix}.md#^pinned)\n`);
  await create(page, host, `# Host source\n\n![[${embedded.replace(/\.md$/, "")}]]\n`);
  await page.goto(`/v/personal/${host}`);
  const link = page.locator(EDITOR).locator(".note-embed-body").getByRole("link", { name: "Embedded next", exact: true });
  await expect(link).toBeVisible();
  if (suffix === "mobile") await link.tap();
  else { await link.focus(); await page.keyboard.press("Enter"); }
  await expect(page.locator(EDITOR).getByText("Embedded pinned destination.", { exact: true })).toBeInViewport();
  await expect(page).toHaveURL(new RegExp(`/v/personal/DocumentLinks/Embedded/Target-${suffix}\\.md$`));
});

async function create(page: Page, path: string, content: string): Promise<void> {
  const response = await page.request.post("/api/v1/vaults/personal/notes", { data: { path, content } });
  expect(response.ok(), await response.text()).toBe(true);
}

test("a blocked embedded link is inert while an actual blocked heading remains navigable", async ({ page }, info) => {
  await signIn(page);
  const source = `DocumentLinks/Disabled-${info.project.name}.md`;
  const host = `DocumentLinks/DisabledHost-${info.project.name}.md`;
  await create(page, source, "# Disabled source\n\n[Unsafe](<javascript:alert('unsafe')>)\n\n[Real heading](#blocked)\n\n## blocked\n");
  await create(page, host, `# Disabled host\n\n![[${source.replace(/\.md$/, "")}]]\n`);
  await page.goto(`/v/personal/${host}`);
  const unsafe = page.locator(`${EDITOR} .note-embed-body a[aria-disabled="true"]`);
  await expect(unsafe).toBeVisible();
  await expect(unsafe).not.toHaveAttribute("href", /.+/);
  await page.evaluate(() => {
    document.documentElement.dataset["navigationRequests"] = "0";
    document.addEventListener("memberberry:open-note", () => {
      document.documentElement.dataset["navigationRequests"] = "1";
    }, { once: true });
  });
  // Native pointer input intentionally avoids locator.click's disabled-element refusal.
  const box = await unsafe.boundingBox();
  if (box === null) throw new Error("disabled link is not laid out");
  if (info.project.name === "mobile") await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.locator("html").getAttribute("data-navigation-requests")).toBe("0");
  await expect(page.locator(EDITOR).getByRole("heading", { name: "Disabled host", exact: true })).toBeVisible();
  await page.locator(`${EDITOR} .note-embed-body`).getByRole("link", { name: "Real heading", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/v/personal/${source.replace(/\./g, "\\.")}$`));
  await expect(page.locator(EDITOR).getByRole("heading", { name: "blocked", exact: true })).toBeInViewport();
});

test("ordinary Markdown document links activate from the editable surface", async ({ page }, info) => {
  await signIn(page);
  const target = `DocumentLinks/Target-${info.project.name}.md`;
  const source = `DocumentLinks/Source-${info.project.name}.md`;
  const filler = Array.from({ length: 70 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
  await create(page, target, `# Link destination\n\n${filler}\n\n## Goals\n\nThe linked section.\n`);
  await create(page, source, `# Link source\n\n[Open target](./Target-${info.project.name}.md#Goals)\n`);
  await page.goto(`/v/personal/${source}`);
  const link = page.locator(EDITOR).getByRole("link", { name: "Open target", exact: true });
  await expect(link).toBeVisible();
  if (info.project.name === "mobile") await link.tap();
  else await link.click();
  await expect(page.locator(EDITOR).getByRole("heading", { name: "Link destination", exact: true })).toBeVisible();
  await expect(page.locator(EDITOR).getByRole("heading", { name: "Goals", exact: true })).toBeInViewport();
  await expect.poll(() => page.locator(".note-pane").evaluate((pane) => pane.scrollTop)).toBeGreaterThan(300);
  await expect(page).toHaveURL(new RegExp(`/v/personal/DocumentLinks/Target-${info.project.name}\\.md(?:#.*)?$`));
});

test("[[ lookup shows title and path and accepts keyboard or touch selection", async ({ page }, info) => {
  await signIn(page);
  const source = `DocumentLinks/Autocomplete-${info.project.name}.md`;
  await create(page, source, "# Document lookup\n\nContinue here.\n");
  await page.goto(`/v/personal/${source}`);
  const editor = page.locator(EDITOR);
  const paragraph = editor.getByText("Continue here.", { exact: true });
  await expect(paragraph).toBeVisible();
  const line = await paragraph.boundingBox();
  if (line === null) throw new Error("body is not laid out");
  await paragraph.click({ position: { x: line.width - 2, y: line.height - 2 } });
  await page.keyboard.type(" [[road");
  const suggestions = page.getByRole("listbox", { name: "Document suggestions" });
  await expect(suggestions).toBeVisible();
  const option = suggestions.getByRole("option").filter({ hasText: "Projects/Roadmap.md" });
  await expect(option).toBeVisible();
  const box = await suggestions.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  if (info.project.name === "mobile") await option.tap();
  else await page.keyboard.press("Enter");
  await expect(suggestions).toBeHidden();
  const inserted = editor.getByRole("link", { name: "Roadmap", exact: true });
  await expect(inserted).toBeVisible();
  await expect(inserted).toHaveAttribute("href", "Projects/Roadmap.md");
  await expect.poll(() => readFileSync(join(E2E_VAULT, source), "utf8"), { timeout: 15_000 })
    .toContain("[Roadmap](Projects/Roadmap.md)");
  await page.reload();
  await expect(inserted).toHaveAttribute("href", "Projects/Roadmap.md");
  await inserted.click();
  await expect(page.locator(EDITOR).getByRole("heading", { name: "Roadmap", exact: true })).toBeVisible();
});

test("safe external links open without replacing the editor and unsafe schemes stay inert", async ({ page }, info) => {
  await signIn(page);
  const origin = new URL(page.url()).origin;
  const source = `DocumentLinks/Schemes-${info.project.name}.md`;
  await create(page, source, `# Link schemes\n\n[External](${origin}/v/personal/Welcome.md)\n\n[Unsafe](<javascript:alert('unsafe')>)\n`);
  await page.goto(`/v/personal/${source}`);
  const editor = page.locator(EDITOR);
  const unsafe = editor.locator("a").filter({ hasText: "Unsafe" });
  await expect(unsafe).toBeVisible();
  await expect(unsafe).not.toHaveAttribute("href", /.+/);
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await unsafe.click();
  expect(dialogs).toEqual([]);
  const opened = page.waitForEvent("popup");
  await editor.getByRole("link", { name: "External", exact: true }).click();
  const popup = await opened;
  await expect(popup).toHaveURL(`${origin}/v/personal/Welcome.md`);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await expect(page.locator(EDITOR).getByRole("heading", { name: "Link schemes", exact: true })).toBeVisible();
  await popup.close();
});
