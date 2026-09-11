// The grass blade, and only the blade.
//
// Placement used to live here as a baked instance buffer. It does not any
// more: over a field metres across the buffer would be tens of millions of
// blades, so grass.wgsl hashes each blade's position out of a world grid
// inside a window that follows the camera. What is left is the one thing that
// genuinely has to be a mesh -- the arching blade itself.
//
// This is the GROUND sward: the short, prostrate turf a lawn or a grazed
// meadow is made of, where a blade reaches further out than it ever stands
// up. Tall flowering grasses are a separate thing and are not built yet.
//
// Two conventions the shader depends on:
//
//   * The blade is stored at unit ARC LENGTH along its centreline, and the
//     centreline alone is scaled by the instance's length. The cross-section
//     (`across`) is scaled by the instance's WIDTH instead, which is the
//     whole reason the strap stays a strap. It used to carry a V-fold baked
//     into the centreline plane, where the vertex shader's length scale
//     caught it: a fold nominally 27% of the blade's width came out 27% of
//     its HEIGHT, i.e. centimetres deep, which is what made the sward read as
//     folded ribbons -- and why a gust that turned one edge-on made it
//     vanish. The keel is now shading only (see grass.wgsl), which is all it
//     was ever doing at a blade's real width.
//   * `axis` runs 0 at the root and 1 at the tip, so the wind bend is a
//     cantilever about the crown rather than a rigid tip-over.

import { MeshBuilder, sampleSurface } from './mesh.js';
import { makeRng } from './rand.js';

/**
 * Arc of the centreline, root to tip, in radians from vertical. Chosen so the
 * blade reaches about 0.66 of its own length out and stands only about 0.48 of
 * it up: prostrate turf, arching over and running back down to the ground,
 * rather than the upright tuft this used to grow. `tools/preview-flower.mjs`
 * with the `lowgrass` view is the check.
 */
const DROOP = 2.5;
const DROOP_EXP = 1.30;

/** One blade at unit arc length and unit width; instances scale and place it. */
export function buildGrassBladeMesh(seed = 41) {
  const rng = makeRng(seed);
  // Nine rows up the blade rather than five: the arc is half again as long as
  // it was and bends much harder, so the coarse levels (stride 2 and 4, see
  // mesh.js) still need enough rows left to keep the curve smooth.
  const NU = 9, NV = 3;

  const mb = new MeshBuilder();

  // Centreline, integrated from an angle that accelerates away from vertical.
  const STEPS = 64;
  const path = [{ x: 0, y: 0, a: 0 }];
  {
    let x = 0, y = 0;
    for (let i = 1; i <= STEPS; i++) {
      const a = DROOP * Math.pow(i / STEPS, DROOP_EXP);
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
    // Held near full width for the first half, then drawn out to a long point:
    // a grass blade is a parallel-sided strap that tapers late, not a triangle.
    // It does NOT reach zero at the tip. A row of coincident vertices has no
    // surface to differentiate, so sampleSurface's central difference across
    // it collapses and the guard hands back world up -- one row of blatantly
    // wrong normals right where the blade catches the light.
    const halfW = 0.5 * Math.pow(1 - 0.985 * u * u, 0.42);
    const across = (v - 0.5) * 2 * halfW;
    // x and y are centreline, in LENGTH units; z is across, in WIDTH units.
    // The two are scaled separately in the vertex shader, so nothing that
    // belongs to the cross-section may be written into x or y.
    return [c.x, c.y, across];
  };

  sampleSurface(mb, surf, NU, NV, {
    uv: (u, v) => [v, u],
    axis: (u) => u,          // wind bend grows toward the tip
    stemHeight: 0,
    variant: rng.next(),
  });
  return mb.finish();
}
