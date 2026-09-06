// Behavioural checks for the culling and level-of-detail selector.
//
// The claim this project is now making is that BLUR, not projected size, is
// what decides how much geometry a plant needs -- so that is what gets tested
// here, directly: hold a flower still, open the aperture, and the tier must
// get coarser even though it covers exactly as many pixels as before. Nothing
// static could catch that going wrong, and nothing visual could either: a
// broken metric just makes the thing slow, or subtly over-detailed, in a way
// that looks fine in a screenshot.
//
// Everything else here is the plumbing that would corrupt the frame rather
// than merely slow it: the draw list is consumed as runs of instances indexed
// by firstInstance, so a run that overlaps another, contains the wrong
// species, or points past the end of the plant table draws the wrong flower.

import fs from 'node:fs';
import { LodSelector, TIER, MESH_TIERS, VISIBLE_WORDS, THRESHOLD, BUDGET, MAX_COC, signedCoC }
  from '../src/render/lod.js';
import { MacroCamera, SENSOR_HEIGHT } from '../src/render/camera.js';
import { growField } from '../src/geom/field.js';
import { SPECIES } from '../src/geom/species.js';
import { BOUNDS } from '../src/sim/flight.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const SCREEN_H = 1080;

/** A camera looking from `eye` toward `at`, focused on the subject. */
function shot({ eye, at, focal = 0.055, fNumber = 4, focus = null }) {
  const cam = new MacroCamera();
  cam.mode = 'fly';
  cam.focalLength = focal;
  cam.fNumber = fNumber;
  cam.autoFocus = false;
  cam.setFly(eye, [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]], [0, 1, 0]);
  cam.focusDistance = focus ?? Math.hypot(at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]);
  cam.update(16 / 9);
  return cam;
}

/** A field of one plant, so a single flower's tier can be read straight off. */
function lone(distance, headRadius = 0.028, stemHeight = 0.30) {
  const plant = { x: 0, z: distance, species: 0, headRadius, stemHeight,
                  spacing: 0.05, scale: 1 };
  return new LodSelector([plant], SPECIES.length);
}

function tierAt(sel, { distance, fNumber, focal = 0.055 }) {
  const cam = shot({ eye: [0, 0.30, 0], at: [0, 0.30, distance], focal, fNumber, focus: 0.30 });
  sel.lastTier.fill(TIER.IMPOSTOR);       // no hysteresis carried between probes
  sel.select(cam, SCREEN_H, SENSOR_HEIGHT);
  return sel.visibleU32[1];
}

// --- the headline claim ----------------------------------------------------
console.log('blur, not size, chooses the tier:');
{
  // One flower, one distance, one focal length. The ONLY thing changing is the
  // aperture, so the projected size in pixels is identical in every row.
  const AT = 0.34;
  const sel = lone(AT);
  const rows = [16, 11, 8, 5.6, 4, 2.8, 2, 1.4].map((f) => ({
    f, tier: tierAt(sel, { distance: AT, fNumber: f }),
    coc: Math.abs(signedCoC(AT, { focusDistance: 0.30, fNumber: f,
      focalLength: 0.055, sensorHeight: SENSOR_HEIGHT }, SCREEN_H)),
  }));
  for (const r of rows) {
    console.log(`         f/${String(r.f).padEnd(4)}  coc ${r.coc.toFixed(1).padStart(5)}px  -> tier ${r.tier}`);
  }
  const monotone = rows.every((r, i) => i === 0 || r.tier >= rows[i - 1].tier);
  check('opening up never asks for MORE geometry', monotone);
  check('and it does ask for less', rows[rows.length - 1].tier > rows[0].tier,
    `f/16 -> tier ${rows[0].tier}, f/1.4 -> tier ${rows[rows.length - 1].tier}`);

  // A flower at the same aperture, moved back: distance must also coarsen it,
  // or the metric has stopped depending on projected size at all.
  const byDistance = [0.30, 0.38, 0.5, 0.9, 2.0, 5.0]
    .map((d) => tierAt(lone(d), { distance: d, fNumber: 8 }));
  check('and distance still coarsens it too',
    byDistance.every((t, i) => i === 0 || t >= byDistance[i - 1]) &&
    byDistance[byDistance.length - 1] > byDistance[0],
    byDistance.join(' -> '));
}

// --- the CoC twin ----------------------------------------------------------
console.log('\nthe CPU and the shader agree about the blur:');
{
  const wgsl = fs.readFileSync('src/shaders/common.wgsl', 'utf8');
  const m = /const MAX_COC\s*=\s*([\d.]+)/.exec(wgsl);
  check('MAX_COC matches common.wgsl', m && Number(m[1]) === MAX_COC,
    `js ${MAX_COC}, wgsl ${m ? m[1] : '?'}`);
  const lens = { focusDistance: 0.30, fNumber: 4, focalLength: 0.055, sensorHeight: SENSOR_HEIGHT };
  check('zero at the focal plane', Math.abs(signedCoC(0.30, lens, SCREEN_H)) < 1e-6);
  check('negative in front of it', signedCoC(0.20, lens, SCREEN_H) < 0);
  check('clamped behind it', Math.abs(signedCoC(9.0, lens, SCREEN_H) - MAX_COC) < 1e-6);
}

// --- culling ---------------------------------------------------------------
console.log('\nculling:');
{
  const sel = lone(0.35);
  const front = shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.35 });
  sel.select(front, SCREEN_H, SENSOR_HEIGHT);
  check('a flower in front of the camera is drawn', sel.stats.visible === 1);

  const behind = shot({ eye: [0, 0.30, 0], at: [0, 0.30, -1], focus: 0.35 });
  sel.select(behind, SCREEN_H, SENSOR_HEIGHT);
  check('the same flower behind it is not', sel.stats.visible === 0,
    `${sel.stats.visible} drawn, ${sel.stats.culled} culled`);

  // A defocused flower does not vanish, it spreads -- so the floor is on the
  // blurred peak, not on the projected size. At three metres a head is two
  // triangles' worth of soft colour and still worth drawing; at sixty its
  // brightest pixel is under half a per cent of the surface it came from.
  const mid = lone(3.0);
  mid.select(shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.35 }), SCREEN_H, SENSOR_HEIGHT);
  check('one three metres off is still worth two triangles', mid.stats.visible === 1);

  const away = lone(60.0);
  away.select(shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.35 }), SCREEN_H, SENSOR_HEIGHT);
  check('one sixty metres off is below the noise floor', away.stats.visible === 0);

  // And the detail slider must never be able to make a flower disappear.
  const biased = lone(3.0);
  biased.bias = 0.15;
  biased.select(shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.35 }), SCREEN_H, SENSOR_HEIGHT);
  check('the detail slider cannot cull, only coarsen', biased.stats.visible === 1);
}

// --- the whole field -------------------------------------------------------
console.log('\nthe real field, from inside it:');
{
  const field = growField({ min: BOUNDS.min, max: BOUNDS.max }, { target: 700 });
  const sel = new LodSelector(field.plants, SPECIES.length);
  let worst = { budgets: true, runs: true, dupes: true, sharp: true, sorted: true };
  let sampled = 0;

  // Sweep the camera through the meadow at bee height, looking every way.
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const eye = [Math.cos(a * 1.7) * 1.6, 0.10 + 0.5 * (k % 5) / 5, Math.sin(a * 1.3) * 1.6];
    const at = [eye[0] + Math.cos(a), eye[1] + 0.1 * Math.sin(a * 3), eye[2] + Math.sin(a)];
    const cam = shot({ eye, at, focal: 0.020, fNumber: 4, focus: 0.25 });
    sel.select(cam, SCREEN_H, SENSOR_HEIGHT);
    sampled += sel.stats.visible;

    for (let t = 0; t < 4; t++) if (sel.stats.tiers[t] > BUDGET[t]) worst.budgets = false;

    // Every run must be a contiguous block of exactly its own tier and species.
    const seen = new Set();
    for (const run of sel.runs) {
      for (let i = run.base; i < run.base + run.count; i++) {
        const o = i * VISIBLE_WORDS;
        const plant = sel.visibleU32[o];
        if (sel.visibleU32[o + 1] !== run.tier) worst.runs = false;
        if (field.plants[plant].species !== run.species) worst.runs = false;
        if (plant >= field.plants.length) worst.runs = false;
        if (seen.has(plant)) worst.dupes = false;
        seen.add(plant);
      }
    }
    for (let i = sel.impostor.base; i < sel.impostor.base + sel.impostor.count; i++) {
      const plant = sel.visibleU32[i * VISIBLE_WORDS];
      if (sel.visibleU32[i * VISIBLE_WORDS + 1] !== TIER.IMPOSTOR) worst.runs = false;
      if (seen.has(plant)) worst.dupes = false;
      seen.add(plant);
    }
    if (seen.size !== sel.stats.visible) worst.dupes = false;

    for (let i = 0; i < sel.stats.visible; i++) {
      const sharp = sel.visibleF32[i * VISIBLE_WORDS + 2];
      const coc = sel.visibleF32[i * VISIBLE_WORDS + 3];
      if (!(sharp >= 0 && sharp <= 1) || !(coc >= 0 && coc <= MAX_COC)) worst.sharp = false;
    }

    // Impostors blend, so they have to arrive far-to-near.
    let prev = Infinity;
    for (let i = sel.impostor.base; i < sel.impostor.base + sel.impostor.count; i++) {
      const p = field.plants[sel.visibleU32[i * VISIBLE_WORDS]];
      const d = Math.hypot(p.x - eye[0], p.stemHeight - eye[1], p.z - eye[2]);
      if (d > prev + 1e-6) worst.sorted = false;
      prev = d;
    }
  }

  check('per-tier budgets are never exceeded', worst.budgets, `caps ${BUDGET.join('/')}`);
  check('every run holds only its own tier and species', worst.runs);
  check('no plant is drawn twice in one frame', worst.dupes);
  check('sharp and coc stay in range', worst.sharp);
  check('impostors are sorted back to front', worst.sorted);
  check('something was actually drawn', sampled > 0, `${sampled} instances over 48 views`);
}

// --- pinning and hysteresis ------------------------------------------------
console.log('\npinning and hysteresis:');
{
  const sel = lone(3.0);
  const cam = shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.30 });
  sel.select(cam, SCREEN_H, SENSOR_HEIGHT);
  check('a distant flower is an impostor', sel.visibleU32[1] === TIER.IMPOSTOR);
  sel.select(cam, SCREEN_H, SENSOR_HEIGHT, 0);
  check('unless it is pinned', sel.visibleU32[1] === TIER.FULL);

  // Sit exactly on a threshold and jitter across it: the tier must not flip.
  const sel2 = lone(0.30);
  const flips = [];
  for (let i = 0; i < 40; i++) {
    const wobble = 0.30 * (1 + (i % 2 ? 0.004 : -0.004));
    const c = shot({ eye: [0, 0.30, 0], at: [0, 0.30, 1], focus: 0.30 });
    c.focusDistance = wobble;
    sel2.select(c, SCREEN_H, SENSOR_HEIGHT);
    flips.push(sel2.visibleU32[1]);
  }
  const settled = flips.slice(4);
  check('a plant on a threshold does not oscillate',
    settled.every((t) => t === settled[0]), `tiers ${[...new Set(flips)].join(',')}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall LOD checks passed');
process.exit(failures ? 1 : 0);
