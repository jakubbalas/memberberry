<!--
  The banner at the top of a recovered note (`SPEC.md` §7.6.7): the note left the server with
  edits made on this computer, and the user chooses what becomes of it. Worded the same for
  every cause, since the app cannot tell them apart and may not ask.
-->
<script lang="ts">
  import { notePathFrom, suggestedName, type RecoveredNote } from "./device-offline.js";

  interface Props {
    readonly note: RecoveredNote;
    /** Places the note: again where it was (`to` absent) or at `to`. A message when refused. */
    readonly onplace: (to?: string) => Promise<string | undefined>;
  }

  const { note, onplace }: Props = $props();

  let naming = $state(false);
  let name = $state("");
  let busy = $state(false);
  let message = $state("");

  async function place(to?: string): Promise<void> {
    busy = true;
    message = "";
    message = (await onplace(to)) ?? "";
    busy = false;
  }

  function startNaming(): void {
    message = "";
    name = suggestedName(note);
    naming = true;
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    const to = notePathFrom(name);
    if (to === undefined) {
      message = "Give the note a name.";
      return;
    }
    void place(to);
  }
</script>

<section class="recovered-banner" aria-label="Recovered note">
  <p>This note is no longer available on the server. Your offline edits were kept here.</p>
  <div class="recovered-actions">
    {#if !note.createAgainRefused}
      <button type="button" disabled={busy} onclick={() => void place()}>Create the note again</button>
    {/if}
    {#if !naming}
      <button type="button" disabled={busy} onclick={startNaming}>Make a new note</button>
    {/if}
  </div>
  {#if naming}
    <form class="recovered-name" onsubmit={submit}>
      <label for="recovered-name-input">Name, with a folder if you want one</label>
      <input id="recovered-name-input" bind:value={name} disabled={busy} />
      <button type="submit" disabled={busy}>Create</button>
      <button type="button" disabled={busy} onclick={() => (naming = false)}>Cancel</button>
    </form>
  {/if}
  <p class="recovered-message" role="status">{message}</p>
</section>
