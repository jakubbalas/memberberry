/** Shipped theme selection and per-device vault overrides (`SPEC.md` §20.1). */

export const SHIPPED_THEMES = ["system", "memberberry-light", "memberberry-dark", "memberberry-pastel"] as const;

export type ShippedTheme = (typeof SHIPPED_THEMES)[number];
export type ThemeChoice = "vault" | ShippedTheme;

export type ThemeStorage = Pick<Storage, "getItem" | "setItem"> &
  Partial<Pick<Storage, "removeItem">>;

export const THEME_CHANGE_EVENT = "memberberry-theme-change";

/** Narrows an untrusted string to one of the palettes the application ships. */
export function shippedTheme(value: unknown): ShippedTheme | undefined {
  return typeof value === "string" && SHIPPED_THEMES.includes(value as ShippedTheme)
    ? (value as ShippedTheme)
    : undefined;
}

/** The storage key is vault-scoped because a device may prefer different vault palettes. */
export function themeKey(vault: string): string {
  return `memberberry.theme.${vault}`;
}

/** Reads this device's override, failing back to the vault setting on blocked storage. */
export function readThemeChoice(storage: ThemeStorage | undefined, vault: string): ThemeChoice {
  try {
    return shippedTheme(storage?.getItem(themeKey(vault))) ?? "vault";
  } catch {
    return "vault";
  }
}

/** Persists an override; selecting the vault default removes it. */
export function writeThemeChoice(
  storage: ThemeStorage | undefined,
  vault: string,
  choice: ThemeChoice,
): void {
  try {
    if (choice === "vault") {
      if (storage?.removeItem !== undefined) storage.removeItem(themeKey(vault));
      else storage?.setItem(themeKey(vault), "");
      return;
    }
    storage?.setItem(themeKey(vault), choice);
  } catch {
    // A blocked preference store costs the override, never the workspace.
  }
}

/** Resolves a device choice against the validated default supplied by the vault. */
export function resolveTheme(choice: ThemeChoice, vaultTheme: ShippedTheme): ShippedTheme {
  return choice === "vault" ? vaultTheme : choice;
}

/** Applies a shipped palette without putting note or permission data into storage. */
export function applyTheme(root: HTMLElement, theme: ShippedTheme): void {
  if (theme === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
  root.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
}
