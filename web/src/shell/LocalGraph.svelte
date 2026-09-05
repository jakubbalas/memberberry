<!--
  The local graph (`SPEC.md` §9.4).

  The n-hop neighbourhood of the note in the focused pane, drawn as concentric rings: the
  note at the centre, what it touches on the first ring, what those touch on the second.
  `graph-layout.ts` decides where everything sits and why it is rings rather than springs.

  One tab stop for the whole picture with `aria-activedescendant`, exactly as `NoteTree` and
  `TagPane` do it — a graph of two hundred nodes must not be two hundred tab stops. Every
  decision about what a keypress means lives in `graph.ts`, so it is testable without
  mounting anything.

  Everything here arrives permission-filtered (E9). There is no filtering in this file and
  there must never be one — a note the user cannot read is not a node because the server
  never sent it, and a link into one arrives as a ghost, indistinguishable from a link to a
  note nobody has written (§6.5).
-->
<script lang="ts">
  import type { GraphView } from "./graph.svelte.js";
  import { MAX_HOPS, degrees, folderOf, graphKeyAction, nodeDescription } from "./graph.js";
  import { VIEWPORT, labelAnchor, layoutGraph } from "./graph-layout.js";

  interface Props {
    readonly view: GraphView;
    /** The note in the focused pane, or `undefined` when no note is open. */
    readonly note?: string | undefined;
    readonly onopen: (path: string) => void;
  }

  const { view, note, onopen }: Props = $props();

  let cursor = $state(0);

  // why: `$effect` rather than `$derived`. Fetching is not a derivation — it is what has to
  // happen when the note changes — and `GraphView.show` is idempotent for the note it is
  // already showing, so this settles rather than looping.
  $effect(() => {
    view.show(note);
  });

  const counted = $derived(degrees({ nodes: view.nodes, edges: view.edges }));
  const layout = $derived(layoutGraph(view.nodes, view.edges, counted));
  const nodes = $derived(view.nodes);
  // Clamped rather than reset: the picture is redrawn on every note and every hop change,
  // and a cursor past the end would leave `aria-activedescendant` naming nothing.
  const at = $derived(Math.min(cursor, Math.max(nodes.length - 1, 0)));

  /**
   * The folders in the picture, so a colour can be picked per folder (§9.4).
   *
   * Sorted, so the colour a folder gets depends on the folder rather than on which note
   * happened to come back first — a picture whose colours shuffle between two identical
   * requests is a picture that looks like it is changing.
   */
  const palette = $derived(
    new Map(
      [...new Set(nodes.map((node) => folderOf(node) ?? ""))]
        .sort()
        .map((folder, index) => [folder, index % 6] as const),
    ),
  );

  function open(index: number): void {
    const target = nodes[index];
    // A ghost has no note to open. Nothing happens, and the label already said so.
    if (target?.path == null) return;
    onopen(target.path);
  }

  function onkeydown(event: KeyboardEvent): void {
    const action = graphKeyAction(event.key, nodes.length, at);
    if (action.kind === "none") return;
    event.preventDefault();
    if (action.kind === "move") cursor = action.to;
    else open(at);
  }
</script>

<section class="tree-section graph-panel" aria-labelledby="graph-heading">
  <div class="graph-header">
    <h3 class="tree-heading" id="graph-heading">Local graph</h3>
    <!--
      A radio group rather than a slider or a stepper: there are three values, §9.4 names
      them, and a control with three states should show all three. Labelled per button so a
      screen reader hears "2 links away" rather than "2".
    -->
    <div class="graph-hops" role="radiogroup" aria-label="How many links away to show">
      {#each Array.from({ length: MAX_HOPS }, (_, index) => index + 1) as hops (hops)}
        <button
          type="button"
          class="graph-hop"
          role="radio"
          aria-checked={view.hops === hops}
          aria-label={`${hops} ${hops === 1 ? "link" : "links"} away`}
          data-hops={hops}
          onclick={() => view.setHops(hops)}
        >
          {hops}
        </button>
      {/each}
    </div>
  </div>

  {#if note === undefined}
    <p class="tree-empty">Open a note to see what is near it.</p>
  {:else if view.loading}
    <p class="tree-empty">Drawing the neighbourhood…</p>
  {:else if view.unavailable}
    <!-- Deliberately not an empty graph: the server did not answer, and drawing a lone dot
         would say this note has no neighbours, which is a claim nobody checked. -->
    <p class="tree-empty">The graph is unavailable for this note.</p>
  {:else if view.empty}
    <p class="tree-empty">Nothing links to or from this note yet.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -- the listbox *is*
         the picture: one tab stop, arrows to move, Enter to open, exactly as the note tree
         and the tag pane work. -->
    <svg
      class="graph-canvas"
      viewBox={`0 0 ${VIEWPORT} ${VIEWPORT}`}
      role="listbox"
      tabindex="0"
      aria-label={`Notes near ${nodes[0]?.label ?? "this note"}`}
      aria-activedescendant={nodes[at] === undefined ? undefined : `graph-node-${at}`}
      {onkeydown}
    >
      <defs>
        <marker
          id="graph-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" class="graph-arrowhead" />
        </marker>
      </defs>

      <g aria-hidden="true">
        {#each view.edges as edge (`${edge.source} ${edge.target}`)}
          {@const from = layout.places.get(edge.source)}
          {@const to = layout.places.get(edge.target)}
          {#if from !== undefined && to !== undefined}
            <line
              class="graph-edge"
              class:is-embed={edge.embed}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              marker-end="url(#graph-arrow)"
            />
          {/if}
        {/each}
      </g>

      {#each layout.ordered as place (place.key)}
        {@const index = nodes.findIndex((node) => node.key === place.key)}
        {@const node = nodes[index]}
        {#if node !== undefined}
          <!-- svelte-ignore a11y_click_events_have_key_events -- the keyboard path for the
               whole picture is the listbox above, which owns the arrows and Enter.
               `tabindex="-1"` is the `aria-activedescendant` pattern, exactly as the tag
               tree does it: the container is the single tab stop and a node is focusable
               only programmatically. -->
          <g
            class="graph-node"
            class:is-origin={node.hop === 0}
            class:is-ghost={node.path === null}
            class:is-active={index === at}
            id={`graph-node-${index}`}
            role="option"
            tabindex="-1"
            aria-selected={index === at}
            aria-label={nodeDescription(node, node.hop)}
            data-key={node.key}
            data-folder={palette.get(folderOf(node) ?? "") ?? 0}
            onclick={() => {
              cursor = index;
              open(index);
            }}
          >
            <circle class="graph-dot" cx={place.x} cy={place.y} r={place.r} />
            <text
              class="graph-label"
              x={place.x}
              y={place.y - place.r - 3}
              text-anchor={labelAnchor(place.x)}>{node.label}</text
            >
            <!--
              What a pointer or a finger actually hits: a 3-unit dot in a 200-unit picture is
              a target of a couple of millimetres. `graph-layout.ts` sizes it so two of them
              never overlap.

              **Last, so it is on top.** A ghost's dot is drawn `fill: none`, which takes no
              pointer events at all, while a painted dot takes them — so a hit area underneath
              would be reached for one kind of node and not the other, and the same click
              would land on two different elements depending on whether the note exists.
            -->
            <circle class="graph-hit" cx={place.x} cy={place.y} r={place.hit} />
          </g>
        {/if}
      {/each}
    </svg>

    {#if view.truncated}
      <!-- §9.4 requires the cap to be visible rather than silent: a picture that quietly
           drops half a vault is a picture that lies about the shape of it. -->
      <p class="graph-note">Showing the nearest {nodes.length} notes.</p>
    {/if}
  {/if}
</section>
