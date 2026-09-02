/**
 * Svelte configuration (`SPEC.md` §5.1, decision A1).
 *
 * Deliberately minimal. There is no SvelteKit here — Memberberry serves its own pages from
 * `mb-server` and its own assets from `/assets`, so a meta-framework would add a second
 * router and a second build to a project that already has both.
 *
 * `runes: true` is not a default to be inherited quietly. `AGENTS.md` §4.4 requires runes,
 * and setting it here means a component written in the Svelte 4 store style fails to compile
 * rather than working slightly differently from every component beside it.
 */

/** @type {import("@sveltejs/vite-plugin-svelte").SvelteConfig} */
export default {
  compilerOptions: {
    runes: true,
  },
};
