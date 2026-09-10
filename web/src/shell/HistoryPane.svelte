<script lang="ts">
  import type { DiffPart, HistoryDiff, HistoryVersion, HistoryView } from "./history.js";

  interface Props { readonly view: HistoryView; readonly note?: string | undefined; }
  const { view, note }: Props = $props();
  let revision = $state(0);
  let selected = $state<readonly string[]>([]);
  let preview = $state<{ readonly version: string; readonly text: string } | undefined>(undefined);
  let diff = $state<HistoryDiff | undefined>(undefined);
  let message = $state<string | undefined>(undefined);
  let versions = $state<readonly HistoryVersion[]>([]);
  let loading = $state(false);
  let unavailable = $state(false);

  $effect(() => {
    selected = [];
    preview = undefined;
    diff = undefined;
    message = undefined;
    if (note === undefined) { view.clear(); versions = []; loading = false; unavailable = false; return; }
    loading = true;
    void view.refresh(note).then(() => {
      versions = [...view.versions];
      loading = view.loading;
      unavailable = view.unavailable;
      revision += 1;
    });
  });

  async function show(version: string): Promise<void> {
    if (note === undefined) return;
    const text = await view.read(note, version);
    preview = text === undefined ? undefined : { version, text };
    message = text === undefined ? "That version is unavailable." : undefined;
    revision += 1;
  }

  function select(version: string): void {
    selected = selected.includes(version)
      ? selected.filter((id) => id !== version)
      : selected.length < 2 ? [...selected, version] : [selected[1] ?? version, version];
    diff = undefined;
  }

  async function compare(): Promise<void> {
    if (note === undefined || selected.length !== 2) return;
    diff = await view.diff(note, selected[0] ?? "", selected[1] ?? "");
    message = diff === undefined ? "Those versions are unavailable." : undefined;
    revision += 1;
  }

  async function restore(version: string): Promise<void> {
    if (note === undefined) return;
    if (await view.restore(note, version)) {
      message = "Version restored as an edit.";
      await view.refresh(note);
      versions = [...view.versions];
    } else {
      message = "Could not restore that version.";
    }
    revision += 1;
  }

  const date = (seconds: number): string => new Date(seconds * 1000).toLocaleString();
  const delta = (bytes: number): string => bytes === 0 ? "±0" : `${bytes > 0 ? "+" : ""}${bytes}`;
  const partClass = (part: DiffPart): string => `history-diff-${part.kind}`;
</script>

<section class="history-pane" aria-labelledby="history-heading" data-revision={revision} aria-busy={loading}>
  <h3 class="tree-heading" id="history-heading">History</h3>
  {#if note === undefined}
    <p class="tree-empty">Open a note to see its versions.</p>
  {:else if loading}
    <p class="tree-empty">Loading history…</p>
  {:else if unavailable}
    <p class="tree-empty">History is unavailable for this note.</p>
  {:else if versions.length === 0}
    <p class="tree-empty">No saved versions yet.</p>
  {:else}
    <p class="history-help">Select up to two versions to compare.</p>
    <ul class="history-list">
      {#each versions.slice().reverse() as version (version.id)}
        <li class="history-row">
          <label class="history-select">
            <input type="checkbox" checked={selected.includes(version.id)} onchange={() => select(version.id)} />
            <span><strong>{date(version.timestamp)}</strong><small>{version.actor} · {delta(version.size_delta)} bytes</small></span>
          </label>
          <div class="history-actions">
            <button type="button" onclick={() => void show(version.id)}>Preview</button>
            <button type="button" onclick={() => void restore(version.id)}>Restore</button>
          </div>
        </li>
      {/each}
    </ul>
    <button class="history-compare" type="button" disabled={selected.length !== 2} onclick={() => void compare()}>Compare selected versions</button>
  {/if}
  {#if message}<p class="tree-empty" role="status">{message}</p>{/if}
  {#if preview !== undefined}
    <section class="history-preview" aria-label="Historical Markdown preview"><h4>Preview</h4><pre>{preview.text}</pre></section>
  {/if}
  {#if diff !== undefined}
    <section class="history-diff" aria-label="Version diff"><h4>Diff</h4><pre>{#each diff.parts as part}<span class={partClass(part)}>{part.text}</span>{/each}</pre></section>
  {/if}
</section>
