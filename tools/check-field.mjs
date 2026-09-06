// Checks for the ecological sampler.
//
// A field of flowers is easy to get wrong in ways that look fine in a still
// and wrong the moment you fly across it: species evenly shuffled instead of
// drifting, plants growing on ground that does not suit them, rosettes
// overlapping, one species crowded out by whichever happened to be sampled
// first. None of that is visible in a screenshot and none of it is catchable
// by a type system, so it is measured here instead -- against a null model
// where that is the only honest way to say whether an effect is real.

import { growField, habitat, suitability, packPlantInstances, PLANT_INSTANCE_FLOATS }
  from '../src/geom/field.js';
import { SPECIES, headRadius, rayCount, silhouetteRays } from '../src/geom/species.js';
import { makeRng } from '../src/geom/rand.js';
import { BOUNDS } from '../src/sim/flight.js';
import { readFileSync } from 'node:fs';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const bounds = { min: BOUNDS.min, max: BOUNDS.max };
const t0 = Date.now();
const field = growField(bounds, { target: 700 });
const grow = Date.now() - t0;
const P = field.plants;

console.log('the field grows:');
check('a few hundred plants', P.length > 350 && P.length <= 900,
  `${P.length} over ${field.stats.area.toFixed(1)}m2 = ` +
  `${field.stats.perSquareMetre.toFixed(1)}/m2`);
check('quickly enough to sit on the boot path', grow < 400, `${grow}ms`);
check('every species is represented',
  SPECIES.every((s) => (field.stats.counts[s.key] || 0) > 0),
  Object.entries(field.stats.counts).map(([k, n]) => `${k} ${n}`).join('  '));
check('deterministic for a seed',
  JSON.stringify(growField(bounds, { target: 700 }).plants) === JSON.stringify(P));
check('all inside the play volume', P.every((p) =>
  p.x >= bounds.min[0] && p.x <= bounds.max[0] &&
  p.z >= bounds.min[2] && p.z <= bounds.max[2]));
check('every plant finite and positive', P.every((p) =>
  Number.isFinite(p.x) && Number.isFinite(p.z) && p.stemHeight > 0 &&
  p.headRadius > 0 && p.scale > 0));

// --- competition -----------------------------------------------------------
console.log('\ncompetition keeps them apart:');
{
  let worstSame = Infinity, worstAny = Infinity;
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      const d = Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
      worstAny = Math.min(worstAny, d);
      if (P[i].species === P[j].species) {
        worstSame = Math.min(worstSame, d / Math.max(P[i].spacing, P[j].spacing));
      }
    }
  }
  // Conspecifics exclude each other at their full rosette radius; the rule is
  // relaxed between species, so only the within-species bound is exact.
  check('no two of a species inside each other\'s rosette', worstSame >= 0.999,
    `closest is ${worstSame.toFixed(3)} of the exclusion radius`);
  check('nothing is coincident', worstAny > 1e-4, `closest pair ${(worstAny * 1000).toFixed(1)}mm`);
}

// --- dispersal -------------------------------------------------------------
console.log('\nspecies come in drifts, not a shuffled deck:');
{
  const meanSameNN = (labels) => {
    let sum = 0, n = 0;
    for (let i = 0; i < P.length; i++) {
      let best = Infinity;
      for (let j = 0; j < P.length; j++) {
        if (i === j || labels[j] !== labels[i]) continue;
        const d = Math.hypot(P[i].x - P[j].x, P[i].z - P[j].z);
        if (d < best) best = d;
      }
      if (Number.isFinite(best)) { sum += best; n++; }
    }
    return sum / Math.max(1, n);
  };
  const observed = meanSameNN(P.map((p) => p.species));
  // Null model: the same plants in the same places, with their species labels
  // shuffled. That holds the density, the spacing rule and the abundances
  // fixed and varies only who is next to whom -- so a difference is
  // aggregation and nothing else.
  const rng = makeRng(99);
  let nullSum = 0;
  const R = 6;
  for (let r = 0; r < R; r++) {
    const sh = P.map((p) => p.species);
    for (let i = sh.length - 1; i > 0; i--) {
      const j = (rng.next() * (i + 1)) | 0;
      [sh[i], sh[j]] = [sh[j], sh[i]];
    }
    nullSum += meanSameNN(sh);
  }
  const expected = nullSum / R;
  check('a plant\'s nearest conspecific is closer than chance',
    observed < expected * 0.85,
    `observed ${observed.toFixed(4)}m vs ${expected.toFixed(4)}m shuffled ` +
    `(${((1 - observed / expected) * 100).toFixed(0)}% aggregation)`);
}

// --- habitat ---------------------------------------------------------------
console.log('\nplants grow where the habitat suits them:');
{
  // Paired null: for each plant, score its OWN species where it actually
  // stands against the same species at a random point in the field. That
  // holds the species mix fixed, so the only thing being measured is whether
  // the sampler put each plant somewhere that suits it -- which a plain
  // "average suitability" comparison cannot say, because a generalist scores
  // well everywhere and drags the baseline up with it.
  const rng = makeRng(4242);
  let occupied = 0, random = 0, better = 0;
  for (const p of P) {
    const s = SPECIES[p.species];
    const here = suitability(s, habitat(p.x, p.z, 3));
    const there = suitability(s, habitat(rng.range(bounds.min[0], bounds.max[0]),
                                         rng.range(bounds.min[2], bounds.max[2]), 3));
    occupied += here;
    random += there;
    if (here > there) better++;
  }
  occupied /= P.length; random /= P.length;
  const frac = better / P.length;
  check('a plant\'s own ground suits it better than random ground',
    occupied > random * 1.4 && frac > 0.7,
    `mean suitability ${occupied.toFixed(3)} vs ${random.toFixed(3)}, ` +
    `${(frac * 100).toFixed(0)}% of plants better placed than chance`);

  // Vigour is drawn from the fit, so the good ground should carry the big
  // plants -- which is most of why a good patch reads as a good patch.
  const sorted = [...P].sort((a, b) => a.fit - b.fit);
  const lowQ = sorted.slice(0, Math.floor(P.length / 4));
  const highQ = sorted.slice(-Math.floor(P.length / 4));
  const mean = (a, f) => a.reduce((n, p) => n + f(p), 0) / a.length;
  check('the best ground grows the biggest plants',
    mean(highQ, (p) => p.scale) > mean(lowQ, (p) => p.scale) * 1.12,
    `scale ${mean(lowQ, (p) => p.scale).toFixed(3)} -> ${mean(highQ, (p) => p.scale).toFixed(3)}`);

  // Two species with opposite niches should not be neighbours as often as
  // chance would have them.
  const dry = SPECIES.findIndex((s) => s.key === 'cornflower');
  const wet = SPECIES.findIndex((s) => s.key === 'mayweed');
  const wetness = (i) => {
    const list = P.filter((p) => p.species === i);
    return list.reduce((n, p) => n + habitat(p.x, p.z, 3).moisture, 0) / Math.max(1, list.length);
  };
  check('the wet-ground species really is on the wet ground',
    wetness(wet) > wetness(dry) + 0.10,
    `mayweed ${wetness(wet).toFixed(3)} vs cornflower ${wetness(dry).toFixed(3)}`);
}

// --- colour ----------------------------------------------------------------
console.log('\ncolour is a pigment load, not a random hue:');
{
  // Within a species every ray colour must lie on the same pigment axis: the
  // whole point of species.js is that you cannot draw a colour no flower has.
  // Measured as the spread of hue within a species against the spread across
  // the field, which is what the eye is actually reading.
  const hue = (c) => Math.atan2(Math.sqrt(3) * (c[1] - c[2]), 2 * c[0] - c[1] - c[2]);
  const spread = (list) => {
    if (list.length < 2) return 0;
    const h = list.map((p) => hue(p.rayAlbedo));
    const sx = h.reduce((n, a) => n + Math.cos(a), 0) / h.length;
    const sy = h.reduce((n, a) => n + Math.sin(a), 0) / h.length;
    return 1 - Math.hypot(sx, sy);           // circular variance
  };
  const within = SPECIES.map((_, i) => spread(P.filter((p) => p.species === i)));
  const across = spread(P);
  check('hue varies far less within a species than across the field',
    Math.max(...within) < across * 0.5,
    `worst species ${Math.max(...within).toFixed(4)} vs field ${across.toFixed(4)}`);
  check('nothing is out of gamut', P.every((p) =>
    p.rayAlbedo.every((c) => c >= 0 && c <= 1) &&
    p.discAlbedo.every((c) => c >= 0 && c <= 1) &&
    p.rayTransmit.every((c) => c > 0 && c < 1)));
}

// --- packing ---------------------------------------------------------------
console.log('\nthe GPU packing survives the trip:');
{
  let base = 0;
  const info = SPECIES.map((s) => {
    const r = { floretBase: base, floretCount: s.head.floretCount,
                headRadius: headRadius(s), rayCount: rayCount(s),
                silhouetteRays: silhouetteRays(s) };
    base += s.head.floretCount;
    return r;
  });
  // The floret draw multiplexes plant and floret onto one instance index with
  // a constant stride, so a species that outgrew it would silently draw
  // another plant's florets.
  const stride = /FLORETS_PER_PLANT : u32 = (\d+)u/.exec(
    readFileSync('src/shaders/floret.wgsl', 'utf8'));
  check('no species outgrows the floret instance stride',
    stride && SPECIES.every((s) => s.head.floretCount <= Number(stride[1])),
    `largest ${Math.max(...SPECIES.map((s) => s.head.floretCount))} of ${stride ? stride[1] : '?'}`);

  const packed = packPlantInstances(P, info);
  check('one record per plant', packed.data.length === P.length * PLANT_INSTANCE_FLOATS);
  check('all finite', packed.data.every(Number.isFinite));
  let unit = true, upright = true;
  for (let i = 0; i < P.length; i++) {
    const o = i * PLANT_INSTANCE_FLOATS;
    const l = Math.hypot(packed.data[o + 4], packed.data[o + 5], packed.data[o + 6]);
    if (Math.abs(l - 1) > 1e-5) unit = false;
    // The solver normalises the rest axis, but a stem that leaned past
    // horizontal would be a plant lying on the ground.
    if (packed.data[o + 5] < 0.9) upright = false;
  }
  check('every rest axis is a unit vector', unit);
  check('and no stem leans past 25 degrees', upright);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall field checks passed');
process.exit(failures ? 1 : 0);
