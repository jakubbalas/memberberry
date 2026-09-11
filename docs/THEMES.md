# Themes

Choose **Theme** in the top bar, beside quick find. Paper is a neutral light notebook;
Charcoal is a neutral dark workspace; Pastel is a lavender dark palette inspired by
Catppuccin. System follows the operating system's light/dark setting. Vault default
removes this device's override. Choices are remembered separately for each vault.

Set a shared default in the vault's `.memberberry/config.toml`:

```toml
theme = "memberberry-pastel"
```

The other names are `memberberry-light`, `memberberry-dark`, and `system`.

## Editing a palette

`web/src/shell/tokens.css` is the only source of colour values, including the
server-rendered pages. Edit the selected `:root[data-theme="…"]` block. For Paper
and Charcoal, also update the corresponding base/system values. Layout and font
tokens are shared across palettes. Change `--font-title` to give headings a different
character, or `--editor-measure` to change the writing column.

`--surface-canvas` is the chrome — the top bar, the sidebars, the strip behind the tabs —
and `--surface-note` is the document. Those two carry the shell's whole sense of depth, so a
palette that gives them the same value produces a window with no structure in it.

Use the four `--surface-*` roles for page, paper, controls and recessed areas;
`--text-primary` and `--text-muted` for text; `--accent-primary` for links and emphasis.
Keep warning, danger and conflict distinct. The six `--series-*` colours are shared
by graph categories and collaborative cursors. Hover colours derive from these roles.

## Adding a shipped palette

1. Copy an explicit palette block in `tokens.css`, give it a new `data-theme` name,
   and set every colour role plus `color-scheme`. Keep component CSS unchanged.
2. Register the name in `SHIPPED_THEMES` in `web/src/shell/theme.ts`, add its option
   and default label in `ThemePicker.svelte`, and allow it in `Vault::theme()` in
   `crates/mb-server/src/vault.rs`.
3. Extend the palette cases in `tokens.test.ts` and `web/e2e/theme.spec.ts`, plus
   the server theme validation test. These verify contrast, persistence and actual
   rendering on desktop and mobile. Update `SPEC.md` §20.
4. Run `make check` and `make e2e`. Inspect the screenshots produced by the theme
   browser tests under `web/test-results/`.

Body/UI colours need 4.5:1 contrast against all four surfaces, focus rings need
3:1, and presence labels need 4.5:1 against every series colour. Token names are
the versioned public API; component classes and markup are not.

Automatic discovery/loading of vault-local custom CSS is not implemented yet.
Adding a shipped palette through the steps above works today.
