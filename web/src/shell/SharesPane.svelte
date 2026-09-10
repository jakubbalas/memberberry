<script lang="ts">
  import type { CreatedShareLink, ShareView } from "./shares.js";

  interface Props {
    readonly view: ShareView;
    readonly note?: string | undefined;
  }

  const { view, note }: Props = $props();
  let notePath = $state("");
  let includeEmbeds = $state(false);
  let password = $state("");
  let expiryDate = $state("");
  let neverExpires = $state(false);
  let creating = $state(false);
  let message = $state<string | undefined>(undefined);
  let createdUrl = $state<string | undefined>(undefined);
  let revision = $state(0);
  let loading = $state(true);

  $effect(() => {
    void load();
  });

  $effect(() => {
    if (note !== undefined) notePath = note;
  });

  async function load(): Promise<void> {
    loading = true;
    try {
      await view.refresh();
      revision += 1;
    } finally {
      loading = false;
    }
  }

  async function create(): Promise<void> {
    if (notePath.trim() === "") return;
    creating = true;
    message = undefined;
    createdUrl = undefined;
    const expiresAt = expiryDate === "" ? undefined : Math.floor(new Date(`${expiryDate}T23:59:59`).getTime() / 1000);
    let created: CreatedShareLink | undefined;
    try {
      created = await view.create({
        note: notePath.trim(),
        include_embeds: includeEmbeds,
        ...(password === "" ? {} : { password }),
        ...(neverExpires ? { never_expires: true } : {}),
        ...(!neverExpires && expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      });
      revision += 1;
    } finally {
      creating = false;
    }
    if (created === undefined) {
      message = "Could not create this share.";
      return;
    }
    password = "";
    createdUrl = created.url;
    message = "Share created. Copy the URL now; it is not shown again for security.";
  }

  async function copy(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(new URL(url, globalThis.location.origin).toString());
      message = "Share URL copied.";
    } catch {
      message = "Copy failed; select the URL to copy it manually.";
    }
  }

  async function copyCreated(): Promise<void> {
    if (createdUrl !== undefined) await copy(createdUrl);
  }

  async function revoke(id: number): Promise<void> {
    if (await view.revoke(id)) { revision += 1; message = "Share revoked."; }
    else message = "Could not revoke this share.";
  }

  const date = (seconds: number): string => new Date(seconds * 1000).toLocaleDateString();
</script>

<section class="shares-pane" aria-labelledby="shares-heading" data-revision={revision} aria-busy={loading}>
  <h3 class="tree-heading" id="shares-heading">Public shares</h3>
  <form class="share-create" onsubmit={(event) => { event.preventDefault(); void create(); }}>
    <label for="share-note">Note</label>
    <input id="share-note" bind:value={notePath} placeholder="Note path" autocomplete="off" />
    <label for="share-password">Password (optional)</label>
    <input id="share-password" type="password" bind:value={password} autocomplete="new-password" />
    <label for="share-expiry">Expiration (optional)</label>
    <input id="share-expiry" type="date" bind:value={expiryDate} disabled={neverExpires} />
    <label class="share-checkbox"><input type="checkbox" bind:checked={neverExpires} /> Never expires</label>
    {#if neverExpires}<p class="tree-empty" role="note">Never-expiring links stay active until revoked.</p>{/if}
    <label class="share-checkbox"><input type="checkbox" bind:checked={includeEmbeds} /> Include embeds</label>
    <button type="submit" disabled={creating || notePath.trim() === ""}>{creating ? "Creating…" : "Create share"}</button>
  </form>
  {#if message}<p class="tree-empty" aria-live="polite">{message}</p>{/if}
  {#if createdUrl !== undefined}
    <div class="share-created">
      <label for="created-share-url">New share URL</label>
      <input id="created-share-url" readonly value={createdUrl} />
      <button type="button" onclick={() => void copyCreated()}>Copy new URL</button>
    </div>
  {/if}
  {#if loading}<p class="tree-empty">Loading shares…</p>
  {:else if view.unavailable}<p class="tree-empty">Shares are unavailable for this vault.</p>
  {:else if view.empty}<p class="tree-empty">No public shares yet.</p>
  {:else}
    <ul class="share-list">
      {#each view.links as link (link.id)}
        <li class="share-row">
          <span class="share-note">{link.note}</span>
          <span class="share-meta">{link.expires_at === null ? "Never expires" : `Expires ${date(link.expires_at)}`} · {link.access_count} views{link.password_protected ? " · password" : ""}</span>
          <div class="share-actions">
            <button type="button" onclick={() => void revoke(link.id)}>Revoke</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
