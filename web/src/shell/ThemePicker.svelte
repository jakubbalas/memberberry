<!--
  The appearance control (`SPEC.md` §20.4).

  A shipped theme is a set of re-declared custom properties and nothing else (§20.2), so
  choosing one is a single value written to one attribute on `<html>` — which is why this is
  a `<select>` in the top bar rather than a settings page. It was a form card in the context
  panel, where it read as a feature of the note rather than of the window.

  The label is visually hidden because the icon and a top bar four controls wide is not the
  place for the word "Theme", but it is a real `<label>`: the control's accessible name is
  still "Theme", and §8.4 does not have an exception for controls that are small.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import Icon from "./Icon.svelte";
  import {
    applyTheme,
    readThemeChoice,
    resolveTheme,
    shippedTheme,
    writeThemeChoice,
    type ShippedTheme,
    type ThemeChoice,
    type ThemeStorage,
  } from "./theme.js";

  interface Props {
    readonly vault: string;
    readonly vaultTheme?: ShippedTheme | undefined;
    readonly storage?: ThemeStorage | undefined;
    readonly root?: HTMLElement | undefined;
  }

  const { vault, vaultTheme = "system", storage, root }: Props = $props();
  // A mounted workspace cannot change vault or device; switching vaults navigates to a new page.
  const preferences = untrack(
    () => storage ?? (typeof localStorage === "undefined" ? undefined : localStorage),
  );
  const themeRoot = untrack(() => root ?? document.documentElement);
  let choice = $state<ThemeChoice>(untrack(() => readThemeChoice(preferences, vault)));

  $effect(() => {
    applyTheme(themeRoot, resolveTheme(choice, vaultTheme));
  });

  function select(event: Event): void {
    const selected = event.currentTarget instanceof HTMLSelectElement
      ? event.currentTarget.value
      : "vault";
    const next: ThemeChoice = selected === "vault" ? "vault" : (shippedTheme(selected) ?? "vault");
    writeThemeChoice(preferences, vault, next);
    choice = next;
  }

  const defaultLabel = $derived(
    vaultTheme === "memberberry-light"
      ? "Paper"
      : vaultTheme === "memberberry-dark"
        ? "Charcoal"
        : vaultTheme === "memberberry-pastel"
          ? "Pastel"
          : "System",
  );
</script>

<div class="theme-panel">
  <Icon name="appearance" />
  <label class="theme-field">
    <span class="visually-hidden">Theme</span>
    <select class="theme-select" value={choice} onchange={select}>
      <option value="vault">Vault default ({defaultLabel})</option>
      <option value="system">System</option>
      <option value="memberberry-light">Paper · Light</option>
      <option value="memberberry-dark">Charcoal · Dark</option>
      <option value="memberberry-pastel">Pastel · Dark</option>
    </select>
  </label>
</div>
