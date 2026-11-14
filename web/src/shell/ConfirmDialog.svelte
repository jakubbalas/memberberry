<!--
  Asking "are you sure?" before a destructive action, such as moving a note to trash (§4.3).

  why: this replaces `window.confirm`. The desktop app's WKWebView has no JavaScript panel
  delegate (wry implements none), and WebKit then answers every `confirm()` with Cancel
  without showing anything, so Delete silently did nothing there (§7.6). A `<dialog>` works the same in
  every engine, and it brings focus trapping, Escape and an inert page, for the reasons
  `Palette.svelte` gives. It reuses `NamePrompt`'s look, so it has no styles of its own.
-->
<script lang="ts">
  interface Props {
    readonly open: boolean;
    /** The question, and the dialog's accessible name. */
    readonly title: string;
    /** What the action applies to, shown so nobody confirms against the wrong thing. */
    readonly subject: string;
    /** Set while the request is in flight; both buttons are disabled and Escape is ignored. */
    readonly busy?: boolean | undefined;
    /** Why the last attempt failed. The dialog stays open so it can be retried or cancelled. */
    readonly error?: string | undefined;
    /** The confirm button's resting label, and the one it shows while busy. */
    readonly confirm: string;
    readonly confirming: string;
    readonly onconfirm: () => void;
    readonly ondismiss: () => void;
  }

  const { open, title, subject, busy = false, error, confirm, confirming, onconfirm, ondismiss }: Props = $props();

  let dialog = $state<HTMLDialogElement | undefined>(undefined);

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  });

  function submit(event: Event): void {
    event.preventDefault();
    if (!busy) onconfirm();
  }
</script>

<dialog
  class="rename-prompt"
  aria-label={title}
  bind:this={dialog}
  onclose={() => { if (open) ondismiss(); }}
  oncancel={(event) => { if (busy) event.preventDefault(); }}
  onclick={(event) => {
    if (event.target === dialog && !busy) ondismiss();
  }}
>
  <form class="rename-body" onsubmit={submit}>
    <h2 class="rename-title">{title}</h2>
    <p class="rename-subject">{subject}</p>
    {#if error !== undefined}
      <p class="rename-error" role="alert">{error}</p>
    {/if}
    <div class="rename-actions">
      <button type="button" class="rename-cancel" onclick={ondismiss} disabled={busy}>Cancel</button>
      <button type="submit" class="rename-confirm" disabled={busy}>{busy ? confirming : confirm}</button>
    </div>
  </form>
</dialog>
