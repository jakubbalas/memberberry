/**
 * Creating a note in a real browser (`SPEC.md` §6.10).
 *
 * This suite exists because of a defect nothing else here could see. A freshly registered
 * vault had no `access.toml`, so deny-by-default hid it from the person who had just created
 * it; and even once it was visible, a vault with **no notes** was a dead end — the workspace
 * shell is served from a note URL, so there was nothing to load the application from and no
 * way to make a first note from inside it.
 *
 * Both halves are only observable end to end. The Rust suite proves `CreateNote` refuses the
 * right callers and the DOM suite proves the palette command is wired, but neither can say
 * that a person who has just installed this can get from a sign-in form to a note they can
 * type in. That is the claim here, and it is made against a vault provisioned exactly as a
 * real first run provisions one (`serve.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { E2E_VAULT, emptyVaultName, emptyVaultRoot, emptyVaultSlug } from "./environment.js";
import { expect, signIn, test } from "./fixtures.js";

const EDITOR = ".editor-surface .tiptap";
const PROMPT = "dialog.rename-prompt";

test("the vault home has account navigation, readable notes and a creation dialog", async ({ page }, info) => {
  await signIn(page);
  await page.goto("/v/personal");
  await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  const show = page.getByRole("button", { name: "Show Navigation", exact: true });
  if (await show.isVisible()) await show.click();
  const navigation = page.getByRole("complementary", { name: "Navigation", exact: true });
  await expect(page.getByRole("link", { name: /Your vaults/ })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Log out" })).toBeVisible();
  await navigation.getByRole("button", { name: "New note", exact: true }).click();
  const prompt = page.getByRole("dialog", { name: "New note", exact: true });
  await expect(prompt.getByLabel("Name", { exact: true })).toBeFocused();
  await prompt.getByLabel("Name", { exact: true }).fill("Unsubmitted draft");
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  const tree = navigation.getByRole("tree", { name: "Notes", exact: true });
  await tree.getByRole("treeitem", { name: "Projects", exact: true }).click();
  const roadmap = tree.getByRole("treeitem", { name: /Roadmap/ });
  await expect(roadmap).toBeVisible();
  expect((await roadmap.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(info.project.name === "mobile" ? 44 : 28);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await page.screenshot({ path: info.outputPath("vault-home.png") });
  await roadmap.click();
  await expect(page.locator(EDITOR)).toBeVisible();
});

test.describe("first run, on a vault with no notes", () => {
  test("registering a vault grants its creator access to it", async ({ page }, info) => {
    // The original defect. `serve.ts` registers these vaults with no `access.toml` of their
    // own, so if the CLI does not write one the vault is invisible here and this fails —
    // which is exactly how it reached a user.
    const purpose = "registration";
    const slug = emptyVaultSlug(info.project.name, purpose);
    await signIn(page);

    await expect(page.getByRole("link", { name: emptyVaultName(info.project.name, purpose) })).toBeVisible();
    // And the policy it wrote is a real file in the vault, readable in a text editor (C2).
    const access = readFileSync(join(emptyVaultRoot(info.project.name, purpose), "access.toml"), "utf8");
    expect(access).toContain("alice");
    expect(access).toContain("owner");
    await page.goto(`/v/${slug}`);
    await expect(page.getByText("0 notes")).toBeVisible();
  });

  test("an empty vault offers a way in, and creating the first note opens the editor", async ({
    page,
  }, info) => {
    const purpose = "first-note";
    const slug = emptyVaultSlug(info.project.name, purpose);
    const name = "First note";
    await signIn(page);
    await page.goto(`/v/${slug}`);

    // The dead end this feature removes: with no notes there is no link to follow, so the
    // form is the only route into the application.
    await expect(page.getByText("This vault has no notes yet")).toBeVisible();
    await page.locator(".workspace-home").getByRole("button", { name: "New note", exact: true }).click();
    const field = page.getByRole("dialog", { name: "New note", exact: true }).getByLabel("Name", { exact: true });
    await expect(field).toBeFocused();
    await field.fill(name);
    await page.getByRole("button", { name: "Create" }).click();

    // A real editor, not a rendered page: the note is now something to type in.
    await expect(page.getByRole("region", { name: "Note editor: First note.md", exact: true })).toBeVisible();
    await expect(page.locator(EDITOR)).toBeVisible();
    await expect(page.locator(EDITOR).getByRole("heading", { name })).toBeVisible();

    // C2: it is a Markdown file a text editor would open, with no server involved.
    const onDisk = readFileSync(join(emptyVaultRoot(info.project.name, purpose), `${name}.md`), "utf8");
    expect(onDisk).toBe(`# ${name}\n`);
    await page.keyboard.type("My first note body.");
    await expect(page.locator(EDITOR).locator("p")).toContainText("My first note body.");
    await expect.poll(() => readFileSync(join(emptyVaultRoot(info.project.name, purpose), `${name}.md`), "utf8"), { timeout: 15_000 })
      .toContain("My first note body.");
  });

  test("a name that is already taken comes back on the form rather than a dead end", async ({
    page,
    failures,
  }, info) => {
    // Makes its own vault and clash rather than depending on another test's mutation.
    const slug = emptyVaultSlug(info.project.name, "name-clash");
    const name = `Taken ${info.project.name}`;
    await signIn(page);
    await page.goto(`/v/${slug}`);
    await page.locator(".workspace-home").getByRole("button", { name: "New note", exact: true }).click();
    await page.getByRole("dialog", { name: "New note", exact: true }).getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.locator(EDITOR)).toBeVisible();

    await page.goto(`/v/${slug}`);
    await page.locator(".workspace-home").getByRole("button", { name: "New note", exact: true }).click();
    await page.getByRole("dialog", { name: "New note", exact: true }).getByLabel("Name", { exact: true }).fill(name);
    failures.allow(new RegExp(`HTTP 400 .*/api/v1/vaults/${slug}/notes$`));
    failures.allow(/console error: Failed to load resource: the server responded with a status of 400/);
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("alert")).toContainText("already exists");
    // Still on a page with a form, which is the part that made the M5 login bug so bad.
    await expect(page.getByRole("button", { name: "Create" })).toBeVisible();
  });
});

test.describe("creating a note from the workspace", () => {
  test("New note creates inside the selected folder instead of beside the open note", async ({ page }, info) => {
    await signIn(page);
    await page.goto("/v/personal");
    const show = page.getByRole("button", { name: "Show Navigation", exact: true });
    if (await show.isVisible()) await show.click();
    await page.locator('[role="treeitem"][title="Projects"]').click();
    await page.getByRole("complementary", { name: "Navigation", exact: true }).getByRole("button", { name: "New note", exact: true }).click();
    const prompt = page.getByRole("dialog", { name: "New note", exact: true });
    await expect(prompt.locator(".rename-subject")).toHaveText("In Projects/");
    const name = `Selected folder ${info.project.name}`;
    await prompt.getByLabel("Name", { exact: true }).fill(name);
    await prompt.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.locator(EDITOR).getByRole("heading", { name, exact: true })).toBeVisible();
    expect(readFileSync(join(E2E_VAULT, "Projects", `${name}.md`), "utf8")).toBe(`# ${name}\n`);
  });

  test("the sidebar New note button opens a body that accepts typing immediately", async ({ page }, info) => {
    await signIn(page);
    await page.goto("/v/personal/Projects/Roadmap.md");
    await expect(page.locator(EDITOR)).toBeVisible();
    const show = page.getByRole("button", { name: "Show Navigation", exact: true });
    if (await show.isVisible()) await show.click();
    await page.getByRole("complementary", { name: "Navigation", exact: true }).getByRole("button", { name: "New note", exact: true }).click();
    const name = `New editable note ${info.project.name}`;
    const prompt = page.getByRole("dialog", { name: "New note", exact: true });
    await prompt.getByLabel("Name", { exact: true }).fill(name);
    await prompt.getByRole("button", { name: "Create", exact: true }).click();
    const region = page.getByRole("region", { name: `Note editor: ${name}.md`, exact: true });
    await expect(region.getByRole("heading", { name, exact: true })).toBeVisible();
    await page.keyboard.type("Immediately editable.");
    await expect(region.locator(".tiptap p")).toContainText("Immediately editable.");
    await expect.poll(() => readFileSync(join(E2E_VAULT, `${name}.md`), "utf8"), { timeout: 15_000 }).toContain("Immediately editable.");
  });

  test("the palette creates a note beside the open one and opens it to type in", async ({
    page,
  }, info) => {
    // In the shared vault, in a folder of this project's own, because `fullyParallel` runs
    // both viewports against one server and two tests must not create one path.
    const name = "From the palette";
    await signIn(page);

    // Open a note that really exists, so "beside the open one" has a meaning to assert.
    await page.goto("/v/personal/Projects/Roadmap.md");
    await expect(page.locator(EDITOR)).toBeVisible();

    await page.keyboard.press("ControlOrMeta+P");
    await page.getByRole("option", { name: /^New note/ }).click();
    const prompt = page.locator(PROMPT);
    await expect(prompt).toBeVisible();
    // Asserted on the input, not the dialog: a title gives the dialog height, so a prompt
    // whose form was hidden would still pass `toBeVisible` on the container (§22.6).
    await expect(prompt.locator(".rename-input")).toBeFocused();
    await expect(prompt.locator(".rename-subject")).toHaveText("In Projects/");

    const unique = `${name} ${info.project.name}`;
    await prompt.locator(".rename-input").fill(unique);
    await prompt.getByRole("button", { name: "Create" }).click();

    // It opened, and it is the editable surface rather than the read-only render.
    await expect(page.locator(EDITOR).getByRole("heading", { name: unique })).toBeVisible();
    expect(readFileSync(join(E2E_VAULT, "Projects", `${unique}.md`), "utf8")).toBe(`# ${unique}\n`);

    // And what was typed into it reaches the file, which is what "a note you can use" means.
    await page.keyboard.type("Written after creating it.");
    await expect(page.locator(EDITOR).locator("p")).toContainText("Written after creating it.");
    await expect
      .poll(() => readFileSync(join(E2E_VAULT, "Projects", `${unique}.md`), "utf8"), {
        timeout: 10_000,
      })
      .toContain("Written after creating it.");
  });
});
