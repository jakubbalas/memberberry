import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("clipper packages", () => {
  it("builds directly loadable Chrome and Firefox directories", () => {
    execFileSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      join(web, "scripts/build-clipper.ts"),
    ]);

    for (const browser of ["chrome", "firefox"]) {
      const root = join(web, "dist-clipper", browser);
      const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
        action?: { default_popup?: string };
        browser_action?: { default_popup?: string };
      };
      const popup = manifest.action?.default_popup ?? manifest.browser_action?.default_popup;
      if (popup === undefined) throw new Error(`${browser} manifest has no popup`);
      expect(popup).toBe("popup.html");
      expect(existsSync(join(root, popup))).toBe(true);
      expect(existsSync(join(root, "popup.js"))).toBe(true);
      expect(existsSync(join(root, "content.js"))).toBe(true);
    }
  });
});
