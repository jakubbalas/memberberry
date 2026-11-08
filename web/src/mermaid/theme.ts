/**
 * Mermaid's colours, read from the design tokens (SPEC §13.2, §20.1).
 *
 * Mermaid's `base` theme derives its palette from `themeVariables` with its own colour
 * parser, which accepts hex but not `var()`. So the tokens are resolved here, validated, and
 * passed as hex. A token that does not parse is left out, and Mermaid falls back to deriving
 * it from the others. That is less wrong than passing a value it would misread.
 */

import { parseColour, type Rgb } from "../shell/graph-colours.js";

/** Mermaid theme variable → the token it is painted with. */
export const MERMAID_COLOUR_TOKENS = {
  background: "--surface-note",
  mainBkg: "--surface-raised",
  primaryColor: "--surface-raised",
  primaryTextColor: "--text-primary",
  primaryBorderColor: "--text-muted",
  secondaryColor: "--surface-sunken",
  tertiaryColor: "--surface-canvas",
  textColor: "--text-primary",
  lineColor: "--text-muted",
  // Gantt (the reason A38 exists).
  sectionBkgColor: "--surface-raised",
  altSectionBkgColor: "--surface-note",
  sectionBkgColor2: "--surface-sunken",
  gridColor: "--border-subtle",
  taskBkgColor: "--surface-sunken",
  taskBorderColor: "--accent-primary",
  taskTextColor: "--text-primary",
  taskTextDarkColor: "--text-primary",
  taskTextLightColor: "--text-primary",
  taskTextOutsideColor: "--text-primary",
  taskTextClickableColor: "--accent-primary",
  activeTaskBkgColor: "--note-background-blue",
  activeTaskBorderColor: "--accent-primary",
  doneTaskBkgColor: "--surface-raised",
  doneTaskBorderColor: "--text-muted",
  critBkgColor: "--note-background-red",
  critBorderColor: "--state-danger",
  todayLineColor: "--state-warning",
} as const;

/** Reads a style declaration's custom properties; `getComputedStyle` satisfies it. */
export interface TokenSource {
  getPropertyValue(name: string): string;
}

/** The `themeVariables` for Mermaid's `base` theme, from the tokens in scope. */
export function mermaidThemeVariables(tokens: TokenSource): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [variable, token] of Object.entries(MERMAID_COLOUR_TOKENS)) {
    const colour = parseColour(tokens.getPropertyValue(token));
    if (colour !== undefined) variables[variable] = hex(colour);
  }
  const font = tokens.getPropertyValue("--font-ui").trim();
  if (font !== "") variables["fontFamily"] = font;
  return variables;
}

function hex(colour: Rgb): string {
  return `#${colour.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}
