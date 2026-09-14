<script lang="ts">
  interface Props {
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly onrename: () => void;
    readonly onopennewtab?: (() => void) | undefined;
    readonly ondelete?: (() => void) | undefined;
    readonly ondismiss: () => void;
  }

  const { open, x, y, onrename, onopennewtab, ondelete, ondismiss }: Props = $props();
  let menu = $state<HTMLElement | undefined>(undefined);

  $effect(() => {
    if (!open) return;
    const onpointerdown = (event: PointerEvent): void => {
      if (menu?.contains(event.target as Node) !== true) ondismiss();
    };
    const onkeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") ondismiss();
    };
    window.addEventListener("pointerdown", onpointerdown);
    window.addEventListener("keydown", onkeydown);
    return () => {
      window.removeEventListener("pointerdown", onpointerdown);
      window.removeEventListener("keydown", onkeydown);
    };
  });
</script>

{#if open}
  <div
    class="note-context-menu"
    role="menu"
    tabindex="-1"
    aria-label="Note actions"
    bind:this={menu}
    style={`left: ${x}px; top: ${y}px`}
  >
    {#if onopennewtab !== undefined}
      <button type="button" role="menuitem" onclick={onopennewtab}>Open in new tab</button>
    {/if}
    <button type="button" role="menuitem" onclick={onrename}>Rename</button>
    {#if ondelete !== undefined}
      <button type="button" role="menuitem" onclick={ondelete}>Delete</button>
    {/if}
  </div>
{/if}
