/**
 * The "body not downloaded" state (`SPEC.md` §7.2).
 *
 * §7.2's replication is tiered: metadata for every readable note is eager, bodies arrive on
 * first open. The consequence is stated in the spec "honestly in the UI rather than hidden"
 * — opening a never-before-seen note with no network shows what is known about it and says
 * plainly that the text is not here.
 *
 * **It is a state, not a degraded editor.** Mounting an empty editor over a note that has
 * content on the server invites typing into it, and the merge that follows on reconnect
 * interleaves those words with the body that was there all along — a note that looks
 * destroyed. Refusing to open it is the only answer that cannot lose anything.
 */

import type { ReplicatedNote } from "./db.js";

/** Builds the element that stands in for the editor. */
export function notDownloaded(note: string, metadata: ReplicatedNote | undefined): HTMLElement {
  const element = document.createElement("div");
  element.className = "note-not-downloaded";
  element.setAttribute("role", "status");

  const heading = document.createElement("h2");
  // The metadata tier is exactly what makes this more than an error page: the title is
  // replicated even when the body is not.
  heading.textContent = metadata?.title ?? stripExtension(note);
  element.append(heading);

  const explanation = document.createElement("p");
  explanation.textContent = "This note has not been downloaded to this device.";
  element.append(explanation);

  const next = document.createElement("p");
  next.className = "note-not-downloaded-hint";
  next.textContent = "Open it once while you are online, or pin it, and it will be here next time.";
  element.append(next);

  const where = document.createElement("p");
  where.className = "note-not-downloaded-path";
  where.textContent = note;
  element.append(where);

  return element;
}

function stripExtension(path: string): string {
  return path.replace(/\.md$/, "");
}
