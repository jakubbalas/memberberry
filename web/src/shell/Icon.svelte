<!--
  One chrome icon (`SPEC.md` §8.2).

  Presentational to the point of having no state: the paths live in `icons.ts`, which is a
  plain module a test can read without mounting anything (§4.4).

  `aria-hidden` is not a prop and cannot be turned off. An icon in this shell is always
  beside a label or inside a control that carries its own accessible name — §8.4 — so a name
  here would make a screen reader read the control twice, and a control whose *only* name is
  an icon is a bug the picture cannot fix.
-->
<script lang="ts">
  import { ICON_PATHS, type IconName } from "./icons.js";

  interface Props {
    readonly name: IconName;
    /** An extra class, for the few icons the layout has to place or rotate. */
    readonly variant?: string | undefined;
  }

  const { name, variant }: Props = $props();
  const paths = $derived(ICON_PATHS[name]);
</script>

<svg
  class={variant === undefined ? "mb-icon" : `mb-icon ${variant}`}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each paths as d (d)}
    <path {d} />
  {/each}
</svg>
