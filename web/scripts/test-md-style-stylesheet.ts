/** Real rebuilt WASM + Chromium stylesheet contract, no listener or application/notes. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import init, { toHtml, schemaJson } from "../src/wasm/mb.js";

const bytes = readFileSync(new URL("../src/wasm/mb_bg.wasm", import.meta.url));
await init({ module_or_path: bytes });
const contract = JSON.parse(schemaJson()) as { marks: Record<string, { attrs?: { value?: { values?: string[] } } }> };
const palette = contract.marks["mb_color"]?.attrs?.value?.values;
assert(palette !== undefined && palette.length === 9, "real Rust palette required");
const html = toHtml(palette.map(color =>
  `:mb-style[==${color}==]{underline="true" color="${color}" background="${color}" size="large"}`,
).join("\n\n") + '\n\n:mb-style[small]{size="small"}\n\n# :mb-style[large]{size="large"}\n', "", "");
const tokens = readFileSync(new URL("../src/shell/tokens.css", import.meta.url), "utf8");
// why: missing rules must be a detector failure, not a setup error.
let rules = "";
try { rules = readFileSync(new URL("../src/editor/note-format.css", import.meta.url), "utf8"); }
catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
const browser = await chromium.launch({ headless: true });
try {
  // Actual browser engine execution of freshly compiled glue/bytes, no server fetch.
  const wasmPage = await browser.newPage();
  const glue = readFileSync(new URL("../src/wasm/mb.js", import.meta.url), "utf8");
  const fixture = readFileSync(new URL("../../crates/mb-crdt/fixtures/conformance/full.md", import.meta.url), "utf8");
  const fixtureUpdate = readFileSync(new URL("../../crates/mb-crdt/fixtures/conformance/full.bin", import.meta.url));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(glue).toString("base64")}`;
  const boundary = await wasmPage.evaluate(async ({ moduleUrl, bytes, update, fixture }) => {
    const wasm: typeof import("../src/wasm/mb.js") = await import(moduleUrl);
    await wasm.default({ module_or_path: new Uint8Array(bytes) });
    return {
      normalized: wasm.normalize(fixture),
      reopened: wasm.markdownFromUpdate(new Uint8Array(update)),
      schema: wasm.schemaJson(),
    };
  }, { moduleUrl, bytes: Array.from(bytes), update: Array.from(fixtureUpdate), fixture });
  assert.equal(boundary.normalized, fixture, "Chromium compiled WASM canonical fixture");
  assert.equal(boundary.reopened, fixture, "Chromium compiled WASM native Yrs fixture");
  assert.equal(boundary.schema, schemaJson(), "Node/browser exact schema parity");
  await wasmPage.close();

  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.setContent(`<html><head><style>${tokens}</style><style>${rules}</style></head><body>${html}</body></html>`);
  for (const theme of ["memberberry-light", "memberberry-dark", "memberberry-pastel"]) {
    await page.evaluate(theme => { document.documentElement.dataset["theme"] = theme; }, theme);
    for (const color of palette) {
      const observed = await page.locator(`.mb-background-${color}`).evaluate((element, color) => {
        const text = element.querySelector("mark");
        if (text === null) throw new Error("native highlight missing");
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement("span");
        document.body.append(probe);
        probe.style.color = root.getPropertyValue(`--note-color-${color}`);
        probe.style.backgroundColor = root.getPropertyValue(`--note-background-${color}`);
        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(text);
        const result = {
          color: actual.color, background: actual.backgroundColor,
          expectedColor: expected.color, expectedBackground: expected.backgroundColor,
          underline: getComputedStyle(element.closest(".mb-underline") ?? element).textDecorationLine,
          size: getComputedStyle(element.querySelector(".mb-size-large") ?? element).fontSize,
          baseSize: root.fontSize,
        };
        probe.remove(); return result;
      }, color);
      assert.notEqual(observed.expectedBackground, "rgba(0, 0, 0, 0)", `${theme}/${color} defined background`);
      assert.equal(observed.color, observed.expectedColor, `${theme}/${color} text token`);
      assert.equal(observed.background, observed.expectedBackground, `${theme}/${color} beats native highlight`);
      assert.match(observed.underline, /underline/, `${theme}/${color} underline`);
      assert(Number.parseFloat(observed.size) > Number.parseFloat(observed.baseSize), `${theme}/${color} large`);
    }
    const sizes = await page.locator(".mb-size-small").evaluate(element => [
      getComputedStyle(element).fontSize, getComputedStyle(document.documentElement).fontSize,
    ]);
    assert(Number.parseFloat(sizes[0] ?? "") < Number.parseFloat(sizes[1] ?? ""), `${theme} small`);
    const heading = await page.locator("h1 .mb-size-large").evaluate(element => [
      getComputedStyle(element).fontSize, getComputedStyle(element.closest("h1") ?? element).fontSize,
    ]);
    assert(Number.parseFloat(heading[0] ?? "") > Number.parseFloat(heading[1] ?? ""), `${theme} large is relative to native heading size`);
  }
  // Negative control: detector must observe that removing shared rules loses underline.
  await page.locator("style").nth(1).evaluate(element => element.remove());
  assert.equal(await page.locator(".mb-underline").first().evaluate(element => getComputedStyle(element).textDecorationLine), "none");
  console.log(`PASS: ${palette.length} finite palette values × 3 themes, underline/size/highlight precedence; lost-rule control; compiled Node/Chromium WASM conformance and JS-disabled stylesheet (not application E2E)`);
  await context.close();
} finally { await browser.close(); }
