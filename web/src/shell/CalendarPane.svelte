<!-- The daily-note calendar (`SPEC.md` §15.1, E20). -->
<script lang="ts">
  import type { DailyView } from "./daily.svelte.js";

  interface Props {
    readonly view: DailyView;
    readonly onopen: (path: string) => void;
  }

  const { view, onopen }: Props = $props();
  const today = new Date();
  let month = $state(new Date(today.getFullYear(), today.getMonth(), 1));

  $effect(() => view.ensure());

  const monthLabel = $derived(month.toLocaleDateString(undefined, { month: "long", year: "numeric" }));
  const days = $derived.by(() => {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (start.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, index) => {
      const day = index - offset + 1;
      return day < 1 || day > count ? undefined : `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    });
  });

  function shift(amount: number): void { month = new Date(month.getFullYear(), month.getMonth() + amount, 1); }
</script>

<section class="calendar-pane" aria-labelledby="calendar-heading">
  <div class="calendar-header">
    <h3 class="tree-heading" id="calendar-heading">Daily notes</h3>
    <div class="calendar-nav">
      <button type="button" aria-label="Previous month" onclick={() => shift(-1)}>‹</button>
      <button type="button" aria-label="Next month" onclick={() => shift(1)}>›</button>
    </div>
  </div>
  {#if view.loading}
    <p class="tree-empty">Loading calendar…</p>
  {:else if view.unavailable}
    <p class="tree-empty">Calendar is unavailable for this vault.</p>
  {:else}
    <p class="calendar-month" aria-live="polite">{monthLabel}</p>
    <div class="calendar-grid" role="grid" aria-label={monthLabel}>
      {#each ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as name}
        <span class="calendar-weekday" role="columnheader">{name}</span>
      {/each}
      {#each days as date, index}
        {#if date === undefined}
          <span class="calendar-day is-empty" role="gridcell"></span>
        {:else}
          {@const note = view.note(date)}
          <button type="button" class:has-note={note !== undefined} class="calendar-day" role="gridcell" aria-label={date} disabled={note === undefined} onclick={() => note && onopen(note.path)}>{Number(date.slice(-2))}</button>
        {/if}
      {/each}
    </div>
  {/if}
</section>
