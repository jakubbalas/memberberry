<script lang="ts">
  import { fetchVaults, type VaultSummary } from "../shell/catalog.js";
  import { submitSharedClip, type SharedClipDraft } from "./share-target.js";
  import { deletePendingShare } from "./share-inbox.js";

  interface Props { readonly draft: SharedClipDraft; }
  let { draft }: Props = $props();
  let vaults = $state<readonly VaultSummary[]>([]);
  let vault = $state("");
  let folder = $state("Clips");
  let status = $state("Loading vaults…");

  $effect(() => {
    let active = true;
    void fetchVaults().then((available) => {
      if (!active) return;
      vaults = available;
      vault = available[0]?.slug ?? "";
      status = available.length === 0 ? "No readable vaults." : "Ready to clip.";
    }).catch(() => {
      if (active) status = "Vaults are unavailable.";
    });
    return () => { active = false; };
  });

  async function submit(): Promise<void> {
    if (vault === "") return;
    status = "Clipping…";
    try {
      const result = await submitSharedClip(draft, { vault, folder });
      if (draft.pendingId !== undefined) {
        await deletePendingShare(draft.pendingId, indexedDB);
      }
      status = `Clipped to ${result.path}`;
    } catch {
      status = "Clip refused or unavailable.";
    }
  }
</script>

<main class="share-target" aria-labelledby="share-title">
  <h1 id="share-title">Clip to Memberberry</h1>
  <p>{draft.title ?? draft.url ?? draft.text ?? "Shared images"}</p>
  {#if (draft.files?.length ?? 0) > 0}<p>{draft.files?.length} shared image{draft.files?.length === 1 ? "" : "s"}</p>{/if}
  <label>Vault
    <select bind:value={vault} disabled={vaults.length === 0}>
      {#each vaults as item}<option value={item.slug}>{item.name}</option>{/each}
    </select>
  </label>
  <label>Folder <input bind:value={folder} /></label>
  <button type="button" onclick={() => void submit()} disabled={vault === ""}>Save clip</button>
  <p role="status">{status}</p>
</main>

<style>
  .share-target { display: grid; gap: var(--space-5); width: min(100% - var(--space-8), 34rem); margin: 8vh auto; padding: var(--space-7); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-note); box-shadow: var(--shadow-lg); }
  h1, p { margin: 0; }
  label { display: grid; gap: var(--space-2); color: var(--text-muted); font: var(--weight-bold) var(--text-sm)/var(--leading-body) var(--font-ui); }
  input, select, button { min-height: var(--touch-target-min); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: var(--space-3) var(--space-4); color: var(--text-primary); background: var(--surface-raised); font: var(--text-md)/var(--leading-body) var(--font-ui); }
  button { color: var(--surface-note); background: var(--accent-primary); cursor: pointer; }
  button:disabled { cursor: default; opacity: .55; }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); }
</style>
