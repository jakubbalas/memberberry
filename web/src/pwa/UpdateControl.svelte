<script lang="ts">
  import { watchAppUpdates } from "./updates.js";
  let { reload }: { readonly reload?: (() => Promise<boolean>) | undefined } = $props();
  let available = $state(false);
  let busy = $state(false);
  let message = $state("");
  $effect(() => {
    const workers = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    const entry = [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[type="module"][src], link[rel="stylesheet"][href]')].map(node => node instanceof HTMLScriptElement ? node.src : node.href);
    if (workers === undefined || entry.length === 0) return;
    return watchAppUpdates({ workers, window, document, entry, available: value => { available = value; } });
  });
  async function update(): Promise<void> {
    if (busy) return;
    busy = true;
    message = "";
    try {
      if (await reload?.() !== true) message = "Reconnect and sync your notes before updating.";
    } catch { message = "Your work is kept here. Try updating again after syncing."; }
    finally { busy = false; }
  }
</script>

{#if available}
  <aside class="app-update" aria-label="Application update">
    <span role="status">Update available</span>
    <button type="button" disabled={busy} onclick={() => void update()}>{busy ? "Checking saved changes…" : "Reload to update"}</button>
    {#if message}<p role="status">{message}</p>{/if}
  </aside>
{/if}

<style>
  .app-update {
    position: fixed;
    z-index: 50;
    bottom: var(--space-5);
    right: var(--space-5);
    max-width: calc(100vw - var(--space-5) * 2);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--surface-raised);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    font: var(--text-sm)/var(--leading-body) var(--font-ui);
  }
  button { min-height: var(--touch-target-min); padding: var(--space-2) var(--space-4); color: var(--text-primary); background: var(--surface-note); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); font: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
  p { flex-basis: 100%; margin: 0; color: var(--text-muted); }
</style>
