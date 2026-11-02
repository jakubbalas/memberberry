<!--
  Vault settings (`SPEC.md` §20.4): the default theme, the accent colour and the vault's custom
  emoji (§11.2). Offered only to vault owners — the bootstrap says whether to show it, and
  every route behind it re-checks ownership on the server, so this component authorizes
  nothing.

  A `<dialog>` for the reasons `Palette.svelte` gives: focus trapping, Escape and an inert page
  behind it belong to the browser. The request logic lives in `settings.ts`; this file holds
  only which row is being edited and what the server last said.

  **The rename note is not decoration.** Renaming a shortcode rewrites notes the owner may not
  be able to open (E14), and this is the one place that is ever said before it happens.
-->
<script lang="ts">
  import { untrack } from "svelte";

  import { readEmojiImport } from "../editor/emoji-import.js";
  import type { EmojiImportAsset } from "../editor/emoji-import.js";
  import { reloadCustomEmoji } from "../custom-emoji.js";
  import { parseAccent } from "./accent.js";
  import { renameEmoji, renamedMessage } from "./rename.js";
  import {
    addEmoji,
    checkShortcode,
    deleteAlias,
    deleteEmoji,
    loadSettings,
    saveAppearance,
    takenNames,
    type SettingsEmoji,
    type VaultSettings,
  } from "./settings.js";
  import type { ShippedTheme } from "./theme.js";

  interface Props {
    readonly open: boolean;
    readonly vault: string;
    readonly ondismiss: () => void;
    /** Called after the server accepted new appearance, so the window can repaint at once. */
    readonly onappearance: (theme: ShippedTheme, accent: string | undefined) => void;
    readonly fetch?: typeof globalThis.fetch | undefined;
  }

  const { open, vault, ondismiss, onappearance, fetch: fetcher }: Props = $props();
  const request = untrack(() => fetcher ?? globalThis.fetch.bind(globalThis));

  let dialog = $state<HTMLDialogElement | undefined>(undefined);
  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let settings = $state<VaultSettings | undefined>(undefined);
  let loadError = $state<string | undefined>(undefined);
  let busy = $state(false);
  let status = $state("");
  let error = $state<string | undefined>(undefined);

  let theme = $state<ShippedTheme>("system");
  let customAccent = $state(false);
  // why: seeded from the accent on screen when none is stored, so choosing Custom starts from
  // what the owner already sees rather than from an arbitrary colour.
  let accentValue = $state("");

  let pending = $state<EmojiImportAsset | undefined>(undefined);
  let pendingName = $state("");
  let renaming = $state<string | undefined>(undefined);
  let renameName = $state("");
  let confirmingDelete = $state<string | undefined>(undefined);

  let controller: AbortController | undefined;

  const local = $derived(settings?.emoji.filter((entry) => !entry.shared) ?? []);
  const shared = $derived(settings?.emoji.filter((entry) => entry.shared) ?? []);
  const taken = $derived(takenNames(settings?.emoji ?? []));

  function themeAccent(): string {
    return parseAccent(getComputedStyle(document.documentElement).getPropertyValue("--accent-primary").trim()) ?? "";
  }

  async function refresh(signal: AbortSignal): Promise<void> {
    try {
      const loaded = await loadSettings(vault, signal, request);
      if (signal.aborted) return;
      settings = loaded;
      loadError = undefined;
    } catch (caught) {
      if (signal.aborted) return;
      loadError = caught instanceof Error ? caught.message : "Settings could not be loaded.";
    }
  }

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      settings = undefined;
      loadError = undefined;
      status = "";
      error = undefined;
      pending = undefined;
      renaming = undefined;
      confirmingDelete = undefined;
      element.showModal();
      void refresh(current.signal).then(() => {
        if (current.signal.aborted || settings === undefined) return;
        theme = settings.theme;
        customAccent = settings.accent !== undefined;
        accentValue = settings.accent ?? themeAccent();
      });
    }
    if (!open && element.open) element.close();
  });

  $effect(() => () => { controller?.abort(); });

  /** Runs one change, reporting success in the live region and failure as an alert. */
  async function perform(action: (signal: AbortSignal) => Promise<string>): Promise<void> {
    const signal = controller?.signal;
    if (busy || signal === undefined) return;
    busy = true;
    error = undefined;
    status = "";
    try {
      const message = await action(signal);
      if (signal.aborted) return;
      status = message;
    } catch (caught) {
      if (signal.aborted) return;
      error = caught instanceof Error ? caught.message : "That did not work.";
    } finally {
      if (!signal.aborted) busy = false;
    }
  }

  function saveTheme(event: Event): void {
    event.preventDefault();
    const accent = customAccent ? parseAccent(accentValue) : undefined;
    if (customAccent && accent === undefined) {
      error = "Choose an accent colour.";
      return;
    }
    void perform(async (signal) => {
      await saveAppearance(vault, theme, accent, signal, request);
      onappearance(theme, accent);
      return "Appearance saved for everyone in this vault.";
    });
  }

  async function changed(signal: AbortSignal, message: string): Promise<string> {
    reloadCustomEmoji(vault);
    await refresh(signal);
    return message;
  }

  async function chooseFile(): Promise<void> {
    const files = fileInput?.files === null || fileInput?.files === undefined ? [] : [...fileInput.files];
    if (fileInput !== undefined) fileInput.value = "";
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      error = "Choose one image.";
      return;
    }
    const asset = await readEmojiImport(file);
    if (asset === undefined) {
      error = "Choose a non-empty PNG, GIF, JPEG or WebP image.";
      return;
    }
    error = undefined;
    pending = asset;
    pendingName = asset.shortcode;
  }

  function add(event: Event): void {
    event.preventDefault();
    const asset = pending;
    if (asset === undefined) return;
    const checked = checkShortcode(pendingName, taken);
    if ("error" in checked) {
      error = checked.error;
      return;
    }
    const extension = asset.file.split(".").pop() ?? "png";
    const named = { ...asset, shortcode: checked.shortcode, file: `${checked.shortcode}.${extension}` };
    void perform(async (signal) => {
      await addEmoji(vault, named, signal, request);
      pending = undefined;
      return changed(signal, `Added :${named.shortcode}:.`);
    });
  }

  function startRename(entry: SettingsEmoji): void {
    renaming = entry.shortcode;
    renameName = entry.shortcode;
    confirmingDelete = undefined;
    error = undefined;
  }

  function rename(event: Event, entry: SettingsEmoji): void {
    event.preventDefault();
    const checked = checkShortcode(renameName, taken, entry);
    if ("error" in checked) {
      error = checked.error;
      return;
    }
    void perform(async (signal) => {
      const result = await renameEmoji(vault, entry.shortcode, checked.shortcode, { fetch: request });
      if ("refused" in result) throw new Error(result.refused);
      renaming = undefined;
      return changed(signal, `${renamedMessage(result.ok)} :${entry.shortcode}: still works as an alias.`);
    });
  }

  function remove(entry: SettingsEmoji): void {
    void perform(async (signal) => {
      await deleteEmoji(vault, entry.shortcode, signal, request);
      confirmingDelete = undefined;
      return changed(signal, `Deleted :${entry.shortcode}:. Notes keep the text :${entry.shortcode}:.`);
    });
  }

  function removeAlias(entry: SettingsEmoji, alias: string): void {
    void perform(async (signal) => {
      await deleteAlias(vault, entry.shortcode, alias, signal, request);
      return changed(signal, `Removed the alias :${alias}:.`);
    });
  }
</script>

<dialog
  class="settings-dialog"
  aria-labelledby="settings-title"
  bind:this={dialog}
  onclose={ondismiss}
  onclick={(event) => { if (event.target === dialog) ondismiss(); }}
>
  <div class="settings-body">
    <header class="settings-header">
      <h2 class="rename-title" id="settings-title">Vault settings</h2>
      <button type="button" class="rename-cancel" onclick={ondismiss}>Close</button>
    </header>

    {#if loadError !== undefined}
      <p class="rename-error" role="alert">{loadError}</p>
    {:else if settings === undefined}
      <p class="settings-note">Loading settings…</p>
    {:else}
      <section class="settings-section" aria-labelledby="settings-appearance">
        <h3 class="settings-heading" id="settings-appearance">Appearance</h3>
        <p class="settings-note">The vault default for everyone. Each device can still choose its own theme from the top bar.</p>
        <form class="settings-form" onsubmit={saveTheme}>
          <label class="rename-field">
            <span class="rename-label">Default theme</span>
            <select class="rename-input" bind:value={theme} disabled={busy}>
              <option value="system">System</option>
              <option value="memberberry-light">Paper · Light</option>
              <option value="memberberry-dark">Charcoal · Dark</option>
              <option value="memberberry-pastel">Pastel · Dark</option>
            </select>
          </label>
          <fieldset class="settings-fieldset" disabled={busy}>
            <legend class="rename-label">Accent colour</legend>
            <label class="settings-choice">
              <input type="radio" name="accent-mode" value={false} bind:group={customAccent} />
              Theme default
            </label>
            <label class="settings-choice">
              <input type="radio" name="accent-mode" value={true} bind:group={customAccent} />
              Custom
              <input class="settings-colour" type="color" aria-label="Custom accent colour" bind:value={accentValue} disabled={!customAccent} />
            </label>
            <p class="settings-note">Lightened or darkened where needed so text stays readable in every theme.</p>
          </fieldset>
          <div class="rename-actions">
            <button type="submit" class="rename-confirm" disabled={busy}>Save appearance</button>
          </div>
        </form>
      </section>

      <section class="settings-section" aria-labelledby="settings-emoji">
        <h3 class="settings-heading" id="settings-emoji">Custom emoji</h3>
        <p class="settings-note">Renaming rewrites the shortcode in every note in this vault, including notes you cannot open. The old name keeps working as an alias. Deleting removes the image; notes keep the text.</p>

        {#if pending === undefined}
          <div class="rename-actions settings-start">
            <button type="button" class="rename-cancel" disabled={busy} onclick={() => fileInput?.click()}>Add emoji…</button>
          </div>
        {:else}
          <form class="settings-form settings-inline" onsubmit={add}>
            <label class="rename-field">
              <span class="rename-label">Shortcode for the new emoji</span>
              <input class="rename-input" type="text" autocomplete="off" spellcheck="false" bind:value={pendingName} disabled={busy} />
            </label>
            <div class="rename-actions">
              <button type="button" class="rename-cancel" disabled={busy} onclick={() => { pending = undefined; }}>Cancel</button>
              <button type="submit" class="rename-confirm" disabled={busy}>Add</button>
            </div>
          </form>
        {/if}
        <input bind:this={fileInput} type="file" hidden accept="image/gif,image/jpeg,image/png,image/webp" onchange={() => void chooseFile()} />

        {#if local.length === 0}
          <p class="settings-note">This vault has no custom emoji yet.</p>
        {:else}
          <ul class="settings-emoji-list" aria-label="This vault's emoji">
            {#each local as entry (entry.shortcode)}
              <li class="settings-emoji-row">
                <img class="settings-emoji-image" src={entry.imageUrl} alt="" />
                {#if renaming === entry.shortcode}
                  <form class="settings-inline" onsubmit={(event) => rename(event, entry)}>
                    <label class="rename-field">
                      <span class="rename-label">New shortcode for :{entry.shortcode}:</span>
                      <input class="rename-input" type="text" autocomplete="off" spellcheck="false" bind:value={renameName} disabled={busy} />
                    </label>
                    <div class="rename-actions">
                      <button type="button" class="rename-cancel" disabled={busy} onclick={() => { renaming = undefined; }}>Cancel</button>
                      <button type="submit" class="rename-confirm" disabled={busy}>Rename everywhere</button>
                    </div>
                  </form>
                {:else}
                  <div class="settings-emoji-names">
                    <code class="settings-shortcode">:{entry.shortcode}:</code>
                    {#each entry.aliases as alias (alias)}
                      <span class="settings-alias">
                        <code>:{alias}:</code>
                        <button type="button" class="settings-alias-remove" aria-label={`Remove alias :${alias}:`} disabled={busy} onclick={() => removeAlias(entry, alias)}>×</button>
                      </span>
                    {/each}
                  </div>
                  {#if confirmingDelete === entry.shortcode}
                    <div class="rename-actions">
                      <span class="settings-note">Delete :{entry.shortcode}:?</span>
                      <button type="button" class="rename-cancel" disabled={busy} onclick={() => { confirmingDelete = undefined; }}>Keep</button>
                      <button type="button" class="rename-confirm settings-danger" disabled={busy} onclick={() => remove(entry)}>Delete</button>
                    </div>
                  {:else}
                    <div class="rename-actions">
                      <button type="button" class="rename-cancel" aria-label={`Rename :${entry.shortcode}:`} disabled={busy} onclick={() => startRename(entry)}>Rename</button>
                      <button type="button" class="rename-cancel" aria-label={`Delete :${entry.shortcode}:`} disabled={busy} onclick={() => { confirmingDelete = entry.shortcode; renaming = undefined; }}>Delete</button>
                    </div>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if shared.length > 0}
          <h4 class="rename-label">Shared across the server</h4>
          <p class="settings-note">Managed by a server administrator.</p>
          <ul class="settings-emoji-list" aria-label="Shared emoji">
            {#each shared as entry (entry.shortcode)}
              <li class="settings-emoji-row">
                <img class="settings-emoji-image" src={entry.imageUrl} alt="" />
                <div class="settings-emoji-names">
                  <code class="settings-shortcode">:{entry.shortcode}:</code>
                  {#each entry.aliases as alias (alias)}<code class="settings-alias">:{alias}:</code>{/each}
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if error !== undefined}
      <p class="rename-error" role="alert">{error}</p>
    {/if}
    <p class="settings-note" role="status">{status}</p>
  </div>
</dialog>
