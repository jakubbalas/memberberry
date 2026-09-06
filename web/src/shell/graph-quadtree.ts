/**
 * A quadtree over point positions (`SPEC.md` §9.4).
 *
 * §9.4 asks for two things at ten thousand nodes — **Barnes-Hut layout** and **quadtree hit
 * testing** — and they are the same structure asked two questions, so there is one of it.
 * Building it twice would be two implementations of the same subdivision rule, and the one
 * that is not used every frame would be the one that rots.
 *
 * **Flat arrays rather than objects.** The tree is rebuilt on every tick of the layout, so a
 * node object per quad is ten thousand allocations per frame and a garbage collection in the
 * middle of an animation. Everything here is a typed array indexed by quad number, grown once
 * and reused across builds — `build` is the only thing that allocates, and only when the
 * point count outgrows what it already has.
 *
 * **Coincident points do not subdivide forever.** Two notes at exactly the same position
 * would split the region until the arithmetic ran out, so a quad at [`MAX_DEPTH`] holds a
 * chain of points instead. That is not a theoretical case: a layout tick can push two nodes
 * onto the same coordinate, and the version of this without the cap hung the worker.
 */

/** How deep the tree may subdivide before a quad starts chaining coincident points. */
const MAX_DEPTH = 26;

/** Children per quad, in the order `(west, east)` × `(north, south)`. */
const CHILDREN = 4;

/**
 * A quadtree over `count` points, rebuildable in place.
 *
 * Positions are read from the arrays passed to {@link Quadtree.build} and are **not** copied:
 * the caller owns them, and the tree is only valid while they hold the positions it was built
 * from. That is the contract the layout wants — it mutates positions every tick and rebuilds.
 */
export class Quadtree {
  /** `CHILDREN` entries per quad; `-1` is an absent child. */
  #children = new Int32Array(0);
  /** The first point in a quad's chain, or `-1` when it holds none directly. */
  #head = new Int32Array(0);
  /** The next point in the same chain, or `-1`. Indexed by point, not by quad. */
  #next = new Int32Array(0);
  /** How many points are in a quad's whole subtree. */
  #mass = new Float64Array(0);
  /** Sum of the positions in a quad's subtree; divided by mass to give the centre. */
  #sumX = new Float64Array(0);
  #sumY = new Float64Array(0);

  #quads = 0;
  #x: Float32Array = new Float32Array(0);
  #y: Float32Array = new Float32Array(0);
  #x0 = 0;
  #y0 = 0;
  #size = 0;

  /** How many quads the last build produced. Exposed for tests, not for traversal. */
  get quads(): number {
    return this.#quads;
  }

  /**
   * Rebuilds over the first `count` entries of `x` and `y`.
   *
   * The region is square and covers every point, because a quad that is not square makes
   * "how far away is this quad" ambiguous — and that distance is exactly what both Barnes-Hut
   * and the nearest-point search prune on.
   */
  build(x: Float32Array, y: Float32Array, count: number): void {
    this.#x = x;
    this.#y = y;
    this.#quads = 0;
    if (count <= 0) {
      this.#size = 0;
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i += 1) {
      // A non-finite position would poison the bounds and every prune that reads them. The
      // layout cannot produce one, and a tree that quietly mis-sized itself if it did would
      // be a bug with no symptom.
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    if (minX > maxX) {
      // Every point was non-finite, so there is nothing to build a region around.
      this.#size = 0;
      return;
    }
    // A single point, or a row of them, gives a zero-width region; widen it so that a child
    // quad is always strictly smaller than its parent and the descent terminates.
    const span = Math.max(maxX - minX, maxY - minY);
    this.#size = span > 0 ? span * (1 + 1e-6) : 1;
    this.#x0 = minX;
    this.#y0 = minY;

    this.#ensureCapacity(count);
    this.#next.fill(-1, 0, count);
    this.#newQuad();
    for (let i = 0; i < count; i += 1) {
      const px = x[i] ?? 0;
      const py = y[i] ?? 0;
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      this.#insert(i, px, py);
    }
  }

  /**
   * Walks the tree towards `(px, py)`, calling `visit` once per body or approximation.
   *
   * This is Barnes-Hut: a quad far enough away for its width to subtend a small angle is
   * summarised by its centre of mass rather than descended into, which is what turns an
   * all-pairs repulsion into `n log n`. `theta` is that angle — larger is faster and coarser,
   * `0` is exact.
   *
   * `visit` receives the offset from the point to the mass, the squared distance, and how
   * many bodies the mass stands for. It is called once per *approximation*, so a caller
   * accumulating a force gets the same total whichever way the tree happened to split.
   */
  approximate(
    px: number,
    py: number,
    theta: number,
    visit: (dx: number, dy: number, distanceSquared: number, mass: number) => void,
  ): void {
    if (this.#quads === 0) return;
    const thetaSquared = theta * theta;
    // Depth-first with an explicit stack: a quad and the size of its region. Recursion would
    // be clearer and this runs ten thousand times a frame.
    const stack: number[] = [0, this.#size];
    while (stack.length > 0) {
      const size = stack.pop() ?? 0;
      const quad = stack.pop() ?? 0;
      const mass = this.#mass[quad] ?? 0;
      if (mass === 0) continue;
      const cx = (this.#sumX[quad] ?? 0) / mass;
      const cy = (this.#sumY[quad] ?? 0) / mass;
      const dx = cx - px;
      const dy = cy - py;
      const distanceSquared = dx * dx + dy * dy;

      if (size * size < thetaSquared * distanceSquared) {
        visit(dx, dy, distanceSquared, mass);
        continue;
      }
      // Close enough to matter: report the bodies sitting here and descend into the rest.
      // A quad holds points or children and never both (see `#insert`), so exactly one of
      // these two loops does anything — writing it uniformly rather than branching on which
      // means there is no "is this a leaf" test to get wrong.
      for (let point = this.#head[quad] ?? -1; point !== -1; point = this.#next[point] ?? -1) {
        const bx = (this.#x[point] ?? 0) - px;
        const by = (this.#y[point] ?? 0) - py;
        visit(bx, by, bx * bx + by * by, 1);
      }
      const first = quad * CHILDREN;
      const half = size / 2;
      for (let child = 0; child < CHILDREN; child += 1) {
        const at = this.#children[first + child] ?? -1;
        if (at !== -1) {
          stack.push(at, half);
        }
      }
    }
  }

  /**
   * The point nearest `(px, py)` within `radius`, or `-1`.
   *
   * §9.4's hit testing. A linear scan over ten thousand nodes on every pointer move is the
   * thing this exists to avoid — and on a phone, where a finger moves continuously while it
   * drags, it is the difference between a picture that tracks and one that lags.
   */
  find(px: number, py: number, radius: number): number {
    if (this.#quads === 0 || !(radius > 0)) return -1;
    let best = -1;
    let bestDistance = radius * radius;
    const stack: number[] = [0, this.#x0, this.#y0, this.#size];
    while (stack.length > 0) {
      const size = stack.pop() ?? 0;
      const y0 = stack.pop() ?? 0;
      const x0 = stack.pop() ?? 0;
      const quad = stack.pop() ?? 0;
      if ((this.#mass[quad] ?? 0) === 0) continue;
      // Prune: the nearest possible point of this region is already further than the best.
      const nearestX = px < x0 ? x0 : px > x0 + size ? x0 + size : px;
      const nearestY = py < y0 ? y0 : py > y0 + size ? y0 + size : py;
      const gapX = nearestX - px;
      const gapY = nearestY - py;
      if (gapX * gapX + gapY * gapY > bestDistance) continue;

      for (let point = this.#head[quad] ?? -1; point !== -1; point = this.#next[point] ?? -1) {
        const dx = (this.#x[point] ?? 0) - px;
        const dy = (this.#y[point] ?? 0) - py;
        const distance = dx * dx + dy * dy;
        // why: `<` rather than `<=`, plus the point order below. Two nodes at the same
        // distance resolve to the lower index, so a click on an overlap always opens the
        // same note — a tie broken by traversal order is a tie broken by the layout.
        if (distance < bestDistance || (distance === bestDistance && point < best)) {
          bestDistance = distance;
          best = point;
        }
      }
      const first = quad * CHILDREN;
      const half = size / 2;
      for (let child = 0; child < CHILDREN; child += 1) {
        const at = this.#children[first + child] ?? -1;
        if (at === -1) continue;
        stack.push(
          at,
          x0 + (child % 2 === 1 ? half : 0),
          y0 + (child >= 2 ? half : 0),
          half,
        );
      }
    }
    return best;
  }

  #insert(point: number, px: number, py: number): void {
    let quad = 0;
    let x0 = this.#x0;
    let y0 = this.#y0;
    let size = this.#size;
    this.#addMass(quad, px, py);

    for (let depth = 0; ; depth += 1) {
      const first = quad * CHILDREN;
      const empty =
        (this.#head[quad] ?? -1) === -1 && (this.#children[first] ?? -1) === -1 &&
        (this.#children[first + 1] ?? -1) === -1 &&
        (this.#children[first + 2] ?? -1) === -1 &&
        (this.#children[first + 3] ?? -1) === -1;
      if (empty) {
        this.#head[quad] = point;
        return;
      }
      const sitting = this.#head[quad] ?? -1;
      if (sitting !== -1) {
        if (depth >= MAX_DEPTH) {
          // Deep enough that subdividing further buys nothing: chain instead.
          this.#next[point] = sitting;
          this.#head[quad] = point;
          return;
        }
        // Push what is here down one level before descending, so a quad holding children
        // never also holds a point above `MAX_DEPTH`.
        this.#head[quad] = -1;
        let moving = sitting;
        while (moving !== -1) {
          const following = this.#next[moving] ?? -1;
          this.#next[moving] = -1;
          this.#descend(
            moving,
            this.#x[moving] ?? 0,
            this.#y[moving] ?? 0,
            quad,
            x0,
            y0,
            size,
            depth,
          );
          moving = following;
        }
      }
      const half = size / 2;
      const east = px >= x0 + half ? 1 : 0;
      const south = py >= y0 + half ? 1 : 0;
      const slot = first + south * 2 + east;
      let child = this.#children[slot] ?? -1;
      if (child === -1) {
        child = this.#newQuad();
        this.#children[slot] = child;
      }
      quad = child;
      x0 += east * half;
      y0 += south * half;
      size = half;
      this.#addMass(quad, px, py);
    }
  }

  /** Places an already-counted point one level below `quad`, adding its mass as it goes. */
  #descend(
    point: number,
    px: number,
    py: number,
    quad: number,
    x0: number,
    y0: number,
    size: number,
    depth: number,
  ): void {
    let at = quad;
    let left = x0;
    let top = y0;
    let span = size;
    for (let d = depth; ; d += 1) {
      const half = span / 2;
      const east = px >= left + half ? 1 : 0;
      const south = py >= top + half ? 1 : 0;
      const slot = at * CHILDREN + south * 2 + east;
      let child = this.#children[slot] ?? -1;
      if (child === -1) {
        child = this.#newQuad();
        this.#children[slot] = child;
      }
      at = child;
      left += east * half;
      top += south * half;
      span = half;
      this.#addMass(at, px, py);
      const sitting = this.#head[at] ?? -1;
      if (sitting === -1) {
        this.#head[at] = point;
        return;
      }
      if (d + 1 >= MAX_DEPTH) {
        this.#next[point] = sitting;
        this.#head[at] = point;
        return;
      }
      // Occupied by a point that is not at this position: it will be pushed down when the
      // caller's loop continues, so keep descending past it.
      this.#head[at] = -1;
      let moving = sitting;
      while (moving !== -1) {
        const following = this.#next[moving] ?? -1;
        this.#next[moving] = -1;
        this.#descend(moving, this.#x[moving] ?? 0, this.#y[moving] ?? 0, at, left, top, span, d + 1);
        moving = following;
      }
    }
  }

  #addMass(quad: number, px: number, py: number): void {
    this.#mass[quad] = (this.#mass[quad] ?? 0) + 1;
    this.#sumX[quad] = (this.#sumX[quad] ?? 0) + px;
    this.#sumY[quad] = (this.#sumY[quad] ?? 0) + py;
  }

  #newQuad(): number {
    const quad = this.#quads;
    this.#quads += 1;
    if (quad * CHILDREN + CHILDREN > this.#children.length) {
      this.#grow(quad + 1);
    }
    this.#head[quad] = -1;
    this.#mass[quad] = 0;
    this.#sumX[quad] = 0;
    this.#sumY[quad] = 0;
    const first = quad * CHILDREN;
    this.#children[first] = -1;
    this.#children[first + 1] = -1;
    this.#children[first + 2] = -1;
    this.#children[first + 3] = -1;
    return quad;
  }

  #ensureCapacity(count: number): void {
    if (this.#next.length < count) {
      this.#next = new Int32Array(count);
    }
    // A quadtree over n points holds fewer than 2n quads at shallow depths and more when
    // points cluster; start at 4n and let `#grow` handle the rest rather than guessing.
    this.#grow(Math.max(4 * count, 8));
  }

  #grow(quads: number): void {
    if (quads * CHILDREN <= this.#children.length) return;
    const size = Math.max(quads, this.#children.length / CHILDREN * 2, 8);
    const children = new Int32Array(size * CHILDREN);
    children.set(this.#children);
    this.#children = children;
    const head = new Int32Array(size);
    head.set(this.#head);
    this.#head = head;
    const mass = new Float64Array(size);
    mass.set(this.#mass);
    this.#mass = mass;
    const sumX = new Float64Array(size);
    sumX.set(this.#sumX);
    this.#sumX = sumX;
    const sumY = new Float64Array(size);
    sumY.set(this.#sumY);
    this.#sumY = sumY;
  }
}
