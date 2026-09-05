<!--
  Asking for a new name (`SPEC.md` §6.6).

  A `<dialog>`, for the reasons `Palette.svelte` gives: focus trapping, Escape and an inert
  page behind it belong to the browser rather than to us.

  Two things are worth knowing about what it says. **The warning is not decoration** — a
  rename rewrites notes the person doing it may not be able to read, and telling them so
  before they commit is the only place that fact is ever visible, because §6.9 gives the
  audit log no UI. And **the result line is phrased as "notes you can see"**, because that
  is precisely what the server counted (§6.5).
-->
<script lang="ts">
  interface Props {
    readonly open: boolean;
    /** "Rename note" or "Rename tag" — also the dialog's accessible name. */
    readonly title: string;
    /** What is being renamed, shown so nobody renames the wrong thing from a palette. */
    readonly subject: string;
    readonly label: string;
    /** Prefilled, and selected on open, so typing replaces it. */
    readonly initial: string;
    /** Set while the request is in flight; the form is disabled and says so. */
    readonly busy?: boolean | undefined;
    /** A refusal from the server, or from the client's own check of the typed name. */
    readonly error?: string | undefined;
    readonly onsubmit: (name: string) => void;
    readonly ondismiss: () => void;
  }

  const {
    open,
    title,
    subject,
    label,
    initial,
    busy = false,
    error,
    onsubmit,
    ondismiss,
  }: Props = $props();

  let dialog = $state<HTMLDialogElement | undefined>(undefined);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let name = $state("");

  $effect(() => {
    const element = dialog;
    if (element === undefined) return;
    if (open && !element.open) {
      name = initial;
      element.showModal();
      input?.focus();
      // Selected rather than merely focused: the commonest rename replaces the name outright,
      // and a caret at the end makes that a deletion first.
      input?.select();
    }
    if (!open && element.open) element.close();
  });

  function submit(event: Event): void {
    event.preventDefault();
    if (busy) return;
    onsubmit(name);
  }
</script>

<dialog
  class="rename-prompt"
  aria-label={title}
  bind:this={dialog}
  onclose={ondismiss}
  onclick={(event) => {
    if (event.target === dialog) ondismiss();
  }}
>
  <form class="rename-body" onsubmit={submit}>
    <h2 class="rename-title">{title}</h2>
    <p class="rename-subject">{subject}</p>

    <label class="rename-field">
      <span class="rename-label">{label}</span>
      <input
        class="rename-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        disabled={busy}
        aria-describedby="rename-warning"
        bind:this={input}
        bind:value={name}
      />
    </label>

    <p class="rename-warning" id="rename-warning">
      Inbound links are rewritten across the whole vault, including in notes you cannot see.
    </p>

    {#if error !== undefined}
      <p class="rename-error" role="alert">{error}</p>
    {/if}

    <div class="rename-actions">
      <button type="button" class="rename-cancel" onclick={ondismiss} disabled={busy}>
        Cancel
      </button>
      <button type="submit" class="rename-confirm" disabled={busy}>
        {busy ? "Renaming…" : "Rename"}
      </button>
    </div>
  </form>
</dialog>
