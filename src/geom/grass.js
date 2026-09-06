// The grass blade, and only the blade.
//
// Placement used to live here as a baked instance buffer. It does not any
// more: over a field metres across the buffer would be tens of millions of
// blades, so grass.wgsl hashes each blade's position out of a world grid
// inside a window that follows the camera. What is left is the one thing that
// genuinely has to be a mesh -- the V-folded, drooping blade itself.

import { MeshBuilder, sampleSurface } from './mesh.js';
import { makeRng } from './rand.js';

/** One blade at unit height and unit width; instances scale and place it. */
export function buildGrassBladeMesh(seed = 41) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const NU = 5, NV = 3;
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
