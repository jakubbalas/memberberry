/**
 * The global graph's WebGL renderer (`SPEC.md` §9.4).
 *
 * §9.4 asks for WebGL at ten thousand nodes, and the reason is the edges rather than the
 * nodes: a vault that size has tens of thousands of lines, and ten thousand SVG elements is
 * a document the browser re-lays-out on every pan. Here the whole picture is two buffers and
 * two draw calls, and a pan changes three uniforms.
 *
 * **What is not here is as deliberate as what is.** Labels and icons are drawn by a 2D
 * canvas *over* this one, because text in WebGL means a glyph atlas — a large amount of
 * machinery whose only advantage appears above the zoom threshold, where §9.4 caps the
 * number of labels at a couple of hundred anyway. Two stacked canvases cost one extra
 * composite and keep the text at the browser's own quality, including for scripts a
 * hand-rolled atlas would get wrong.
 *
 * **Colours come from the design tokens** (§20), read off the element rather than written
 * here: a hard-coded colour is a bug (`AGENTS.md` §4.4), and the graph shares `--series-0`…
 * `--series-5` with presence for the reason §20.1 records.
 *
 * **Nothing in this file can be tested in jsdom, which has no WebGL — so it holds no
 * decisions.** What to draw is `graph-camera.ts` and `graph-filters.ts`, which colour to draw
 * it in is `graph-colours.ts`, and this draws it. It is excluded from the coverage floors for
 * the same reason `perf/measure.ts` is: it is a boundary, and a mock of a WebGL context would
 * test the mock (`AGENTS.md` §2.3). What says it appears on screen is
 * `web/e2e/global-graph.spec.ts`, which reads the pixels back.
 */

import type { Camera } from "./graph-camera.js";
import type { GraphColours, Rgb } from "./graph-colours.js";

/** Everything the renderer draws, in the flat form it uploads. */
export interface GraphGeometry {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** World-unit radius per node. */
  readonly radius: Float32Array;
  /** Index into {@link GraphColours.series} per node. */
  readonly colour: Uint8Array;
  /** `1` for a ghost, which is drawn as a ring rather than a disc. */
  readonly ghost: Uint8Array;
  /** Flat triples of node indices, as everything else on this side holds them. */
  readonly edges: Uint32Array;
  readonly count: number;
}

const NODE_VERTEX = `
attribute vec2 aPosition;
attribute float aRadius;
attribute float aColour;
attribute float aGhost;
attribute float aIndex;
uniform vec2 uCentre;
uniform float uScale;
uniform vec2 uViewport;
uniform float uPixelRatio;
uniform float uSelected;
uniform vec3 uSeries[6];
uniform vec3 uGhost;
uniform vec3 uHighlight;
varying vec3 vColour;
varying float vGhost;
void main() {
  vec2 screen = (aPosition - uCentre) * uScale;
  gl_Position = vec4(screen / (uViewport * 0.5) * vec2(1.0, -1.0), 0.0, 1.0);
  // A dot never shrinks below a pixel: at the far end of the zoom range a whole vault is a
  // haze, and a haze made of nothing is an empty canvas.
  gl_PointSize = clamp(aRadius * uScale * 2.0 * uPixelRatio, 1.5, 64.0);
  int which = int(aColour);
  vec3 base = uSeries[0];
  for (int at = 1; at < 6; at++) {
    if (at == which) base = uSeries[at];
  }
  vColour = aGhost > 0.5 ? uGhost : base;
  if (abs(aIndex - uSelected) < 0.5) vColour = uHighlight;
  vGhost = aGhost;
}
`;

const NODE_FRAGMENT = `
precision mediump float;
varying vec3 vColour;
varying float vGhost;
void main() {
  vec2 offset = gl_PointCoord - vec2(0.5);
  float distance = length(offset) * 2.0;
  if (distance > 1.0) discard;
  // A ghost is hollow, exactly as it is in the local graph: §6.5 makes "no note here" one
  // shape, whether nobody has written it or this reader may not see it.
  if (vGhost > 0.5 && distance < 0.55) discard;
  // why: one minus a rising smoothstep, rather than a falling one. GLSL leaves smoothstep
  // undefined when the first edge is above the second, so the falling form is a dot whose
  // alpha may be zero everywhere — a graph with no nodes in it. (Written without backticks
  // on purpose: this is a template literal, and one here ends the shader.)
  float alpha = 1.0 - smoothstep(0.86, 1.0, distance);
  gl_FragColor = vec4(vColour, alpha);
}
`;

const EDGE_VERTEX = `
attribute vec2 aPosition;
attribute float aEmbed;
uniform vec2 uCentre;
uniform float uScale;
uniform vec2 uViewport;
uniform vec3 uLink;
uniform vec3 uEmbed;
varying vec3 vColour;
void main() {
  vec2 screen = (aPosition - uCentre) * uScale;
  gl_Position = vec4(screen / (uViewport * 0.5) * vec2(1.0, -1.0), 0.0, 1.0);
  vColour = aEmbed > 0.5 ? uEmbed : uLink;
}
`;

const EDGE_FRAGMENT = `
precision mediump float;
varying vec3 vColour;
void main() {
  // Lines are faint on purpose: at ten thousand nodes the edges are most of the ink, and a
  // picture where they are as loud as the nodes is a grey rectangle.
  gl_FragColor = vec4(vColour, 0.35);
}
`;

interface NodeProgram {
  readonly program: WebGLProgram;
  readonly position: number;
  readonly radius: number;
  readonly colour: number;
  readonly ghost: number;
  readonly index: number;
}

/** One buffer per attribute, created once and refilled per layout frame. */
interface GraphBuffers {
  readonly position: WebGLBuffer;
  readonly radius: WebGLBuffer;
  readonly colour: WebGLBuffer;
  readonly ghost: WebGLBuffer;
  readonly index: WebGLBuffer;
  readonly edgePosition: WebGLBuffer;
  readonly edgeEmbed: WebGLBuffer;
}

interface EdgeProgram {
  readonly program: WebGLProgram;
  readonly position: number;
  readonly embed: number;
}

/**
 * Draws a laid-out graph into a canvas.
 *
 * Created through {@link GraphRenderer.create}, which answers `undefined` when the browser
 * will not give a WebGL context — a real state on old hardware and in a locked-down
 * enterprise browser, and one the view has to say out loud rather than showing an empty box.
 */
export class GraphRenderer {
  readonly #gl: WebGLRenderingContext;
  readonly #nodes: NodeProgram;
  readonly #edges: EdgeProgram;
  readonly #buffers: GraphBuffers;
  #colours: GraphColours;
  #count = 0;
  #edgeVertices = 0;
  /** The colour array last uploaded, so an unchanged node set is not re-uploaded. */
  #colourSource: Uint8Array | undefined;
  /** The node count the index buffer was filled for; it is `0, 1, 2, …` and nothing else. */
  #indexed = -1;

  private constructor(
    gl: WebGLRenderingContext,
    nodes: NodeProgram,
    edges: EdgeProgram,
    buffers: GraphBuffers,
    colours: GraphColours,
  ) {
    this.#gl = gl;
    this.#nodes = nodes;
    this.#edges = edges;
    this.#buffers = buffers;
    this.#colours = colours;
  }

  static create(canvas: HTMLCanvasElement, colours: GraphColours): GraphRenderer | undefined {
    const gl = (canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      // why: `true`, which is not the default and is not free. Without it the drawing buffer
      // is cleared as soon as the frame is composited, so *nothing* can read the picture back
      // — including the one check that can tell "the graph rendered" from "the graph
      // mounted". This project has shipped a blank page twice with a green unit suite
      // (§22.6), and a renderer whose output no test can see would be the third. The cost is
      // a buffer the driver keeps rather than discards; the alternative is a canvas nobody
      // can prove is not empty.
      preserveDrawingBuffer: true,
    }) ?? undefined) as WebGLRenderingContext | undefined;
    if (gl === undefined) return undefined;
    const nodes = linkNodeProgram(gl);
    const edges = linkEdgeProgram(gl);
    if (nodes === undefined || edges === undefined) return undefined;
    const buffer = (): WebGLBuffer | undefined => gl.createBuffer() ?? undefined;
    const position = buffer();
    const radius = buffer();
    const colour = buffer();
    const ghost = buffer();
    const index = buffer();
    const edgePosition = buffer();
    const edgeEmbed = buffer();
    if (
      position === undefined ||
      radius === undefined ||
      colour === undefined ||
      ghost === undefined ||
      index === undefined ||
      edgePosition === undefined ||
      edgeEmbed === undefined
    ) {
      return undefined;
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return new GraphRenderer(
      gl,
      nodes,
      edges,
      { position, radius, colour, ghost, index, edgePosition, edgeEmbed },
      colours,
    );
  }

  /** Swaps the palette, for a theme change. Cheap: colours are uniforms, not buffers. */
  setColours(colours: GraphColours): void {
    this.#colours = colours;
  }

  /**
   * Uploads a new picture.
   *
   * Called once per *layout* frame rather than once per drawn frame — a pan changes uniforms
   * and no buffers — and within that it re-uploads only what changed. A node's colour, its
   * ghost flag and its index depend on the node set, not on where the layout has pushed it,
   * so during the two hundred frames a simulation takes to settle they are uploaded once.
   */
  setGeometry(geometry: GraphGeometry): void {
    const gl = this.#gl;
    this.#count = geometry.count;
    const interleaved = new Float32Array(geometry.count * 2);
    for (let i = 0; i < geometry.count; i += 1) {
      interleaved[i * 2] = geometry.x[i] ?? 0;
      interleaved[i * 2 + 1] = geometry.y[i] ?? 0;
    }
    upload(gl, this.#buffers.position, interleaved);
    upload(gl, this.#buffers.radius, geometry.radius.subarray(0, geometry.count));
    if (this.#colourSource !== geometry.colour) {
      upload(gl, this.#buffers.colour, Float32Array.from(geometry.colour.subarray(0, geometry.count)));
      upload(gl, this.#buffers.ghost, Float32Array.from(geometry.ghost.subarray(0, geometry.count)));
      this.#colourSource = geometry.colour;
    }
    if (this.#indexed !== geometry.count) {
      upload(
        gl,
        this.#buffers.index,
        Float32Array.from({ length: geometry.count }, (_, at) => at),
      );
      this.#indexed = geometry.count;
    }

    const pairs = Math.floor(geometry.edges.length / 3);
    const line = new Float32Array(pairs * 4);
    const embed = new Float32Array(pairs * 2);
    let at = 0;
    for (let e = 0; e < pairs; e += 1) {
      const source = geometry.edges[e * 3] ?? 0;
      const target = geometry.edges[e * 3 + 1] ?? 0;
      if (source >= geometry.count || target >= geometry.count) continue;
      line[at * 4] = geometry.x[source] ?? 0;
      line[at * 4 + 1] = geometry.y[source] ?? 0;
      line[at * 4 + 2] = geometry.x[target] ?? 0;
      line[at * 4 + 3] = geometry.y[target] ?? 0;
      const kind = geometry.edges[e * 3 + 2] ?? 0;
      embed[at * 2] = kind;
      embed[at * 2 + 1] = kind;
      at += 1;
    }
    this.#edgeVertices = at * 2;
    upload(gl, this.#buffers.edgePosition, line.subarray(0, at * 4));
    upload(gl, this.#buffers.edgeEmbed, embed.subarray(0, at * 2));
  }

  /**
   * Paints one frame.
   *
   * `selected` is a node index or `-1`; it is a uniform rather than a buffer change, so
   * moving a pointer over a ten-thousand-node graph uploads nothing.
   */
  draw(camera: Camera, width: number, height: number, pixelRatio: number, selected: number): void {
    const gl = this.#gl;
    gl.viewport(0, 0, Math.max(1, Math.round(width * pixelRatio)), Math.max(1, Math.round(height * pixelRatio)));
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.#count === 0) return;

    if (this.#edgeVertices > 0) {
      gl.useProgram(this.#edges.program);
      uniform2f(gl, this.#edges.program, "uCentre", camera.x, camera.y);
      uniform1f(gl, this.#edges.program, "uScale", camera.scale);
      uniform2f(gl, this.#edges.program, "uViewport", width, height);
      uniform3fv(gl, this.#edges.program, "uLink", this.#colours.link);
      uniform3fv(gl, this.#edges.program, "uEmbed", this.#colours.embed);
      bind(gl, this.#buffers.edgePosition, this.#edges.position, 2);
      bind(gl, this.#buffers.edgeEmbed, this.#edges.embed, 1);
      gl.drawArrays(gl.LINES, 0, this.#edgeVertices);
    }

    gl.useProgram(this.#nodes.program);
    uniform2f(gl, this.#nodes.program, "uCentre", camera.x, camera.y);
    uniform1f(gl, this.#nodes.program, "uScale", camera.scale);
    uniform2f(gl, this.#nodes.program, "uViewport", width, height);
    uniform1f(gl, this.#nodes.program, "uPixelRatio", pixelRatio);
    uniform1f(gl, this.#nodes.program, "uSelected", selected);
    this.#colours.series.forEach((colour, at) => {
      uniform3fv(gl, this.#nodes.program, `uSeries[${at}]`, colour);
    });
    uniform3fv(gl, this.#nodes.program, "uGhost", this.#colours.ghost);
    uniform3fv(gl, this.#nodes.program, "uHighlight", this.#colours.highlight);
    bind(gl, this.#buffers.position, this.#nodes.position, 2);
    bind(gl, this.#buffers.radius, this.#nodes.radius, 1);
    bind(gl, this.#buffers.colour, this.#nodes.colour, 1);
    bind(gl, this.#buffers.ghost, this.#nodes.ghost, 1);
    bind(gl, this.#buffers.index, this.#nodes.index, 1);
    gl.drawArrays(gl.POINTS, 0, this.#count);
  }

  /** Releases the context's buffers. Every effect that creates one of these must call it. */
  dispose(): void {
    const gl = this.#gl;
    for (const buffer of Object.values(this.#buffers)) {
      gl.deleteBuffer(buffer);
    }
    gl.deleteProgram(this.#nodes.program);
    gl.deleteProgram(this.#edges.program);
  }
}

function upload(gl: WebGLRenderingContext, buffer: WebGLBuffer, data: Float32Array): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
}

function bind(
  gl: WebGLRenderingContext,
  buffer: WebGLBuffer,
  location: number,
  size: number,
): void {
  if (location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

function uniform1f(gl: WebGLRenderingContext, program: WebGLProgram, name: string, value: number): void {
  gl.uniform1f(gl.getUniformLocation(program, name), value);
}

function uniform2f(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
  a: number,
  b: number,
): void {
  gl.uniform2f(gl.getUniformLocation(program, name), a, b);
}

function uniform3fv(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
  colour: Rgb,
): void {
  gl.uniform3fv(gl.getUniformLocation(program, name), colour as unknown as number[]);
}

function compile(
  gl: WebGLRenderingContext,
  kind: number,
  source: string,
): WebGLShader | undefined {
  const shader = gl.createShader(kind);
  if (shader === null) return undefined;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return undefined;
  }
  return shader;
}

function link(
  gl: WebGLRenderingContext,
  vertex: string,
  fragment: string,
): WebGLProgram | undefined {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  if (vs === undefined || fs === undefined) return undefined;
  const program = gl.createProgram();
  if (program === null) return undefined;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    gl.deleteProgram(program);
    return undefined;
  }
  return program;
}

function linkNodeProgram(gl: WebGLRenderingContext): NodeProgram | undefined {
  const program = link(gl, NODE_VERTEX, NODE_FRAGMENT);
  if (program === undefined) return undefined;
  return {
    program,
    position: gl.getAttribLocation(program, "aPosition"),
    radius: gl.getAttribLocation(program, "aRadius"),
    colour: gl.getAttribLocation(program, "aColour"),
    ghost: gl.getAttribLocation(program, "aGhost"),
    index: gl.getAttribLocation(program, "aIndex"),
  };
}

function linkEdgeProgram(gl: WebGLRenderingContext): EdgeProgram | undefined {
  const program = link(gl, EDGE_VERTEX, EDGE_FRAGMENT);
  if (program === undefined) return undefined;
  return {
    program,
    position: gl.getAttribLocation(program, "aPosition"),
    embed: gl.getAttribLocation(program, "aEmbed"),
  };
}
