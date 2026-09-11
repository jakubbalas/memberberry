<!--
  The global graph (`SPEC.md` §9.4).

  The whole readable vault at once: WebGL for the dots and lines, a 2D canvas over it for the
  labels and icons §9.4 wants above a zoom threshold, and a force layout running in a Web
  Worker so none of it competes with the keystroke path (§21.3).

  This file is wiring and no decisions. Where the nodes go is `graph-force.ts`, where the
  camera is looking is `graph-camera.ts`, what a key means is `graph-keys.ts`, what a filter
  hides is `graph-filters.ts`, and what is on screen at all is `vault-graph.svelte.ts` —
  every one of them testable without a canvas, which matters because jsdom has no WebGL and
  lays nothing out. `web/e2e/global-graph.spec.ts` is what says this appears.

  Everything here arrives permission-filtered (E9). There is no filtering in this file and
  there must never be one.
-->
<script lang="ts">
  import {
    labelledNodes,
    labelsVisible,
    nodeRadius,
    panBy,
    screenToWorld,
    worldToScreen,
    zoomAt,
  } from "./graph-camera.js";
  import { type GraphFilters, NO_FILTERS, filtersAreActive } from "./graph-filters.js";
  import { type GraphColours, SERIES_COLOURS, readColours } from "./graph-colours.js";
  import { GraphRenderer } from "./graph-gl.js";
  import { graphKeyAction } from "./graph-keys.js";
  import { Quadtree } from "./graph-quadtree.js";
  import type { VaultGraphView } from "./vault-graph.svelte.js";
  import { folderOf } from "./vault-graph.js";
  import { THEME_CHANGE_EVENT } from "./theme.js";

  interface Props {
    readonly view: VaultGraphView;
    readonly onopen: (path: string) => void;
    readonly onclose: () => void;
  }

  const { view, onopen, onclose }: Props = $props();

  let frame: HTMLDivElement | undefined = $state();
  let gl: HTMLCanvasElement | undefined = $state();
  let overlay: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  let showFilters = $state(false);
  let renderer: GraphRenderer | undefined;
  let colours: GraphColours | undefined;
  let themeRevision = $state(0);
  /** The label font and colour, resolved once: reading them per frame forces a style recalc. */
  let labelStyle: { colour: string; font: string } | undefined;
  const tree = new Quadtree();

  const nodes = $derived(view.nodes);
  const pixelRatio = $derived(typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

  /**
   * A colour index per folder (§9.4).
   *
   * Sorted, so the colour a folder gets depends on the folder rather than on which note came
   * back first — the same rule the local graph's palette follows, for the same reason.
   */
  const palette = $derived(
    new Map(
      [...new Set(nodes.map((node) => folderOf(node) ?? ""))]
        .sort()
        .map((folder, index) => [folder, index % SERIES_COLOURS] as const),
    ),
  );

  /**
   * The per-node arrays the shader reads, which depend on the *nodes* and not on where the
   * layout has pushed them — so they survive every frame of a settling simulation.
   */
  const shades = $derived.by(() => {
    const colour = new Uint8Array(nodes.length);
    const ghost = new Uint8Array(nodes.length);
    nodes.forEach((node, at) => {
      colour[at] = palette.get(folderOf(node) ?? "") ?? 0;
      ghost[at] = node.path === null ? 1 : 0;
    });
    return { colour, ghost };
  });

  const radii = $derived.by(() => {
    const largest = view.largest;
    const out = new Float32Array(nodes.length);
    nodes.forEach((node, at) => {
      out[at] = nodeRadius(view.sizeBy === "words" ? node.words : node.degree, largest, view.sizeBy);
    });
    return out;
  });

  const selectedNode = $derived(view.selected >= 0 ? nodes[view.selected] : undefined);

  // why: in an effect rather than at the top of the module. `load` is idempotent once it has
  // an answer, and reading `view` during setup captures it before the component is alive.
  $effect(() => {
    view.load();
  });

  $effect(() => {
    if (frame === undefined) return;
    const element = frame;
    const measure = (): void => {
      width = element.clientWidth;
      height = element.clientHeight;
      view.resize(width, height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  });

  $effect(() => {
    if (gl === undefined) return;
    colours = readColours(gl);
    renderer = GraphRenderer.create(gl, colours);
    const root = document.documentElement;
    const system = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : undefined;
    const refresh = (): void => {
      if (gl === undefined || renderer === undefined) return;
      colours = readColours(gl);
      renderer.setColours(colours);
      labelStyle = undefined;
      themeRevision += 1;
    };
    root.addEventListener(THEME_CHANGE_EVENT, refresh);
    system?.addEventListener("change", refresh);
    return () => {
      root.removeEventListener(THEME_CHANGE_EVENT, refresh);
      system?.removeEventListener("change", refresh);
      renderer?.dispose();
      renderer = undefined;
    };
  });

  $effect(() => () => {
    view.dispose();
  });

  /**
   * What was last uploaded to the GPU, so a camera move does not re-upload it.
   *
   * why: measured. §21.2's graph row was **91.6 ms** a frame at ten thousand nodes when every
   * frame rebuilt and re-uploaded every buffer; a pan or a zoom changes three uniforms and no
   * geometry at all. The arrays are replaced wholesale rather than mutated — the layout posts
   * new ones, the filters produce new ones — so identity is a sound test for "this changed".
   */
  let uploaded: { x: Float32Array; radius: Float32Array; edges: Uint32Array } | undefined;
  // why: one effect that reads everything the picture depends on and repaints. Svelte's
  // reactivity is what decides *when* — there is no animation loop here, because a settled
  // layout should cost nothing and a frame that changed nothing should not be drawn.
  $effect(() => {
    void themeRevision;
    const x = view.x;
    const y = view.y;
    const camera = view.camera;
    const selected = view.selected;
    const sizes = radii;
    const edges = view.edges;
    if (gl === undefined || overlay === undefined || width === 0 || height === 0) return;

    const scaled = (canvas: HTMLCanvasElement): void => {
      const w = Math.max(1, Math.round(width * pixelRatio));
      const h = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    };
    scaled(gl);
    scaled(overlay);

    const count = Math.min(nodes.length, x.length, y.length);
    const moved =
      uploaded === undefined ||
      uploaded.x !== x ||
      uploaded.radius !== sizes ||
      uploaded.edges !== edges;

    if (moved) {
      // The quadtree is over the positions, so it is stale exactly when they are — and
      // rebuilding it on a pan would be ten thousand insertions to answer a question nobody
      // asked.
      tree.build(x, y, count);
      renderer?.setGeometry({ x, y, radius: sizes, ...shades, edges, count });
      uploaded = { x, radius: sizes, edges };
    }
    renderer?.draw(camera, width, height, pixelRatio, selected);

    const context = overlay.getContext("2d");
    if (context === null) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!labelsVisible(camera)) return;
    // §9.4's level of detail: names only when a reader is close enough for them to mean
    // something, and never more than a screenful of them.
    //
    // No literal fallback for the colour: a hard-coded one is a bug (`AGENTS.md` §4.4), and
    // an unresolved token assigns nothing rather than throwing — which is a missing token
    // showing up as text in the wrong colour rather than as a picture with no labels.
    labelStyle ??= {
      colour: getComputedStyle(overlay).getPropertyValue("--text-primary"),
      font: `12px ${getComputedStyle(overlay).getPropertyValue("--font-ui") || "sans-serif"}`,
    };
    context.fillStyle = labelStyle.colour;
    context.font = labelStyle.font;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    for (const at of labelledNodes(camera, width, height, x, y, sizes, count)) {
      const node = nodes[at];
      if (node === undefined) continue;
      const place = worldToScreen(camera, width, height, x[at] ?? 0, y[at] ?? 0);
      const offset = (sizes[at] ?? 0) * camera.scale + 4;
      if (node.icon !== null && node.icon !== "") {
        context.textBaseline = "middle";
        context.fillText(node.icon, place.x, place.y);
        context.textBaseline = "bottom";
      }
      context.fillText(node.label, place.x, place.y - offset);
    }
  });

  /** The node under a point on screen, or `-1`. */
  function nodeAt(clientX: number, clientY: number): number {
    if (frame === undefined) return -1;
    const box = frame.getBoundingClientRect();
    const world = screenToWorld(view.camera, width, height, clientX - box.left, clientY - box.top);
    // A pointer-sized radius in world units, so the target is the same size on screen at
    // every zoom — and generous enough to hit a dot that is two pixels across.
    return tree.find(world.x, world.y, 12 / view.camera.scale);
  }

  let dragging = false;
  let moved = false;
  let lastX = 0;
  let lastY = 0;

  function onpointerdown(event: PointerEvent): void {
    dragging = true;
    moved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    if (event.target instanceof Element) event.target.setPointerCapture(event.pointerId);
  }

  function onpointermove(event: PointerEvent): void {
    if (!dragging) {
      const at = nodeAt(event.clientX, event.clientY);
      if (at !== view.selected) view.select(at);
      return;
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    lastX = event.clientX;
    lastY = event.clientY;
    view.setCamera(panBy(view.camera, dx, dy));
  }

  function onpointerup(event: PointerEvent): void {
    if (event.target instanceof Element && event.target.hasPointerCapture(event.pointerId)) {
      event.target.releasePointerCapture(event.pointerId);
    }
    const wasDragging = dragging;
    dragging = false;
    // A drag is not a click. Without this, letting go after panning opens whatever note
    // happened to be under the finger.
    if (!wasDragging || moved) return;
    const at = nodeAt(event.clientX, event.clientY);
    view.select(at);
    open(at);
  }

  function onwheel(event: WheelEvent): void {
    if (frame === undefined) return;
    event.preventDefault();
    const box = frame.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY / 400);
    view.setCamera(
      zoomAt(view.camera, width, height, event.clientX - box.left, event.clientY - box.top, factor),
    );
  }

  function open(index: number): void {
    const target = nodes[index];
    // A ghost has no note to open. Nothing happens, and the description already said so.
    if (target?.path == null) return;
    onopen(target.path);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      onclose();
      event.preventDefault();
      return;
    }
    const action = graphKeyAction(event.key, view.x, view.y, nodes.length, view.selected);
    if (action.kind === "none") return;
    event.preventDefault();
    if (action.kind === "select") view.select(action.to);
    else if (action.kind === "open") open(view.selected);
    else if (action.kind === "fit") view.fit();
    else view.setCamera(zoomAt(view.camera, width, height, width / 2, height / 2, action.factor));
  }

  /**
   * What one more press of a tag's button means (§9.4's include/exclude, §8.4).
   *
   * why: a cycle rather than left-click to include and right-click to exclude. A context
   * menu is a mouse, and §8.4 does not allow a mouse-only feature — so the three states a
   * tag can be in are reached by activating the same control, which a keyboard can do.
   */
  function cycleTag(filters: GraphFilters, tag: string): GraphFilters {
    const included = filters.includeTags.includes(tag);
    const excluded = filters.excludeTags.includes(tag);
    const without = (list: readonly string[]): string[] => list.filter((entry) => entry !== tag);
    if (!included && !excluded) {
      return { ...filters, includeTags: [...filters.includeTags, tag] };
    }
    if (included) {
      return { ...filters, includeTags: without(filters.includeTags), excludeTags: [...filters.excludeTags, tag] };
    }
    return { ...filters, excludeTags: without(filters.excludeTags) };
  }

  /** What a screen reader is told the button will do next. */
  function tagState(filters: GraphFilters, tag: string): string {
    if (filters.includeTags.includes(tag)) return `#${tag}, showing only these — activate to hide them`;
    if (filters.excludeTags.includes(tag)) return `#${tag}, hidden — activate to show everything again`;
    return `#${tag} — activate to show only these`;
  }

</script>

<section class="graph-view" aria-label="Vault graph">
  <header class="graph-view-bar">
    <h2 class="graph-view-title">Graph</h2>

    <div class="graph-view-controls">
      <label class="graph-view-control">
        Size by
        <select
          value={view.sizeBy}
          onchange={(event) => view.setSizeBy(event.currentTarget.value === "words" ? "words" : "degree")}
        >
          <option value="degree">Links</option>
          <option value="words">Words</option>
        </select>
      </label>

      <button
        type="button"
        class="graph-view-button"
        aria-expanded={showFilters}
        aria-controls="graph-filters"
        onclick={() => (showFilters = !showFilters)}
      >
        Filters{filtersAreActive(view.filters) ? " (on)" : ""}
      </button>

      <button type="button" class="graph-view-button" onclick={() => view.fit()}>Fit</button>
      <button type="button" class="graph-view-button" onclick={onclose}>Close</button>
    </div>
  </header>

  {#if showFilters}
    <div class="graph-filters" id="graph-filters">
      <label class="graph-view-control">
        Path
        <input
          type="text"
          placeholder="Projects/**"
          value={view.filters.pathGlob}
          oninput={(event) =>
            view.setFilters({ ...view.filters, pathGlob: event.currentTarget.value })}
        />
      </label>

      <label class="graph-view-control">
        Created from
        <input
          type="date"
          value={view.filters.createdFrom}
          oninput={(event) =>
            view.setFilters({ ...view.filters, createdFrom: event.currentTarget.value })}
        />
      </label>

      <label class="graph-view-control">
        to
        <input
          type="date"
          value={view.filters.createdTo}
          oninput={(event) =>
            view.setFilters({ ...view.filters, createdTo: event.currentTarget.value })}
        />
      </label>

      <label class="graph-view-toggle">
        <input
          type="checkbox"
          checked={view.filters.orphansOnly}
          onchange={(event) =>
            view.setFilters({ ...view.filters, orphansOnly: event.currentTarget.checked })}
        />
        Orphans only
      </label>

      <label class="graph-view-toggle">
        <input
          type="checkbox"
          checked={view.filters.ghosts}
          onchange={(event) =>
            view.setFilters({ ...view.filters, ghosts: event.currentTarget.checked })}
        />
        Unwritten notes
      </label>

      <label class="graph-view-toggle">
        <input
          type="checkbox"
          checked={view.filters.edges.link}
          onchange={(event) =>
            view.setFilters({
              ...view.filters,
              edges: { ...view.filters.edges, link: event.currentTarget.checked },
            })}
        />
        Links
      </label>

      <label class="graph-view-toggle">
        <input
          type="checkbox"
          checked={view.filters.edges.embed}
          onchange={(event) =>
            view.setFilters({
              ...view.filters,
              edges: { ...view.filters.edges, embed: event.currentTarget.checked },
            })}
        />
        Embeds
      </label>

      {#if view.tags.length > 0}
        <div class="graph-filter-tags" role="group" aria-label="Filter by tag">
          {#each view.tags as tag (tag)}
            <button
              type="button"
              class="graph-filter-tag"
              class:is-included={view.filters.includeTags.includes(tag)}
              class:is-excluded={view.filters.excludeTags.includes(tag)}
              aria-label={tagState(view.filters, tag)}
              onclick={() => view.setFilters(cycleTag(view.filters, tag))}
            >
              #{tag}
            </button>
          {/each}
        </div>
      {/if}

      <button type="button" class="graph-view-button" onclick={() => view.setFilters(NO_FILTERS)}>
        Clear
      </button>
    </div>
  {/if}

  <div class="graph-view-frame" bind:this={frame}>
    {#if view.loading}
      <p class="graph-view-message">Reading the vault…</p>
    {:else if view.unavailable}
      <!-- Deliberately not an empty graph: the server did not answer, and an empty canvas
           would say this vault has no notes, which is a claim nobody checked. The retry is a
           button rather than an automatic one: `load` is called from an effect, so a view
           that retried by itself would retry once per frame. -->
      <p class="graph-view-message">
        The graph is unavailable for this vault.
        <button type="button" class="graph-view-button" onclick={() => view.reload()}>
          Try again
        </button>
      </p>
    {:else if view.empty}
      <p class="graph-view-message">There is nothing in this vault to draw yet.</p>
    {/if}

    <canvas class="graph-view-gl" bind:this={gl} aria-hidden="true"></canvas>
    <canvas class="graph-view-overlay" bind:this={overlay} aria-hidden="true"></canvas>
    <!--
      The canvases paint; this takes the events. A `<canvas>` cannot carry `role` — it is not
      an interactive element — and stacking one transparent surface over both of them also
      means the picture has exactly one hit target rather than two that can disagree.

      One tab stop for the whole graph, as §8.4 requires and as the note tree, the tag pane
      and the local graph all do it. What each key means is `graph-keys.ts`.
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- `role="application"` is
         exactly the case these two rules cannot see: it tells a screen reader to stop
         intercepting the arrow keys and hand them to the picture, which is what makes a
         canvas navigable at all. The same shape as the local graph's `role="listbox"` on an
         `<svg>`, and §8.4's requirement that nothing here needs a mouse. -->
    <div
      class="graph-view-surface"
      role="application"
      tabindex="0"
      aria-label={`Graph of ${view.nodes.length} notes. Arrow keys move between notes, Enter opens one, plus and minus zoom.`}
      aria-describedby="graph-selection"
      data-nodes={view.nodes.length}
      {onkeydown}
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      {onwheel}
    ></div>
  </div>

  <footer class="graph-view-status">
    <p class="graph-view-count">
      {#if view.truncated}
        <!-- §9.4 requires the cap to be visible rather than silent: a picture that quietly
             drops most of a vault is a picture that lies about the shape of it. -->
        Showing the {view.nodes.length} most connected of {view.total} notes.
      {:else if view.hidden > 0}
        Showing {view.nodes.length} of {view.total} notes.
      {:else}
        {`${view.nodes.length} ${view.nodes.length === 1 ? "note" : "notes"}.`}
      {/if}
    </p>
    <p class="graph-view-selection" id="graph-selection" aria-live="polite">
      {#if selectedNode === undefined}
        Nothing selected.
      {:else if selectedNode.path === null}
        {selectedNode.label} — no note yet.
      {:else}
        {`${selectedNode.label} — ${selectedNode.degree} ${
          selectedNode.degree === 1 ? "link" : "links"
        }.`}
      {/if}
    </p>
  </footer>
</section>

<style>
  .graph-view {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface-canvas);
    z-index: 20;
  }

  .graph-view-bar,
  .graph-view-status {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .graph-view-status {
    border-bottom: none;
    border-top: 1px solid var(--border-subtle);
    justify-content: space-between;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .graph-view-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }

  .graph-view-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-left: auto;
  }

  .graph-view-control {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .graph-view-button,
  .graph-view-control select,
  .graph-view-control input {
    min-height: 32px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-canvas);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .graph-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .graph-view-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .graph-filter-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .graph-filter-tag {
    padding: 2px var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-round);
    background: var(--surface-canvas);
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .graph-filter-tag.is-included {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .graph-filter-tag.is-excluded {
    text-decoration: line-through;
    opacity: 0.6;
  }

  .graph-view-frame {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Both canvases fill the frame and stack; the overlay takes the events, so the picture
     has one hit surface rather than two that can disagree. */
  .graph-view-gl,
  .graph-view-overlay,
  .graph-view-surface {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .graph-view-surface {
    touch-action: none;
    cursor: grab;
  }

  .graph-view-surface:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }

  .graph-view-message {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--text-muted);
    z-index: 1;
  }
</style>
