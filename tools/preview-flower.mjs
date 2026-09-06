import fs from 'node:fs';
import { encodePNG } from './png.mjs';
import { render } from './raster.mjs';
import * as F from '../src/geom/flower.js';

const W = Number(process.argv[3] || 720);
const view = process.argv[4] || 'three-quarter';
const headY = F.FLOWER.stemHeight;

const meshes = [
  { mesh: F.buildStemMesh(),       albedo: [0.20, 0.34, 0.12] },
  { mesh: F.buildLeafMesh(0.075, 0.235,  0.6), albedo: [0.16, 0.36, 0.10], translucency: 0.8 },
  { mesh: F.buildLeafMesh(0.062, 0.150, -2.1, 29), albedo: [0.16, 0.36, 0.10], translucency: 0.8 },
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

const views = {
  'three-quarter': { eye: [0.075, headY + 0.048, 0.088], target: [0, headY - 0.004, 0], fov: 40 },
  'top':           { eye: [0.001, headY + 0.115, 0.004], target: [0, headY, 0], fov: 34 },
  'side':          { eye: [0.135, headY + 0.004, 0.012], target: [0, headY - 0.002, 0], fov: 36 },
  'wide':          { eye: [0.20, headY - 0.08, 0.26],  target: [0, headY - 0.15, 0], fov: 42 },
  'leaf':          { eye: [0.030, 0.360, 0.045], target: [0.043, 0.225, 0.030], fov: 46 },
};
const v = views[view];
const t0 = Date.now();
const px = render({ meshes, width: W, height: W, eye: v.eye, target: v.target, fovDeg: v.fov });
fs.writeFileSync(process.argv[2], encodePNG(px, W, W));
console.log(`rendered ${meshes.length} meshes, ${view}, ${Date.now()-t0}ms ->`, process.argv[2]);
