// Leaf venation via space colonisation (Runions et al. 2005), plus the texture
// bake that drives translucency, ridge displacement and specular anisotropy.
//
// Two departures from textbook space colonisation, both needed to get dicot
// topology rather than an algal-looking dichotomous bush:
//   1. The midrib is seeded explicitly. Real leaves are pinnate -- one dominant
//      axis with secondaries peeling off it -- which single-root colonisation
//      does not produce on its own.
//   2. Growth runs in two stages. A coarse stage builds midrib + secondaries,
//      then a fine stage re-colonises the gaps to build the tertiary net. One
//      stage gives comb teeth with empty areoles between them.

import { makeRng, fbm2 } from './rand.js';

export const DEFAULT_SHAPE = {
  halfWidth: 0.27,   // max half-width in leaf-length units
  frontExp: 0.42,    // base sharpness  (widest point = frontExp/(frontExp+backExp))
  backExp: 0.78,     // apex sharpness -- larger = more drawn-out tip
  teeth: 26,         // marginal serration count
  toothDepth: 0.06,  // serration depth as a fraction of local half-width
};

function shapeNorm(s) {
  const um = s.frontExp / (s.frontExp + s.backExp);
  return 1 / (Math.pow(um, s.frontExp) * Math.pow(1 - um, s.backExp));
}

/** Smooth blade half-width at normalised length u in [0,1]. Ovate, acuminate tip. */
export function leafHalfWidth(u, s = DEFAULT_SHAPE) {
  const t = Math.min(1, Math.max(0, u));
  if (t <= 0 || t >= 1) return 0;
  if (s._norm === undefined) s._norm = shapeNorm(s);
  return s.halfWidth * s._norm * Math.pow(t, s.frontExp) * Math.pow(1 - t, s.backExp);
}

/** Blade half-width including marginal teeth (teeth lean toward the apex). */
export function leafMargin(u, s = DEFAULT_SHAPE) {
  const w = leafHalfWidth(u, s);
  if (w <= 0) return 0;
  const phase = u * s.teeth;
  const f = phase - Math.floor(phase);
  // Asymmetric sawtooth: slow rise, fast fall => teeth point apex-ward.
  const tooth = f < 0.72 ? f / 0.72 : 1 - (f - 0.72) / 0.28;
  const fade = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, u))), 0.5);
  return w * (1 - s.toothDepth * fade * (1 - tooth));
}

function insideBlade(x, y, s) {
  if (y < 0 || y > 1) return false;
  return Math.abs(x) <= leafMargin(y, s);
}

// ---------------------------------------------------------------------------
// Space colonisation
// ---------------------------------------------------------------------------

/**
 * Jittered-grid scatter inside the blade. Dart throwing wastes most of its
 * tries once the domain saturates, and silently yields far fewer points than
 * asked for; a jittered grid hits the target density in one pass.
 */
function scatterAttractors(shape, rng, minDist) {
  const pts = [];
  const cell = minDist * 1.12;
  const nx = Math.ceil(1.0 / cell), ny = Math.ceil(1.0 / cell);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (i + rng.range(0.15, 0.85)) * cell - 0.5;
      const y = (j + rng.range(0.15, 0.85)) * cell;
      if (!insideBlade(x, y, shape)) continue;
      pts.push({ x, y, alive: true });
    }
  }
  return pts;
}

/** Uniform grid over nodes so nearest-node queries stay near-constant time. */
function NodeIndex(cellSize) {
  const map = new Map();
  const key = (cx, cy) => (cx * 73856093) ^ (cy * 19349663);
  return {
    add(x, y, idx) {
      const k = key(Math.floor(x / cellSize), Math.floor(y / cellSize));
      let b = map.get(k); if (!b) map.set(k, (b = []));
      b.push(idx);
    },
    /** Nearest node index to (x,y) within radius, or -1. */
    nearest(x, y, radius, nodes) {
      const span = Math.ceil(radius / cellSize);
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
      let best = -1, bestD = radius * radius;
      for (let j = -span; j <= span; j++) {
        for (let i = -span; i <= span; i++) {
          const b = map.get(key(cx + i, cy + j));
          if (!b) continue;
          for (const idx of b) {
            const d = (nodes[idx].x - x) ** 2 + (nodes[idx].y - y) ** 2;
            if (d < bestD) { bestD = d; best = idx; }
          }
        }
      }
      return best;
    },
    /** Nearest node satisfying `pred`, or -1. */
    nearestWhere(x, y, radius, nodes, pred) {
      const span = Math.ceil(radius / cellSize);
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
      let best = -1, bestD = radius * radius;
      for (let j = -span; j <= span; j++) {
        for (let i = -span; i <= span; i++) {
          const b = map.get(key(cx + i, cy + j));
          if (!b) continue;
          for (const idx of b) {
            const d = (nodes[idx].x - x) ** 2 + (nodes[idx].y - y) ** 2;
            if (d < bestD && pred(idx)) { bestD = d; best = idx; }
          }
        }
      }
      return best;
    },

    /** True if any node lies within `radius` of (x,y). */
    occupied(x, y, radius, nodes) {
      return this.nearest(x, y, radius, nodes) >= 0;
    },
  };
}

// Three growth stages: secondaries, tertiaries, then the fine reticulum.
// Each re-colonises whatever areole space the previous stage left empty.
const STAGES = [
  { step: 0.022, killRadius: 0.045, influenceRadius: 0.40,
    minDist: 0.058, apexBias: 0.60, spacing: 0.70, tipRadius: 0.0020 },
  { step: 0.013, killRadius: 0.020, influenceRadius: 0.100,
    minDist: 0.026, apexBias: 0.30, spacing: 0.65, tipRadius: 0.0013 },
  { step: 0.008, killRadius: 0.011, influenceRadius: 0.045,
    minDist: 0.0135, apexBias: 0.12, spacing: 0.75, tipRadius: 0.0009 },
];

function colonise(nodes, index, shape, stage, rng, maxIterations) {
  const attractors = scatterAttractors(shape, rng, stage.minDist);
  // Drop attractors already served by existing veins.
  for (const a of attractors) {
    if (index.occupied(a.x, a.y, stage.killRadius, nodes)) a.alive = false;
  }
  let alive = attractors.reduce((n, a) => n + (a.alive ? 1 : 0), 0);

  for (let iter = 0; iter < maxIterations && alive > 0; iter++) {
    const votes = new Map(); // nodeIndex -> [sumDx, sumDy, count]
    for (const a of attractors) {
      if (!a.alive) continue;
      const best = index.nearest(a.x, a.y, stage.influenceRadius, nodes);
      if (best < 0) continue;
      const dx = a.x - nodes[best].x, dy = a.y - nodes[best].y;
      const len = Math.hypot(dx, dy) || 1;
      const v = votes.get(best) || [0, 0, 0];
      v[0] += dx / len; v[1] += dy / len; v[2]++;
      votes.set(best, v);
    }
    if (votes.size === 0) break;

    const added = [];
    for (const [n, v] of votes) {
      let dx = v[0], dy = v[1];
      let len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      dx /= len; dy /= len;

      // Persist along the parent direction -- veins do not kink sharply.
      const p = nodes[n].parent;
      if (p >= 0) {
        const pdx = nodes[n].x - nodes[p].x, pdy = nodes[n].y - nodes[p].y;
        const pl = Math.hypot(pdx, pdy) || 1;
        dx += (pdx / pl) * 0.5; dy += (pdy / pl) * 0.5;
      }
      // Apex bias, scaled by distance from the midrib. This is what makes
      // secondaries sweep forward into brochidodromous arcs instead of
      // running straight out to the margin like comb teeth.
      const lateral = Math.min(1, Math.abs(nodes[n].x) / shape.halfWidth);
      dy += stage.apexBias * lateral * lateral;

      len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const nx = nodes[n].x + dx * stage.step, ny = nodes[n].y + dy * stage.step;
      if (!insideBlade(nx, ny, shape)) continue;
      // Reject growth into space an existing vein already occupies. Without
      // this, nodes pile up into solid blobs wherever attractors clustered.
      if (index.occupied(nx, ny, stage.step * stage.spacing, nodes)) continue;
      added.push({ x: nx, y: ny, parent: n, radius: 0, order: nodes[n].order + 1 });
    }
    if (added.length === 0) break;

    for (const a of added) {
      nodes.push(a);
      index.add(a.x, a.y, nodes.length - 1);
      a.tipRadius = stage.tipRadius;
    }

    for (const a of attractors) {
      if (!a.alive) continue;
      for (const nd of added) {
        if ((a.x - nd.x) ** 2 + (a.y - nd.y) ** 2 < stage.killRadius * stage.killRadius) {
          a.alive = false; alive--; break;
        }
      }
    }
  }
}

/** @returns {{nodes: Array<{x,y,parent,radius,order}>, shape}} */
export function growVenation(shape = DEFAULT_SHAPE, opts = {}) {
  const { seed = 1, midribTip = 0.93, maxIterations = 400 } = opts;
  // Sample the midrib far finer than the coarse growth step. The occupancy
  // test that stops veins growing on top of each other works against nodes,
  // so a sparsely sampled trunk leaves gaps that the fine stage colonises,
  // packing a zigzag of tertiary veins along the midrib axis.
  const MIDRIB_STEP = 0.006;
  const rng = makeRng(seed);
  const nodes = [];
  const index = NodeIndex(0.02);

  // --- seed the midrib; slight drift so the leaf is never truly symmetric ---
  const drift = rng.sym(0.014);
  let prev = -1;
  for (let y = 0; y <= midribTip; y += MIDRIB_STEP) {
    const bend = drift * y * y;
    nodes.push({ x: bend, y, parent: prev, radius: 0, order: 0, tipRadius: STAGES[0].tipRadius });
    index.add(bend, y, nodes.length - 1);
    prev = nodes.length - 1;
  }

  for (const stage of STAGES) colonise(nodes, index, shape, stage, rng, maxIterations);

  // --- vein widths via Murray's law: r_parent^k = sum(r_child^k) -----------
  // k=3 is the classical circulatory value; leaves run flatter, and a higher k
  // keeps the midrib from ballooning once thousands of tertiary tips feed it.
  //
  // Accumulate in reverse index order rather than by growth generation: every
  // node is pushed after its parent, so a descending index walk always resolves
  // children first. Sorting by generation does not -- the whole midrib shares
  // generation 0, so trunk nodes resolved in arbitrary order and the radius
  // never propagated to the base.
  const K = 3.2;
  const acc = new Float64Array(nodes.length);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    n.radius = acc[i] > 0 ? Math.max(n.tipRadius, Math.pow(acc[i], 1 / K)) : n.tipRadius;
    if (n.parent >= 0) acc[n.parent] += Math.pow(n.radius, K);
  }
  return { nodes, shape, links: closeAreoles(nodes, opts.linkRadius ?? 0.030) };
}

/**
 * Space colonisation grows a strictly open tree, but real tertiary venation is
 * reticulate: vein endings meet and enclose polygonal areoles. Join each tip to
 * a nearby vein that is not one of its own recent ancestors, producing the
 * closed loops that make a leaf read as a leaf rather than as a fern frond.
 * Links are render-only -- they are never part of the parent tree, so Murray's
 * law and any later traversal are unaffected.
 */
function closeAreoles(nodes, linkRadius) {
  const hasChild = new Uint8Array(nodes.length);
  for (const n of nodes) if (n.parent >= 0) hasChild[n.parent] = 1;

  const index = NodeIndex(linkRadius);
  for (let i = 0; i < nodes.length; i++) index.add(nodes[i].x, nodes[i].y, i);

  const isRecentAncestor = (a, b, depth) => {
    let cur = b;
    for (let d = 0; d < depth && cur >= 0; d++) {
      if (cur === a) return true;
      cur = nodes[cur].parent;
    }
    return false;
  };

  const links = [];
  const linked = new Uint8Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    if (hasChild[i] || linked[i]) continue;           // tips only
    const cand = index.nearestWhere(nodes[i].x, nodes[i].y, linkRadius, nodes,
      (j) => j !== i && !linked[j] &&
             !isRecentAncestor(j, i, 8) && !isRecentAncestor(i, j, 8));
    if (cand < 0) continue;
    linked[i] = 1; linked[cand] = 1;
    links.push({ a: i, b: cand, radius: Math.min(nodes[i].radius, nodes[cand].radius) });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Texture bake
//
// veinMap  : R = ridge height, G = light-blocking (veins are opaque),
//            B = vein tangent angle / PI, A = coverage (0 outside / in holes)
// detailMap: R = distance to margin, G = albedo mottle, B = necrosis/browning,
//            A = cavity AO between veins
// ---------------------------------------------------------------------------

/** How far past its radius a vein's ridge still raises the surface. */
const RIDGE_REACH = 2.4;

/**
 * Distance over which the sunken areole floor recovers to full brightness.
 * Sized to a real areole (~0.02 of the leaf's length) rather than an arbitrary
 * larger radius: matching it both sharpens the cavity shading and shrinks the
 * bake's candidate lists, since this value sets the spatial grid's padding.
 */
const AO_RANGE = 0.018;

/** Flatten tree edges and areole links into one segment list. */
function buildSegments(nodes, links) {
  const segs = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.parent < 0) continue;
    const p = nodes[n.parent];
    segs.push({ ax: p.x, ay: p.y, bx: n.x, by: n.y, radius: n.radius });
  }
  for (const l of links || []) {
    const a = nodes[l.a], b = nodes[l.b];
    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, radius: l.radius });
  }
  return segs;
}

/**
 * Bucket segments into a uniform grid for nearest-segment queries.
 *
 * `reach` must cover the full radius over which a segment can still influence
 * a texel -- the ridge falloff extends to radius*2.4, well beyond the segment
 * itself. Stamping only the segment's own footprint leaves texels at the edge
 * of that falloff in cells where the segment was never registered, so they
 * alternately find and miss it and the vein renders with a sawtooth edge.
 */
function buildSegmentGrid(segs, cells, minRadius) {
  const grid = new Array(cells * cells).fill(null);
  const put = (cx, cy, idx) => {
    if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) return;
    const k = cy * cells + cx;
    (grid[k] || (grid[k] = [])).push(idx);
  };
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    // Full ridge reach, floored so the cavity-AO falloff also stays continuous.
    // The floor dominates the cost: every segment gets stamped into every cell
    // within it, so widening it multiplies the per-texel candidate list.
    const pad = Math.max(Math.max(minRadius, sg.radius) * RIDGE_REACH, AO_RANGE + 0.002);
    const x0 = Math.floor((Math.min(sg.ax, sg.bx) - pad + 0.5) * cells);
    const x1 = Math.floor((Math.max(sg.ax, sg.bx) + pad + 0.5) * cells);
    const y0 = Math.floor((Math.min(sg.ay, sg.by) - pad) * cells);
    const y1 = Math.floor((Math.max(sg.ay, sg.by) + pad) * cells);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) put(cx, cy, i);
  }
  return grid;
}

/** Squared distance from a point to a segment. */
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
}

export function bakeLeafMaps(ven, size = 512, opts = {}) {
  const { seed = 3, holes = 2, ridgeGain = 1.0 } = opts;
  const { nodes, shape, links } = ven;
  const rng = makeRng(seed + 991);
  const cells = 128;
  const segs = buildSegments(nodes, links);
  // Below about a texel the ridge stops resolving and just aliases into
  // sparkle. Widen the finest veins to that floor, but fade their amplitude
  // by true radius instead -- otherwise every vein order renders the same
  // width and the whole taper from midrib to tertiary is lost.
  const minRadius = 1.1 / size;
  const grid = buildSegmentGrid(segs, cells, minRadius);
  const ampFor = (r) => Math.min(1, Math.max(0.20, r / 0.0042));

  // Insect damage bites in from the margin, which is where a caterpillar
  // actually starts. Undamaged leaves read as CG.
  const bites = [];
  for (let i = 0; i < holes; i++) {
    const u = rng.range(0.18, 0.85);
    const side = rng.next() < 0.5 ? -1 : 1;
    bites.push({
      x: side * leafMargin(u, shape) * rng.range(0.80, 1.02),
      y: u,
      r: rng.range(0.025, 0.058),
      seed: rng.range(0, 100),
    });
  }

  const veinMap = new Uint8Array(size * size * 4);
  const detailMap = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py++) {
    // Leaf space: x in [-0.5, 0.5], y in [0, 1]; y flipped so v=0 is the tip.
    const ly = 1 - (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const lx = (px + 0.5) / size - 0.5;
      const o = (py * size + px) * 4;

      const margin = leafMargin(ly, shape);
      let coverage = (ly >= 0 && ly <= 1 && Math.abs(lx) <= margin) ? 1 : 0;
      const marginDist = coverage
        ? Math.min(margin - Math.abs(lx), ly, 1 - ly) / shape.halfWidth : 0;

      let biteProximity = 0;
      for (const b of bites) {
        const dx = lx - b.x, dy = ly - b.y;
        const d = Math.hypot(dx, dy);
        const wobble = 1 + 0.68 * (fbm2(Math.atan2(dy, dx) * 2.2 + b.seed, b.seed, 3) - 0.5);
        const r = b.r * wobble;
        if (d < r) coverage = 0;
        biteProximity = Math.max(biteProximity, 1 - Math.min(1, Math.abs(d - r) / 0.030));
      }

      // Texels well outside the blade are never shaded -- the alpha cutout
      // drops them -- so skip the segment search there. Keep a few texels of
      // slack so mip generation has real data to blend at the margin.
      const slack = 8 / size;
      if (Math.abs(lx) > margin + slack || ly < -slack || ly > 1 + slack) {
        detailMap[o + 1] = 255 * fbm2(lx * 26 + 11, ly * 26, 4, 2.0, 0.55, seed);
        detailMap[o + 3] = 255;
        continue;
      }

      // --- vein height field ---
      // Take the maximum ridge contribution over every nearby segment rather
      // than the profile of the single nearest one. A ridge height field is a
      // union of vein profiles: querying only the nearest lets a hair-thin
      // tertiary vein passing beside the midrib win the lookup and stamp its
      // own near-zero profile over the trunk, which chews the midrib into a
      // sawtooth wherever fine veins cross it.
      let ridge = 0, block = 0, angle = 0.5;
      let nearestD2 = 1e9;
      const cx = Math.floor((lx + 0.5) * cells), cy = Math.floor(ly * cells);
      for (let j = -1; j <= 1; j++) {
        const gy = cy + j;
        if (gy < 0 || gy >= cells) continue;
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i;
          if (gx < 0 || gx >= cells) continue;   // guard: k arithmetic wraps rows
          const bucket = grid[gy * cells + gx];
          if (!bucket) continue;
          for (const idx of bucket) {
            const sg = segs[idx];
            const d2 = segDist2(lx, ly, sg.ax, sg.ay, sg.bx, sg.by);
            if (d2 < nearestD2) nearestD2 = d2;
            const r = Math.max(minRadius, sg.radius);
            const reach = r * RIDGE_REACH;
            if (d2 >= reach * reach) continue;
            const d = Math.sqrt(d2);
            const amp = ampFor(sg.radius);
            const h = Math.pow(1 - d / reach, 0.65) * amp;
            if (h > ridge) {
              ridge = h;
              const ang = Math.atan2(sg.by - sg.ay, sg.bx - sg.ax);
              angle = ((ang + Math.PI) % Math.PI) / Math.PI;
            }
            const bReach = r * 1.7;
            if (d < bReach) {
              block = Math.max(block, Math.pow(1 - d / bReach, 0.5) * amp);
            }
          }
        }
      }
      // Areoles sit slightly sunken between veins -> soft cavity occlusion.
      const ao = nearestD2 < 1e8
        ? 0.72 + 0.28 * Math.min(1, Math.sqrt(nearestD2) / AO_RANGE)
        : 1;

      const mottle = fbm2(lx * 26 + 11, ly * 26, 4, 2.0, 0.55, seed);
      // Necrosis creeps in from the margin and around bite rims.
      const edgeAge = Math.pow(1 - Math.min(1, marginDist / 0.22), 2.2);
      const necrosis = Math.min(1, edgeAge * 0.85 * (0.55 + 0.9 * mottle) + biteProximity * 0.75);

      veinMap[o + 0] = 255 * Math.min(1, ridge * ridgeGain);
      veinMap[o + 1] = 255 * Math.min(1, block);
      veinMap[o + 2] = 255 * angle;
      veinMap[o + 3] = 255 * coverage;

      detailMap[o + 0] = 255 * Math.min(1, marginDist);
      detailMap[o + 1] = 255 * mottle;
      detailMap[o + 2] = 255 * necrosis;
      detailMap[o + 3] = 255 * ao;
    }
  }
  return { veinMap, detailMap, size, bites };
}
