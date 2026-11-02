<script lang="ts">
  import { getContext } from "svelte";
  import { EMOJI_VAULT_CONTEXT, customEmojiLookup, observeCustomEmoji, type CustomEmoji, type EmojiVaultContext } from "../custom-emoji.js";

  const { text, vault }: { readonly text: string; readonly vault?: string | undefined } = $props();
  const context = getContext<EmojiVaultContext | undefined>(EMOJI_VAULT_CONTEXT);
  const scope = $derived(vault ?? context?.vault);
  let entries = $state.raw<readonly CustomEmoji[]>([]);
  let failed = $state<ReadonlySet<string>>(new Set());
  $effect(() => {
    entries = []; failed = new Set();
    if (scope === undefined || !text.includes(":")) return;
    return observeCustomEmoji(scope, (value) => { entries = value; });
  });
  const parts = $derived.by(() => {
    const lookup = customEmojiLookup(entries);
    const parts: Array<{ text: string; src?: string }> = [];
    let cursor = 0;
    for (const match of text.matchAll(/:([a-z0-9_+-]+):/gi)) {
      const entry = lookup.get((match[1] ?? "").toLowerCase());
      if (entry === undefined) continue;
      if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) });
      parts.push({ text: match[0], src: entry.imageUrl });
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor) });
    return parts;
  });
  function imageFailed(src: string | undefined): void {
    if (src !== undefined) failed = new Set([...failed, src]);
  }
</script>

{#each parts as part}{#if part.src !== undefined && !failed.has(part.src)}<img class="custom-emoji-image" src={part.src} alt={part.text} draggable="false" onerror={() => imageFailed(part.src)} />{:else}{part.text}{/if}{/each}
