import fs from 'node:fs';
import { encodePNG } from './png.mjs';
import { render } from './raster.mjs';
import * as F from '../src/geom/flower.js';
import { buildGrassBladeMesh, buildGrassInstances } from '../src/geom/grass.js';
import { BOUNDS } from '../src/sim/flight.js';

const W = Number(process.argv[3] || 720);
const view = process.argv[4] || 'three-quarter';
const headY = F.FLOWER.stemHeight;

const meshes = [
  { mesh: F.buildStemMesh(),       albedo: [0.20, 0.34, 0.12] },
  // Same two leaves the renderer builds. These were absolute heights from
  // before the plant was rescaled, which left them attached above the top of
  // the stem -- so the preview hung a leaf across the flower head that the
  // real scene never shows, right over the part the top view exists to check.
  { mesh: F.buildLeafMesh(0.046, headY * 0.58,  0.65, 17), albedo: [0.16, 0.36, 0.10], translucency: 0.8 },
  { mesh: F.buildLeafMesh(0.037, headY * 0.37, -2.05, 29), albedo: [0.16, 0.36, 0.10], translucency: 0.8 },
  { mesh: F.buildReceptacleMesh(), albedo: [0.26, 0.34, 0.14] },
  { mesh: F.buildRayMesh(),        albedo: [0.72, 0.30, 0.48], translucency: 1.0 },
];

// Disc florets: instance the single floret mesh onto the Vogel spiral.
const floret = F.buildDiscFloretMesh();
const inst = F.buildFloretInstances();
for (let n = 0; n < inst.count; n++) {
  const o = n * 8;
  // Same slot order as struct FloretInstance in floret.wgsl. This preview
  // previously indexed the buffer in source order and so rendered correctly
  // while the shader did not -- which is precisely how the mismatch hid.
  const px = inst.data[o], py = inst.data[o+1], pz = inst.data[o+2];
  const s = inst.data[o+3];
  const nx = inst.data[o+4], ny = inst.data[o+5], nz = inst.data[o+6];
  // Build a frame whose +Y is the dome normal.
  const up = [nx, ny, nz];
  let t = Math.abs(ny) > 0.99 ? [1,0,0] : [0,1,0];
  const xa = (() => { const c=[up[1]*t[2]-up[2]*t[1], up[2]*t[0]-up[0]*t[2], up[0]*t[1]-up[1]*t[0]];
                      const l=Math.hypot(...c)||1; return c.map(v=>v/l); })();
  const za = [up[1]*xa[2]-up[2]*xa[1], up[2]*xa[0]-up[0]*xa[2], up[0]*xa[1]-up[1]*xa[0]];
  const maturity = inst.data[o+7];
  meshes.push({
    mesh: floret,
    albedo: maturity > 0.55 ? [0.62, 0.42, 0.10] : [0.30, 0.20, 0.07],
    xform: (p) => [
      px + (xa[0]*p[0] + up[0]*p[1] + za[0]*p[2]) * s,
      headY + py + (xa[1]*p[0] + up[1]*p[1] + za[1]*p[2]) * s,
      pz + (xa[2]*p[0] + up[2]*p[1] + za[2]*p[2]) * s,
    ],
  });
}

// Grass, transformed on the CPU so the field can be eyeballed before it ever
// reaches a shader. Subsampled: the rasteriser is not built for 2000 meshes.
if (process.env.GRASS !== '0') {
  const blade = buildGrassBladeMesh();
  const g = buildGrassInstances(BOUNDS);
  const stride = Number(process.env.GRASS_STRIDE || 3);
  for (let i = 0; i < g.count; i += stride) {
    const o = i * 8;
    const bx = g.data[o], bz = g.data[o + 2];
    const h = g.data[o + 3], cs = g.data[o + 4], sn = g.data[o + 5], w = g.data[o + 6];
    const tint = (g.data[o + 7] * 7.31) % 1;
    meshes.push({
      mesh: blade,
      albedo: [0.055 + 0.05 * tint, 0.115 + 0.05 * tint, 0.028 + 0.014 * tint],
      translucency: 0.9,
      xform: (p) => {
        const x = p[0] * h, y = p[1] * h, z = p[2] * w;
        return [bx + x * cs - z * sn, y, bz + x * sn + z * cs];
      },
    });
  }
}

const views = {
  'three-quarter': { eye: [0.075, headY + 0.048, 0.088], target: [0, headY - 0.004, 0], fov: 40 },
  'top':           { eye: [0.001, headY + 0.115, 0.004], target: [0, headY, 0], fov: 34 },
  'side':          { eye: [0.135, headY + 0.004, 0.012], target: [0, headY - 0.002, 0], fov: 36 },
  'wide':          { eye: [0.20, headY - 0.08, 0.26],  target: [0, headY - 0.15, 0], fov: 42 },
  'leaf':          { eye: [0.030, 0.360, 0.045], target: [0.043, 0.225, 0.030], fov: 46 },
  // Roughly where the bee starts, with the flight-mode field of view.
  'bee':           { eye: [0.26, 0.22, 0.30], target: [0, 0.20, 0], fov: 44 },
  'lowgrass':      { eye: [0.16, 0.045, 0.20], target: [0, 0.09, 0], fov: 50 },
};
const v = views[view];
const t0 = Date.now();
const px = render({ meshes, width: W, height: W, eye: v.eye, target: v.target, fovDeg: v.fov });
fs.writeFileSync(process.argv[2], encodePNG(px, W, W));
console.log(`rendered ${meshes.length} meshes, ${view}, ${Date.now()-t0}ms ->`, process.argv[2]);
