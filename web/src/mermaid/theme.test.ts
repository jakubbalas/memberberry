import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MERMAID_COLOUR_TOKENS, mermaidThemeVariables, type TokenSource } from "./theme.js";

const tokens = (values: Record<string, string>): TokenSource => ({
  getPropertyValue: (name) => values[name] ?? "",
});

describe("mermaidThemeVariables", () => {
  it("paints Gantt bars from the accent and danger tokens as hex", () => {
    const variables = mermaidThemeVariables(tokens({
      "--accent-primary": " #6651A3", "--state-danger": "rgb(165, 32, 22)",
    }));
    expect([variables["taskBorderColor"], variables["critBorderColor"]]).toEqual(["#6651a3", "#a52016"]);
  });

  it("leaves out a token it cannot parse rather than guessing", () => {
    const variables = mermaidThemeVariables(tokens({ "--surface-note": "color-mix(in srgb, red, blue)" }));
    expect("background" in variables).toBe(false);
  });

  it("passes the UI font through and omits it when unset", () => {
    expect([
      mermaidThemeVariables(tokens({ "--font-ui": " system-ui, sans-serif " }))["fontFamily"],
      "fontFamily" in mermaidThemeVariables(tokens({})),
    ]).toEqual(["system-ui, sans-serif", false]);
  });

  it("names only tokens the design-token contract declares", () => {
    const contract = readFileSync("src/shell/tokens.css", "utf8");
    const missing = Object.values(MERMAID_COLOUR_TOKENS).filter((token) => !contract.includes(`${token}:`));
    expect(missing).toEqual([]);
  });
});
