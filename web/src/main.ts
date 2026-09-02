/**
 * The browser entry point.
 *
 * A shim, the same role `mb-cli/src/main.rs` plays: it finds the mount element, reads what
 * the server said about the page, and hands both to Svelte. Everything worth testing is in
 * the modules it calls, which is why this file is excluded from coverage.
 */

import { mount } from "svelte";

import NoteWorkspace from "./shell/NoteWorkspace.svelte";
import { readNoteBootstrap } from "./shell/bootstrap.js";

const target = document.querySelector<HTMLElement>("#app");
if (target === null) {
  throw new Error("the page is missing its #app mount element");
}

mount(NoteWorkspace, {
  target,
  // `undefined` on the Vite dev server, which serves `index.html` with the attributes still
  // empty. The editor then runs against a purely local replica (`SPEC.md` §3.1, layer 2).
  props: { bootstrap: readNoteBootstrap(target) },
});
