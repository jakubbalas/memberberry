import { describe, expect, it } from "vitest";

import config from "../playwright.config.js";

describe("E2E browser configuration", () => {
  it("uses the bundled default headless browser without channel overrides", () => {
    expect(config.use?.channel).toBeUndefined();
    for (const project of config.projects ?? []) {
      expect(project.use?.channel).toBeUndefined();
    }
  });

  it("does not conceal failures with retries", () => {
    expect(config.retries).toBe(0);
  });
});
