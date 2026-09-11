<!--
  The workspace top bar (`SPEC.md` §8.2).

  One thin strip across the whole window holding the four things that are about the *session*
  rather than about a note: which panels are open, which vault this is, quick find, and
  appearance. It exists because the shell had none — the sidebar toggles were full-width text
  buttons at the top of each panel, the vault link was a caption inside the navigation
  panel, and the theme control was a form card in the context panel, so three unrelated
  concerns each invented their own chrome and the window had no anchor.

  It is deliberately not a toolbar for the note. Everything that acts on a document lives
  with the document (§8.2's editor controls), which is what keeps this strip the same height
  and the same shape in every state the application can be in.

  The panel toggles live here rather than inside the panels they open, for the reason they
  always did: a control inside a collapsible region disappears with it, which traps a
  keyboard user in a shell with no way to bring the panel back. Their accessible names are
  the same ones they had — "Show Navigation", "Hide Context" — because those names are what
  a person reads out to describe what they clicked, and renaming a control that already
  works is a change with cost and no benefit.
-->
<script lang="ts">
  import Icon from "./Icon.svelte";
  import ThemePicker from "./ThemePicker.svelte";
  import type { ShippedTheme, ThemeStorage } from "./theme.js";

  interface Props {
    /** The vault this window is showing, as its slug — what the URL says (§6.1). */
    readonly vault: string;
    readonly leftCollapsed: boolean;
    readonly rightCollapsed: boolean;
    readonly ontoggle: (side: "left" | "right") => void;
    /** Opens the quick switcher (§8.4). The keystroke is the same command. */
    readonly onfind?: (() => void) | undefined;
    /**
     * How that keystroke is written on this platform, e.g. `⌘O`.
     *
     * Shown beside the label, and both are hidden on a phone — which is why the control
     * carries `aria-label`. A `display: none` on the label removes it from the accessible
     * name too, and the first browser run of `e2e/topbar.spec.ts` found the button nameless
     * in the mobile project.
     */
    readonly findHint?: string | undefined;
    readonly vaultTheme?: ShippedTheme | undefined;
    readonly themeStorage?: ThemeStorage | undefined;
  }

  const {
    vault,
    leftCollapsed,
    rightCollapsed,
    ontoggle,
    onfind,
    findHint,
    vaultTheme,
    themeStorage,
  }: Props = $props();
</script>

<header class="topbar">
  <div class="topbar-side">
    <button
      type="button"
      class="icon-button sidebar-toggle"
      data-side="left"
      aria-expanded={!leftCollapsed}
      aria-controls="sidebar-left"
      aria-label={leftCollapsed ? "Show Navigation" : "Hide Navigation"}
      onclick={() => ontoggle("left")}
    >
      <Icon name="panel-left" />
    </button>

    <a class="topbar-brand" href={`/v/${encodeURIComponent(vault)}`} aria-label="Memberberry home" title="Memberberry · Home">
      <Icon name="vault" />
      <span>Memberberry</span>
    </a>

    <!--
      The vault switcher. A real link to the vault list rather than a menu: it is one
      destination, and §6.1 makes moving between vaults a full navigation so the server
      hands over a fresh ACL, index and layout. The slug is the visible label *and* part of
      the accessible name, so what a screen reader announces contains what the eye reads
      (WCAG 2.5.3) while a test can still ask for "Your vaults".
    -->
    <a class="topbar-vault" href="/">
      <span class="topbar-vault-name">{vault}</span>
      <span class="visually-hidden">· Your vaults</span>
      <Icon name="chevron-down" variant="topbar-vault-caret" />
    </a>
  </div>

  <div class="topbar-side topbar-end">
    {#if onfind !== undefined}
      <button type="button" class="topbar-find" aria-label="Quick find" onclick={() => onfind()}>
        <Icon name="search" />
        <span class="topbar-find-label">Quick find</span>
        {#if findHint !== undefined}<kbd class="topbar-kbd">{findHint}</kbd>{/if}
      </button>
    {/if}

    <ThemePicker {vault} {vaultTheme} storage={themeStorage} />

    <button
      type="button"
      class="icon-button sidebar-toggle"
      data-side="right"
      aria-expanded={!rightCollapsed}
      aria-controls="sidebar-right"
      aria-label={rightCollapsed ? "Show Context" : "Hide Context"}
      onclick={() => ontoggle("right")}
    >
      <Icon name="panel-right" />
    </button>
  </div>
</header>
