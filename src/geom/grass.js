// Procedural grass. Exists mostly as landmarks -- flying with nothing but sky
// and one flower gives no sense of heading, speed or altitude -- so the blades
// are scattered in tufts rather than uniformly, which reads as ground cover
// and gives the eye something to parse at every distance.

import { MeshBuilder, sampleSurface } from './mesh.js';
import { makeRng } from './rand.js';

/** One blade at unit height and unit width; instances scale and place it. */
export function buildGrassBladeMesh(seed = 41) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const NU = 7, NV = 3;
  const DROOP = 0.85;    // radians of arc from base to tip at rest
  const FOLD = 0.55;     // depth of the central keel, as a fraction of width

  // Centreline, integrated from an angle that accelerates away from vertical.
  const STEPS = 32;
  const path = [{ x: 0, y: 0, a: 0 }];
  {
    let x = 0, y = 0;
    for (let i = 1; i <= STEPS; i++) {
      const a = DROOP * Math.pow(i / STEPS, 1.5);
      x += Math.sin(a) / STEPS;
      y += Math.cos(a) / STEPS;
      path.push({ x, y, a });
    }
  }
  const centre = (u) => {
    const f = Math.min(0.999999, Math.max(0, u)) * STEPS;
    const i = Math.floor(f), t = f - i;
    const p = path[i], q = path[Math.min(STEPS, i + 1)];
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, a: p.a + (q.a - p.a) * t };
  };

  const surf = (u, v) => {
    const c = centre(u);
    // Widest at the base, drawn to a point at the tip.
    const halfW = 0.5 * Math.pow(1 - u, 0.55);
    const across = (v - 0.5) * 2 * halfW;
    // Grass blades are V-folded along their length; the keel is what catches a
    // hard line of specular down each blade.
    const keel = FOLD * (1 - Math.abs(v * 2 - 1)) * halfW;
    const nx = Math.cos(c.a), ny = -Math.sin(c.a);
    return [c.x + nx * keel, c.y + ny * keel, across];
  };

  sampleSurface(mb, surf, NU, NV, {
    uv: (u, v) => [v, u],
    axis: (u) => u,          // wind bend grows toward the tip
    stemHeight: 0,
    variant: rng.next(),
  });
  return mb.finish();
}

/**
 * Field of blades in tufts.
 *
 * Layout must match struct GrassInstance in grass.wgsl:
 *   posHeight : vec4f   0,1,2 = base position   3 = height (m)
 *   orient    : vec4f   4 = cos(yaw)  5 = sin(yaw)  6 = width (m)  7 = variant
 */
export const GRASS_INSTANCE_FLOATS = 8;
const GI = { posX: 0, posY: 1, posZ: 2, height: 3, cos: 4, sin: 5, width: 6, variant: 7 };

export function buildGrassInstances(bounds, opts = {}) {
  const {
    seed = 47, tufts = 320, perTuft = 8, tuftRadius = 0.055,
    clearRadius = 0.030,      // keep the stem's own footprint clear
  } = opts;
  const rng = makeRng(seed);
  const blades = [];

  for (let t = 0; t < tufts; t++) {
    const cx = rng.range(bounds.min[0], bounds.max[0]);
    const cz = rng.range(bounds.min[2], bounds.max[2]);
    // Tufts vary in vigour, so the field has tall clumps and sparse patches
    // instead of one uniform pile height.
    const vigour = rng.range(0.55, 1.35);
    const count = Math.max(2, Math.round(perTuft * rng.range(0.5, 1.4)));

    for (let b = 0; b < count; b++) {
      // Gaussian scatter about the tuft centre; sqrt keeps the middle denser.
      const ang = rng.range(0, Math.PI * 2);
      const rad = tuftRadius * Math.sqrt(rng.next()) * rng.range(0.6, 1.3);
      const x = cx + Math.cos(ang) * rad;
      const z = cz + Math.sin(ang) * rad;
      if (x < bounds.min[0] || x > bounds.max[0]) continue;
      if (z < bounds.min[2] || z > bounds.max[2]) continue;
      if (Math.hypot(x, z) < clearRadius) continue;

      const yaw = rng.range(0, Math.PI * 2);
      blades.push({
        x, z,
        // Real grass runs 30-60 times longer than it is wide.
        height: 0.040 * vigour * rng.range(0.45, 1.7),
        width: 0.0013 * rng.range(0.7, 1.35),
        cos: Math.cos(yaw), sin: Math.sin(yaw),
        variant: rng.next(),
      });
    }
  }

  const data = new Float32Array(blades.length * GRASS_INSTANCE_FLOATS);
  blades.forEach((b, i) => {
    const o = i * GRASS_INSTANCE_FLOATS;
    data[o + GI.posX] = b.x;
    data[o + GI.posY] = 0;
    data[o + GI.posZ] = b.z;
    data[o + GI.height] = b.height;
    data[o + GI.cos] = b.cos;
    data[o + GI.sin] = b.sin;
    data[o + GI.width] = b.width;
    data[o + GI.variant] = b.variant;
  });
  return { data, count: blades.length };
}
