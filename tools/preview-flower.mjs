// Software-rasterised preview of the procedural geometry, so the output can be
// checked by eye without a GPU.
//
// Two things it can render: one plant of a chosen species at full detail, and
// a patch of the real field. The second is the one that matters now -- the
// question is no longer "does the flower look right" but "does the meadow look
// like a meadow", and that is a question about layout and colour mix that only
// a wide view answers.
//
//   node tools/preview-flower.mjs out.png 720 three-quarter oxeye
//   node tools/preview-flower.mjs out.png 900 meadow
import fs from 'node:fs';
import { encodePNG } from './png.mjs';
import { render } from './raster.mjs';
import * as F from '../src/geom/flower.js';
import { SPECIES, SPECIES_BY_KEY, individual } from '../src/geom/species.js';
import { makeRng } from '../src/geom/rand.js';
import { growField } from '../src/geom/field.js';
import { buildGrassBladeMesh } from '../src/geom/grass.js';
import { BOUNDS } from '../src/sim/flight.js';

const W = Number(process.argv[3] || 720);
const view = process.argv[4] || 'three-quarter';
const species = SPECIES_BY_KEY[process.argv[5] || 'oxeye'] || SPECIES[0];

// The individual the single-plant views draw, pigments and all: the point of
// species.js is that colour comes out of a pigment load, so a preview that
// painted its own would be checking nothing. Its stem height is NOT the
// species mean, so everything placed on the head has to read it from here.
const subject = { ...individual(species, makeRng(7), 1), yaw: 0 };
const headY = subject.stemHeight;

const meshes = [];

const views = {
  'three-quarter': { eye: [0.075, headY + 0.048, 0.088], target: [0, headY - 0.004, 0], fov: 40 },
  'top':           { eye: [0.001, headY + 0.115, 0.004], target: [0, headY, 0], fov: 34 },
  'side':          { eye: [0.135, headY + 0.004, 0.012], target: [0, headY - 0.002, 0], fov: 36 },
  'wide':          { eye: [0.20, headY - 0.08, 0.26],  target: [0, headY - 0.15, 0], fov: 42 },
  'leaf':          { eye: [0.030, 0.360, 0.045], target: [0.043, 0.225, 0.030], fov: 46 },
  // Roughly where the bee starts, with the flight-mode field of view.
  'bee':           { eye: [0.26, 0.22, 0.30], target: [0, 0.20, 0], fov: 44 },
  'lowgrass':      { eye: [0.16, 0.045, 0.20], target: [0, 0.09, 0], fov: 50 },
  // The whole point of the field: a wide, low look across it.
  'meadow':        { eye: [0.4, 0.30, 2.1], target: [0.1, 0.13, -0.8], fov: 58 },
  // Straight down, which is the only view that shows the drifts as drifts.
  // Run it with GRASS=0, or the sward hides what it is meant to show.
  'plan':          { eye: [0, 3.2, 0.001], target: [0, 0, 0], fov: 62 },
};


// One mesh set per species, built once. The renderer does the same thing --
// the whole point of species-level meshes is that a plant costs an instance,
// not a rebuild.
const meshCache = new Map();
const speciesMeshes = (sp) => {
  if (!meshCache.has(sp.key)) meshCache.set(sp.key, F.buildSpeciesMeshes(sp));
  return meshCache.get(sp.key);
};

/** Add every part of one plant, transformed into the world. */
function addPlant(list, sp, ind, { x = 0, z = 0, lod = 0 } = {}) {
  const built = speciesMeshes(sp);
  const H = ind.stemHeight;
  const c = Math.cos(ind.yaw), s = Math.sin(ind.yaw);
  const k = ind.scale;
  // Vertices are offsets from the attachment point; the shader looks that
  // point up on the solved chain. With no solver here the chain is the plant's
  // straight rest axis, which is what the first frame draws anyway.
  const place = (attachFrac) => (p) => {
    const lx = (p[0] * c - p[2] * s) * k;
    const ly = p[1] * k;
    const lz = (p[0] * s + p[2] * c) * k;
    return [x + lx, attachFrac * H + ly, z + lz];
  };
  const add = (key, albedo, translucency, attach) => {
    const m = built[key];
    if (!m) return;
    list.push({ mesh: { ...m, indices: m.lods[lod].indices,
                        indexCount: m.lods[lod].indexCount },
                albedo, translucency, xform: place(attach) });
  };
  add('stem', ind.leafAlbedo.map((v) => v * 1.1), 0.4, 0);
  add('leafA', ind.leafAlbedo, 0.8, 0.58);
  add('leafB', ind.leafAlbedo, 0.8, 0.37);
  add('receptacle', ind.discAlbedo, 0.2, 1);
  add('ray', ind.rayAlbedo, 1.0, 1);
  return built;
}

if (view === 'meadow' || view === 'plan') {
  // A patch of the real field, from bee height. Plants are drawn at the LOD
  // the distance suggests, so this also shows what the coarse index buffers
  // look like -- the rasteriser has no lens, so nothing is hidden by blur.
  const field = growField({ min: BOUNDS.min, max: BOUNDS.max }, { target: 700 });
  const eye = views.meadow.eye;
  const near = field.plants
    .map((p) => ({ p, d: Math.hypot(p.x - eye[0], p.z - eye[2]) }))
    .filter((r) => view === 'plan'
      ? Math.abs(r.p.x) < 2.6 && Math.abs(r.p.z) < 2.6
      : r.d < 3.4 && r.p.z < eye[2] - 0.1 && Math.abs(r.p.x) < 2.2)
    .sort((a, b) => a.d - b.d)
    .slice(0, view === 'plan' ? 400 : 220);
  const tiers = [0, 0, 0];
  for (const { p, d } of near) {
    const lod = view === 'plan' ? 1 : d < 0.6 ? 0 : d < 1.4 ? 1 : 2;
    tiers[lod]++;
    addPlant(meshes, SPECIES[p.species], p, { x: p.x, z: p.z, lod });
  }
  console.log(`meadow: ${near.length} of ${field.plants.length} plants, ` +
              `tiers ${tiers.join('/')}`);
} else {
  addPlant(meshes, species, subject);

  // Disc florets: instance the single floret mesh onto the Vogel spiral.
  const floret = F.buildDiscFloretMesh();
  const inst = F.buildFloretInstances(species);
  for (let n = 0; n < inst.count; n++) {
    const o = n * 8;
    // Same slot order as struct FloretInstance in floret.wgsl. This preview
    // previously indexed the buffer in source order and so rendered correctly
    // while the shader did not -- which is precisely how the mismatch hid.
    const px = inst.data[o], py = inst.data[o + 1], pz = inst.data[o + 2];
    const sc = inst.data[o + 3];
    const nx = inst.data[o + 4], ny = inst.data[o + 5], nz = inst.data[o + 6];
    // Build a frame whose +Y is the dome normal.
    const up = [nx, ny, nz];
    const t = Math.abs(ny) > 0.99 ? [1, 0, 0] : [0, 1, 0];
    const xa = (() => {
      const cr = [up[1]*t[2]-up[2]*t[1], up[2]*t[0]-up[0]*t[2], up[0]*t[1]-up[1]*t[0]];
      const l = Math.hypot(...cr) || 1; return cr.map((v) => v / l);
    })();
    const za = [up[1]*xa[2]-up[2]*xa[1], up[2]*xa[0]-up[0]*xa[2], up[0]*xa[1]-up[1]*xa[0]];
    const maturity = inst.data[o + 7];
    meshes.push({
      mesh: floret,
      albedo: maturity > 0.55 ? [0.62, 0.42, 0.10] : [0.30, 0.20, 0.07],
      xform: (p) => [
        px + (xa[0]*p[0] + up[0]*p[1] + za[0]*p[2]) * sc,
        headY + py + (xa[1]*p[0] + up[1]*p[1] + za[1]*p[2]) * sc,
        pz + (xa[2]*p[0] + up[2]*p[1] + za[2]*p[2]) * sc,
      ],
    });
  }
}

// Grass. The runtime hashes blade positions out of a world grid in the vertex
// shader; this reproduces that placement on the CPU so the preview shows the
// same sward the GPU would, rather than a second, differently-scattered one.
if (process.env.GRASS !== '0') {
  const blade = buildGrassBladeMesh();
  const CELL = 0.055, PER = 8, TUFT_CELLS = 1.6;
  const hash = (x, y) => {
    let h = Math.imul(Math.round(x * 131) ^ Math.round(y * 977), 2246822519);
    h = Math.imul(h ^ (h >>> 15), 3266489917);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const R = Number(process.env.GRASS_RADIUS || 0.6);
  const n = Math.ceil(R / CELL);
  const tuftOf = new Map();
  const tuft = (tcx, tcz) => {
    const key = `${tcx},${tcz}`;
    let t = tuftOf.get(key);
    if (!t) {
      const tc1 = hash(tcx * 0.913 + 5.31, tcz * 0.913 + 17.07);
      const tc2 = hash(tcx * 1.531 + 29.71, tcz * 1.531 + 3.19);
      const exists = hash(tcx * 2.117 + 41.03, tcz * 2.117 + 61.87) > 0.32;
      const radius = CELL * TUFT_CELLS *
        (0.06 + 0.12 * hash(tcx * 3.301 + 9.41, tcz * 3.301 + 71.23));
      t = {
        exists, radius,
        x: (tcx * TUFT_CELLS + tc1 * TUFT_CELLS) * CELL,
        z: (tcz * TUFT_CELLS + tc2 * TUFT_CELLS) * CELL,
      };
      tuftOf.set(key, t);
    }
    return t;
  };
  for (let cz = -n; cz <= n; cz++) {
    for (let cx = -n; cx <= n; cx++) {
      const t = tuft(Math.floor(cx / TUFT_CELLS), Math.floor(cz / TUFT_CELLS));
      if (!t.exists) continue;
      for (let b = 0; b < PER; b++) {
        const h1 = hash(cx * 1.37 + b * 7.13, cz * 1.37 + b * 3.71);
        const h3 = hash(cx * 0.83 + b * 9.41 + 31, cz * 0.83 + b * 2.29);
        const h4 = hash(cx * 1.93 + b * 3.47 + 53, cz * 1.93 + b * 6.61);
        const h5 = hash(cx * 4.19 + b * 8.03 + 23, cz * 4.19 + b * 1.27);
        const rad = t.radius * Math.sqrt(h5);
        const ang = h4 * 6.283;
        const bx = t.x + Math.cos(ang) * rad, bz = t.z + Math.sin(ang) * rad;
        if (Math.hypot(bx, bz) > R) continue;
        // Width jitter's own hash (h2 in grass.wgsl); folded in here since
        // this preview does not otherwise use a second per-blade offset.
        const h2 = hash(cx * 2.71 + b * 1.93 + 11, cz * 2.71 + b * 5.17);
        const height = 0.055 * (0.45 + 1.5 * h1);
        const width = 0.0008 * (0.7 + 0.65 * h2);
        const cs = Math.cos(h3 * 6.283), sn = Math.sin(h3 * 6.283);
        meshes.push({
          mesh: blade,
          albedo: [0.055 + 0.05 * h1, 0.115 + 0.05 * h1, 0.028 + 0.014 * h1],
          translucency: 0.9,
          xform: (p) => {
            const x = p[0] * height, y = p[1] * height, z = p[2] * width;
            return [bx + x * cs - z * sn, y, bz + x * sn + z * cs];
          },
        });
      }
    }
  }
}

const v = views[view] || views['three-quarter'];
const t0 = Date.now();
const px = render({ meshes, width: W, height: W, eye: v.eye, target: v.target, fovDeg: v.fov });
fs.writeFileSync(process.argv[2], encodePNG(px, W, W));
console.log(`rendered ${meshes.length} meshes, ${view}, ${Date.now()-t0}ms ->`, process.argv[2]);
