<script lang="ts">
  interface Props {
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly label?: string;
    readonly onrename?: (() => void) | undefined;
    readonly onopennewtab?: (() => void) | undefined;
    readonly onopenmain?: (() => void) | undefined;
    readonly onmove?: (() => void) | undefined;
    readonly ondelete?: (() => void) | undefined;
    /** Optional note bookmark action; omitted for folder and settings menus. */
    readonly onbookmark?: (() => void) | undefined;
    readonly bookmarked?: boolean;
    /** Device-local settings share the action menu's keyboard and dismissal behavior. */
    readonly options?: readonly { readonly label: string; readonly checked: boolean; readonly ontoggle: () => void }[];
    readonly ondismiss: () => void;
  }

  const { open, x, y, label = "Note actions", onrename, onopennewtab, onopenmain, onmove, ondelete, onbookmark, bookmarked = false, options = [], ondismiss }: Props = $props();
  let menu = $state<HTMLElement | undefined>(undefined);
  let left = $state(0);
  let top = $state(0);
  let opener: Element | null = null;

  function restoreFocus(): void {
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }

  function activate(action: () => void): void {
    // why: restore before the action, so a dialog or main-panel destination keeps its focus.
    restoreFocus();
    action();
    ondismiss();
  }

  $effect(() => {
    if (!open) return;
    opener = document.activeElement;
    const onpointerdown = (event: PointerEvent): void => {
      if (event.target instanceof Node && (menu?.contains(event.target) === true || (opener?.getAttribute("aria-haspopup") === "menu" && opener.contains(event.target)))) return;
      // Native pointer focus may then move to the clicked control; never prevent it.
      restoreFocus();
      ondismiss();
    };
    const onkeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restoreFocus();
        ondismiss();
        return;
      }
      if (!(event.target instanceof Node) || !menu?.contains(event.target)) return;
      if (event.key === "Tab") { restoreFocus(); ondismiss(); return; }
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      if (buttons.length === 0) return;
      const current = buttons.findIndex((button) => button === document.activeElement);
      let next: number;
      if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
      else if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault();
      buttons[next]?.focus();
    };
    window.addEventListener("pointerdown", onpointerdown);
    window.addEventListener("keydown", onkeydown);
    return () => {
      window.removeEventListener("pointerdown", onpointerdown);
      window.removeEventListener("keydown", onkeydown);
    };
  });

  $effect(() => {
    const element = menu;
    if (!open || element === undefined) return;
    const bounds = element.getBoundingClientRect();
    left = Math.max(0, Math.min(x, window.innerWidth - bounds.width));
    top = Math.max(0, Math.min(y, window.innerHeight - bounds.height));
    element.querySelector<HTMLButtonElement>("button")?.focus();
  });
</script>

{#if open}
  <div class="note-context-menu" role="menu" tabindex="-1" aria-label={label} bind:this={menu} style={`left: ${left}px; top: ${top}px`}>
    {#if onopenmain !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(onopenmain)}>Open in main panel</button>
    {/if}
    {#if onopennewtab !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(onopennewtab)}>Open in new tab</button>
    {/if}
    {#if onrename !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(onrename)}>Rename</button>
    {/if}
    {#if onmove !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(onmove)}>Move folder</button>
    {/if}
    {#if ondelete !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(ondelete)}>Delete</button>
    {/if}
    {#if onbookmark !== undefined}
      <button type="button" role="menuitem" tabindex="-1" onclick={() => activate(onbookmark)}>{bookmarked ? "Remove bookmark" : "Add bookmark"}</button>
    {/if}
    {#each options as option (option.label)}
      <button type="button" role="menuitemcheckbox" tabindex="-1" aria-checked={option.checked} onclick={() => activate(option.ontoggle)}><span class="menu-check" aria-hidden="true"></span>{option.label}</button>
    {/each}
  </div>
{/if}
