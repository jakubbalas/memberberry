<script lang="ts">
  import { watchInstallation } from "./install.js";
  let available = $state(false);
  let install = $state<(() => Promise<void>) | undefined>();
  $effect(() => {
    const controller = watchInstallation(window, window.matchMedia?.("(display-mode: standalone)").matches ?? false, value => { available = value; });
    install = controller.install;
    return () => controller.destroy();
  });
</script>

{#if available}
  <button type="button" class="install-app" aria-label="Install Memberberry" onclick={() => void install?.()}>Install</button>
{/if}

<style>
  .install-app {
    color: var(--text-primary);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
    font: inherit;
    min-height: var(--touch-target-min);
    cursor: pointer;
  }
  .install-app:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
</style>
