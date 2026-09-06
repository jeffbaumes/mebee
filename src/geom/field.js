// Where the flowers actually go.
//
// A field of flowers scattered by uniform random sampling reads as wallpaper,
// and no amount of rendering fixes it. What the eye is reading in a real
// meadow is three separate structures at once:
//
//   1. a HABITAT gradient -- moisture, shelter, how hard the sward is grazed --
//      which varies smoothly over metres and decides what CAN grow where;
//   2. DISPERSAL -- offspring land near their parent, so each species arrives
//      in patches whose size is set by how it travels (a clonal daisy makes a
//      tight sheet, a wind-blown annual makes a loose drift);
//   3. COMPETITION -- two plants cannot occupy the same rosette, and a big one
//      suppresses its neighbours, so within a patch the spacing is regular
//      rather than Poisson.
//
// Those give the three things you can see from a bee's height and cannot fake:
// drifts of one species, mixed edges where two drifts meet, and bare ground
// where nothing suits. The implementation is a Thomas cluster process (parents
// drawn against a habitat-weighted intensity, offspring scattered around them)
// followed by dart-throwing against a spatial hash for the spacing rule.

import { makeRng, fbm2 } from './rand.js';
import { SPECIES, individual, headRadius, stemWindGain } from './species.js';

/**
 * The habitat, as three smooth scalar fields over the ground plane.
 *
 * All three are cheap fbm at metre scale. What matters is not their exact
 * shape but that they are SMOOTH and INDEPENDENT: a species' suitability is a
 * product of its fit to each, so the places where two species overlap are
 * automatically the places where their preferred bands cross, and that is what
 * produces an ecotone instead of a hard edge.
 */
/**
 * Stretch an fbm sum across the full range.
 *
 * A sum of noise octaves piles up near its mean -- the central limit theorem
 * doing its job -- so a raw fbm over a field gives a gentle wash where a
 * meadow has real gradients: a wet hollow, a dry rise, a hard-grazed path with
 * edges. Without this the niches in species.js all overlap almost everywhere
 * and the sampler degenerates towards a shuffle. The midpoints and gains are
 * the measured 10th and 90th percentiles of each generator, not guesses.
 */
const spread = (v, mid, gain) => Math.min(1, Math.max(0, 0.5 + (v - mid) * gain));

export function habitat(x, z, seed = 0) {
  // Damp hollows and dry rises: the dominant metre-scale structure.
  const moisture = spread(fbm2(x * 0.42 + 11.3, z * 0.42 - 4.7, 4, 2.0, 0.5, seed), 0.533, 2.50);
  // Openness: sheltered, rank grass versus open, sun-baked turf.
  const exposure = spread(fbm2(x * 0.31 - 21.7, z * 0.31 + 8.9, 3, 2.0, 0.5, seed + 977), 0.616, 2.68);
  // Grazing and trampling. Squared before the stretch, so the trodden ground
  // is patchy with edges -- paths and rabbit lawns are not a gradient.
  const g = fbm2(x * 0.66 + 5.1, z * 0.66 + 31.4, 3, 2.0, 0.5, seed + 4231);
  const grazing = spread(g * g * 1.35, 0.417, 2.10);
  return { moisture, exposure, grazing };
}

/** How well a species does at a point: a product of Gaussian fits, in [0,1]. */
export function suitability(species, h) {
  const n = species.niche;
  const dm = (h.moisture - n.moisture) / n.tolerance;
  const de = (h.exposure - n.exposure) / 0.42;
  // Short-turf specialists need the grazing; tall ones are eaten out by it.
  const turf = 1 - Math.abs(h.grazing - n.shortTurf) * 0.75;
  return Math.exp(-0.5 * dm * dm) * Math.exp(-0.5 * de * de) * Math.max(0.02, turf);
}

/** Uniform grid of cell lists, for the O(1) spacing query. */
class SpatialHash {
  constructor(bounds, cell) {
    this.cell = cell;
    this.x0 = bounds.min[0];
    this.z0 = bounds.min[2];
    this.nx = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / cell));
    this.nz = Math.max(1, Math.ceil((bounds.max[2] - bounds.min[2]) / cell));
    this.cells = Array.from({ length: this.nx * this.nz }, () => []);
  }

  key(x, z) {
    const i = Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.cell)));
    const j = Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.z0) / this.cell)));
    return { i, j };
  }

  insert(x, z, item) {
    const { i, j } = this.key(x, z);
    this.cells[j * this.nx + i].push(item);
  }

  /** True if anything within `radius` rejects the candidate. */
  blocked(x, z, radius, reject) {
    const r = Math.ceil(radius / this.cell);
    const { i, j } = this.key(x, z);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        const ci = i + di, cj = j + dj;
        if (ci < 0 || cj < 0 || ci >= this.nx || cj >= this.nz) continue;
        for (const other of this.cells[cj * this.nx + ci]) {
          if (reject(other)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Grow a field.
 *
 * @param {{min:number[], max:number[]}} bounds  world extent to fill
 * @returns {{plants: object[], stats: object}}
 */
export function growField(bounds, opts = {}) {
  const {
    seed = 1337,
    target = 700,           // plants to aim for; competition may deliver fewer
    habitatSeed = 3,
    bareThreshold = 0.16,   // below this suitability, nothing establishes
  } = opts;
  const rng = makeRng(seed);
  const spanX = bounds.max[0] - bounds.min[0];
  const spanZ = bounds.max[2] - bounds.min[2];
  const area = spanX * spanZ;

  // Cell size at the largest spacing any species asks for, so `blocked` never
  // has to walk more than a 3x3 neighbourhood.
  const maxSpacing = Math.max(...SPECIES.map((s) => s.dispersal.spacing));
  const hash = new SpatialHash(bounds, maxSpacing);
  const plants = [];
  const rejected = { bare: 0, crowded: 0, unsuited: 0 };

  // Split the target between species by relative abundance.
  const totalAbundance = SPECIES.reduce((a, s) => a + s.abundance, 0);

  // Species are processed in a shuffled order rather than in table order: the
  // spacing rule is first-come-first-served, so a fixed order would let the
  // first species claim every good patch and leave the last one the scraps.
  const order = SPECIES.map((s, i) => ({ s, i, k: rng.next() }))
    .sort((a, b) => a.k - b.k);

  for (const { s, i: speciesIndex } of order) {
    const quota = Math.round(target * (s.abundance / totalAbundance));
    const { patchRadius, clumpiness, spacing } = s.dispersal;

    // Parents (patch centres). Drawn by rejection against the species' own
    // suitability, so patches land where the habitat suits -- this is the step
    // that couples ecology to layout rather than just tinting it afterwards.
    const perPatch = Math.max(2, Math.round(6 + 26 * clumpiness));
    const parents = [];
    let guard = 0;
    while (parents.length < Math.ceil(quota / perPatch) && guard++ < 4000) {
      const x = rng.range(bounds.min[0], bounds.max[0]);
      const z = rng.range(bounds.min[2], bounds.max[2]);
      const fit = suitability(s, habitat(x, z, habitatSeed));
      if (fit < bareThreshold) { rejected.bare++; continue; }
      if (rng.next() > fit) { rejected.unsuited++; continue; }
      parents.push([x, z, fit]);
    }
    if (parents.length === 0) continue;

    // Offspring. A fraction escape the patch entirely -- long-distance
    // dispersal is what keeps a meadow from separating into pure stands.
    let placed = 0;
    const attempts = quota * 6;
    for (let a = 0; a < attempts && placed < quota; a++) {
      let x, z;
      if (rng.next() < 0.12 * (1 - clumpiness) + 0.05) {
        x = rng.range(bounds.min[0], bounds.max[0]);
        z = rng.range(bounds.min[2], bounds.max[2]);
      } else {
        const p = parents[(rng.next() * parents.length) | 0];
        // Gaussian dispersal kernel about the parent.
        const ang = rng.range(0, Math.PI * 2);
        const rad = Math.abs(rng.gauss(0, patchRadius * (1.05 - 0.55 * clumpiness)));
        x = p[0] + Math.cos(ang) * rad;
        z = p[1] + Math.sin(ang) * rad;
      }
      if (x < bounds.min[0] || x > bounds.max[0] || z < bounds.min[2] || z > bounds.max[2]) continue;

      const h = habitat(x, z, habitatSeed);
      const fit = suitability(s, h);
      if (fit < bareThreshold) { rejected.bare++; continue; }
      // Establishment is probabilistic in the fit, so patch edges thin out
      // rather than stopping at a contour line.
      if (rng.next() > fit * fit) { rejected.unsuited++; continue; }

      // Competition. A plant excludes its own species at its full rosette
      // radius and other species at a shorter one -- congeners compete harder
      // than strangers, which is what keeps a patch evenly spaced inside while
      // still letting two species interleave at an edge.
      const rSelf = spacing * rng.range(0.85, 1.15);
      if (hash.blocked(x, z, maxSpacing, (o) =>
        (o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) <
        (o.species === speciesIndex
          ? Math.max(rSelf, o.spacing) ** 2
          : (0.55 * (rSelf + o.spacing) * 0.5) ** 2))) {
        rejected.crowded++;
        continue;
      }

      // Vigour tracks the habitat: the best ground grows the biggest plants,
      // which is most of why a good patch reads as a good patch.
      const ind = individual(s, rng, 0.62 + 0.62 * fit);
      const plant = {
        x, z, species: speciesIndex, spacing: rSelf,
        headRadius: headRadius(s) * ind.scale,
        fit, ...ind,
      };
      plants.push(plant);
      hash.insert(x, z, plant);
      placed++;
    }
  }

  // Deterministic draw order that is not species-major, so any per-frame cap
  // that clips the tail cannot silently delete one whole species.
  plants.sort((a, b) => (a.x * 7919 + a.z * 104729) - (b.x * 7919 + b.z * 104729));

  const counts = {};
  for (const p of plants) counts[SPECIES[p.species].key] = (counts[SPECIES[p.species].key] || 0) + 1;
  return {
    plants,
    stats: {
      count: plants.length, area, perSquareMetre: plants.length / area,
      counts, rejected,
    },
  };
}

// ---------------------------------------------------------------------------
// GPU packing
// ---------------------------------------------------------------------------

/**
 * Field order of one PlantInstance, which MUST match the struct in
 * instance.wgsl. Named slots rather than source order, for the same reason
 * buildFloretInstances uses them: a struct of vec4f packs as contiguous
 * floats, so getting the order wrong silently shifts every field and the
 * failure looks like a rendering bug rather than a layout one.
 */
export const PLANT_INSTANCE_FLOATS = 40;
const P = {
  baseX: 0, baseY: 1, baseZ: 2, scale: 3,
  axisX: 4, axisY: 5, axisZ: 6, stemHeight: 7,
  yawC: 8, yawS: 9, headRadius: 10, discRadius: 11,
  bloom: 12, front: 13, variant: 14, rayCount: 15,
  floretBase: 16, floretCount: 17, species: 18, windGain: 19,
  rayR: 20, rayG: 21, rayB: 22, guide: 23,
  tipR: 24, tipG: 25, tipB: 26, tipReach: 27,
  discR: 28, discG: 29, discB: 30, pollen: 31,
  leafR: 32, leafG: 33, leafB: 34, senescence: 35,
  transR: 36, transG: 37, transB: 38, leafTransmit: 39,
};

/**
 * Flatten the field into the buffer the shaders read.
 *
 * @param {object[]} plants
 * @param {{floretBase:number, floretCount:number, headRadius:number,
 *          rayCount:number}[]} speciesInfo  one entry per species, in table order
 */
export function packPlantInstances(plants, speciesInfo) {
  const data = new Float32Array(plants.length * PLANT_INSTANCE_FLOATS);
  plants.forEach((p, i) => {
    const s = SPECIES[p.species];
    const info = speciesInfo[p.species];
    const o = i * PLANT_INSTANCE_FLOATS;
    // Rest axis: a stem that leans, in the direction it leans. The solver pins
    // node 1 along this, so it is the plant's posture rather than a wobble.
    const sinL = Math.sin(p.lean), cosL = Math.cos(p.lean);
    data[o + P.baseX] = p.x;
    data[o + P.baseY] = 0;
    data[o + P.baseZ] = p.z;
    data[o + P.scale] = p.scale;
    data[o + P.axisX] = Math.cos(p.leanDir) * sinL;
    data[o + P.axisY] = cosL;
    data[o + P.axisZ] = Math.sin(p.leanDir) * sinL;
    data[o + P.stemHeight] = p.stemHeight;
    data[o + P.yawC] = Math.cos(p.yaw);
    data[o + P.yawS] = Math.sin(p.yaw);
    data[o + P.headRadius] = info.headRadius;
    data[o + P.discRadius] = s.head.discRadius;
    data[o + P.bloom] = p.bloom;
    data[o + P.front] = p.front;
    data[o + P.variant] = p.variant;
    data[o + P.rayCount] = info.silhouetteRays;
    data[o + P.floretBase] = info.floretBase;
    data[o + P.floretCount] = info.floretCount;
    data[o + P.species] = p.species;
    // Beam-derived, so a daisy nods and a cornflower whips; see species.js.
    // The stem's radius scales with the individual, not just the species.
    data[o + P.windGain] = stemWindGain(p.stemHeight, s.stem.baseRadius * p.scale);
    data[o + P.rayR] = p.rayAlbedo[0];
    data[o + P.rayG] = p.rayAlbedo[1];
    data[o + P.rayB] = p.rayAlbedo[2];
    data[o + P.guide] = s.guide;
    data[o + P.tipR] = p.tipAlbedo[0];
    data[o + P.tipG] = p.tipAlbedo[1];
    data[o + P.tipB] = p.tipAlbedo[2];
    data[o + P.tipReach] = s.tipReach;
    data[o + P.discR] = p.discAlbedo[0];
    data[o + P.discG] = p.discAlbedo[1];
    data[o + P.discB] = p.discAlbedo[2];
    // Pollen load: highest on a freshly opened head, gone once the maturation
    // front has swept the disc and the florets have set.
    data[o + P.pollen] = Math.max(0, Math.min(1, (1 - p.front) * p.bloom));
    data[o + P.leafR] = p.leafAlbedo[0];
    data[o + P.leafG] = p.leafAlbedo[1];
    data[o + P.leafB] = p.leafAlbedo[2];
    data[o + P.senescence] = p.senescence;
    data[o + P.transR] = p.rayTransmit[0];
    data[o + P.transG] = p.rayTransmit[1];
    data[o + P.transB] = p.rayTransmit[2];
    data[o + P.leafTransmit] = p.leafTransmit;
  });
  return { data, count: plants.length };
}

/**
 * Bake the habitat into a texture, so the shaders read the SAME field the
 * sampler placed the plants against rather than a lookalike noise.
 *
 * rgb = moisture, exposure, grazing, over a square of half-extent `half`
 * centred on the origin.
 */
export function bakeHabitatMap(half, size = 256, habitatSeed = 3) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size * 2 - 1) * half;
      const z = ((j + 0.5) / size * 2 - 1) * half;
      const h = habitat(x, z, habitatSeed);
      const o = (j * size + i) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(h.moisture * 255)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(h.exposure * 255)));
      data[o + 2] = Math.max(0, Math.min(255, Math.round(h.grazing * 255)));
      data[o + 3] = 255;
    }
  }
  return { data, size };
}
