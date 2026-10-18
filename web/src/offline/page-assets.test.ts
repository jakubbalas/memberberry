import { expect, it } from "vitest";
import { containsPageAssets } from "./precache.js";

const origin = "https://notes.example";
const build = new Set(["/assets/app.js", "/assets/new.css"]);
it("recognizes a page only when every script and stylesheet is in the build", () => {
  expect(containsPageAssets([`${origin}/assets/app.js`, `${origin}/assets/new.css`], origin, build)).toBe(true);
});
it("detects a stylesheet-only update even when the JavaScript stayed the same", () => {
  expect(containsPageAssets([`${origin}/assets/app.js`, `${origin}/assets/old.css`], origin, build)).toBe(false);
});
it.each([
  { label: "empty", assets: [] },
  { label: "foreign", assets: ["https://other.example/assets/app.js"] },
  { label: "non-string", assets: [42] },
  { label: "malformed", assets: ["not a URL"] },
])("refuses a $label build probe", ({ assets }) => {
  expect(containsPageAssets(assets, origin, build)).toBe(false);
});
