// Offline port of the GPU stem solver, to check stability without a GPU.
// Mirrors src/shaders/wind.wgsl: same integrator, same constraints, same
// red/black ordering, same fixed timestep. The defaults ARE the shipped
// values, taken from the shader and from FLOWER, so `node tools/sim-stem.mjs`
// reports what the plant actually does rather than what some older tuning did.

import { FLOWER } from '../src/geom/flower.js';
import { SPECIES, stemWindGain } from '../src/geom/species.js';
import { growField } from '../src/geom/field.js';
import { BOUNDS } from '../src/sim/flight.js';

const STEM_NODES = 16;
export const FIXED_DT = 1 / 60;   // must match wind.wgsl
const MAX_SUBSTEPS = 4;
// The refresh intervals real displays actually run at, and never longer than
// FIXED_DT. A stiff Verlet chain gains energy with step length -- stepping at
// 1/48 instead of 1/60 grew the tip's sway by half -- so a slow machine runs
// the plant slow rather than running it wilder than it was tuned for.
const REFRESH_LADDER = [1 / 144, 1 / 120, 1 / 90, 1 / 75, 1 / 60];

const fract = (x) => x - Math.floor(x);
function hash33(p) {
  let x = fract(p[0] * 0.1031), y = fract(p[1] * 0.1030), z = fract(p[2] * 0.0973);
  const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
  x += d; y += d; z += d;
  return [fract((x + y) * z), fract((x + x) * y), fract((y + x) * x)];
}
function valueNoise3(p) {
  const i = p.map(Math.floor), f = p.map((v, k) => v - i[k]);
  const u = f.map((t) => t * t * t * (t * (t * 6 - 15) + 10));
  let acc = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const o = [dx, dy, dz];
    const w = o.map((oc, k) => (oc ? u[k] : 1 - u[k]));
    acc += hash33(i.map((v, k) => v + o[k]))[0] * w[0] * w[1] * w[2];
  }
  return acc;
}
function fbm3(p, oct) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * valueNoise3(p.map((v) => v * freq));
    norm += amp; amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

/**
 * How many fixed steps a frame runs.
 *
 *   'rounded'  - what the shader used to do: round the instantaneous frame
 *                time to a whole number of steps, keeping no remainder.
 *   'accum'    - bank the real elapsed time and spend it a whole step at a
 *                time, so the simulated clock tracks the wall clock.
 *   'catchup1' - the same bank, but never more than one step per frame. A
 *                hitch leaves the plant a few milliseconds behind wall time,
 *                which nobody can see, instead of lurching to catch up.
 *   'snapped'  - one step per frame, its length locked to the nearest STANDARD
 *                refresh interval and changed only when the display's own
 *                rate really changes. What destabilises this solver is dt
 *                MOVING, not its value; snapping holds it exactly constant
 *                for a whole session while still matching a 144Hz screen.
 *   'smoothed' - one step per frame, its length a slow average of the real
 *                frame time. dt is what must not change abruptly; its VALUE
 *                is free. An average is near-constant frame to frame, so the
 *                solve stays as stable as a fixed step, while still tracking
 *                the display's actual rate -- so the sway runs at the right
 *                speed on a 144Hz screen instead of 2.3x too fast. A hitch is
 *                one clamped sample in a long window and barely moves it.
 *   'tcv'      - one step per frame at the REAL frame time, with the Verlet
 *                velocity rescaled by dt/dtPrev. Plain Verlet carries
 *                `pos - prev` as a velocity that silently assumes the last
 *                step was the same length as this one, which is what made a
 *                frame-time-driven solve explode; correcting by the ratio is
 *                the standard fix and makes a variable step legitimate.
 *
 * Rate matters less than smoothness here: there is no interpolation between
 * solves, so every extra or skipped step lands on screen as a jump.
 */
function makeStepper(policy) {
  let accum = 0;
  return (dt) => {
    if (policy === 'rounded') {
      return Math.trunc(Math.min(MAX_SUBSTEPS, Math.max(1, dt / FIXED_DT)) + 0.5);
    }
    if (policy !== 'rounded' && policy !== 'accum' && policy !== 'catchup1') return 1;
    accum += dt;
    const cap = policy === 'catchup1' ? 1 : MAX_SUBSTEPS;
    let steps = Math.floor(accum / FIXED_DT);
    if (steps > cap) { steps = cap; accum = 0; }
    else accum -= steps * FIXED_DT;
    return steps;
  };
}

export function simulate(opts = {}) {
  // Defaults mirror wind.wgsl exactly. Changing one here without changing the
  // shader makes this tool lie, which is worse than not having it.
  const {
    seconds = 12, fps = 60, strength = 0.55, windDir = 0.9,
    force = 12.0, damping = 0.96, bend = 0.28, iterations = 8,
    gravity = 0.045, stemHeight = FLOWER.stemHeight, restBias = 0.10,
    jitterFps = false, policy = 'catchup1', hitches = false,
    // The plant's own rest direction. Most stems in the field lean a little,
    // and the solver pins node 1 along this and bends back toward it, so a
    // leaning stem is a different mechanical problem from an upright one.
    lean = 0, leanDir = 0,
    // Per-plant cantilever gain on the wind force; see stemWindGain() in
    // species.js. 1 is the reference ox-eye, which is what every other row in
    // this tool's output is measured against.
    windGain = 1,
  } = opts;

  const restAxis = [Math.cos(leanDir) * Math.sin(lean), Math.cos(lean),
                    Math.sin(leanDir) * Math.sin(lean)];
  const segLen = stemHeight / (STEM_NODES - 1);
  const dir = [Math.cos(windDir), 0, Math.sin(windDir)];
  const windAt = (p, t) => {
    const phase = p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
    const ph = phase * 1.35 - t * 2.1;
    const front = Math.pow(0.5 + 0.5 * Math.sin(ph), 3.0);
    const breadth = fbm3([p[0] * 0.7, p[1] * 0.7, p[2] * 0.7 + t * 0.3], 3);
    const gust = front * (0.45 + 0.9 * breadth);
    const n = [
      fbm3([p[0] * 7 + t * 1.7, p[1] * 7, p[2] * 7], 3) - 0.5,
      fbm3([p[0] * 7, p[1] * 7 + t * 1.3, p[2] * 7 + 11], 3) - 0.5,
      fbm3([p[0] * 7, p[1] * 7, p[2] * 7 + t * 1.9 + 23], 3) - 0.5,
    ];
    return dir.map((d, k) => d * strength * (0.30 + 1.70 * gust) + n[k] * strength * 0.55);
  };

  const pos = [], prev = [];
  for (let i = 0; i < STEM_NODES; i++) {
    const p = restAxis.map((a) => a * i * segLen);
    pos.push(p.slice());
    prev.push(p.slice());
  }

  const tipPath = [];
  let maxStep = 0, maxDeflect = 0, blewUp = false;
  const frames = Math.round(seconds * fps);
  const stepper = makeStepper(policy);
  // Deterministic frame-time wobble, so two policies see the identical
  // sequence and the comparison is about the policy and nothing else.
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  let simTime = 0, prevH = FIXED_DT, smoothH = FIXED_DT, snapH = FIXED_DT;
  for (let f = 0; f < frames; f++) {
    let dt = jitterFps ? (1 / fps) * (0.6 + rand() * 0.9) : 1 / fps;
    // A GC pause, a texture upload, a tab regaining focus. main.js clamps the
    // frame time to 50ms, so this is the worst a single frame can report.
    if (hitches && f % 97 === 0) dt = 0.050;
    const before = pos[STEM_NODES - 1].slice();
    const substeps = stepper(dt);

    for (let s = 0; s < substeps; s++) {
      // The wind is sampled at the substep's own time, so a frame that runs
      // two steps does not apply one instant's gust twice.
      const t = simTime;
      // Under tcv the step is the real frame time, clamped so one bad frame
      // cannot inject a huge accel*dt^2 impulse; otherwise it is the fixed step.
      // Clamp first: one runaway frame must not reach the integrator at all.
      const clamped = Math.min(1 / 45, Math.max(1 / 240, dt));
      let h = FIXED_DT;
      if (policy === 'tcv') h = clamped;
      else if (policy === 'smoothed') { smoothH += (clamped - smoothH) * 0.03; h = smoothH; }
      else if (policy === 'snapped') {
        smoothH += (clamped - smoothH) * 0.03;
        // Switch rungs only when the average is decisively nearer another one,
        // so a display sitting between two rates cannot oscillate between them.
        for (const rung of REFRESH_LADDER) {
          if (Math.abs(smoothH - rung) < Math.abs(smoothH - snapH) * 0.80) snapH = rung;
        }
        h = snapH;
      }
      // Rescale the carried velocity when the step length changes. Clamped:
      // an unbounded ratio turns one long frame into a slingshot.
      const ratio = (policy === 'tcv' || policy === 'smoothed')
        ? Math.min(2, Math.max(0.5, h / prevH))
        : 1;
      prevH = h;
      simTime += h;

      for (let i = 1; i < STEM_NODES; i++) {
        const restH = i / (STEM_NODES - 1);
        const drag = windAt(pos[i], t);
        const expose = restH * restH * windGain;
        const accel = [
          drag[0] * force * expose,
          drag[1] * force * expose - 9.81 * gravity,
          drag[2] * force * expose,
        ];
        const next = pos[i].map((p, k) =>
          p + (p - prev[i][k]) * ratio * damping + accel[k] * h * h);
        prev[i] = pos[i];
        pos[i] = next;
      }

      for (let it = 0; it < iterations; it++) {
        // Pinning node 1 as well as node 0 anchors the base DIRECTION, not
        // just its position, which is what makes this a stem and not a rope.
        pos[0] = [0, 0, 0];
        pos[1] = restAxis.map((a) => a * segLen);
        // Red/black, as in the shader: neighbours never fight over one node
        // inside a pass, so both see the same values a parallel solve does.
        for (let parity = 0; parity < 2; parity++) {
          for (let i = 2; i < STEM_NODES; i++) {
            if (i % 2 !== parity) continue;
            const a = pos[i - 1];
            const d = pos[i].map((v, k) => v - a[k]);
            const l = Math.max(1e-6, Math.hypot(...d));
            pos[i] = a.map((v, k) => v + d[k] * (segLen / l));
          }
        }
        for (let i = 2; i < STEM_NODES; i++) {
          const a = pos[i - 2], b = pos[i - 1];
          const dv = b.map((v, k) => v - a[k]);
          const l = Math.max(1e-6, Math.hypot(...dv));
          // The bend target blends the parent's continuation with the rest
          // pose, so the stem remembers being upright, not merely straight.
          const cont = dv.map((v) => v / l);
          const mixed = cont.map((v, k) => v * (1 - restBias) + restAxis[k] * restBias);
          const ml = Math.max(1e-6, Math.hypot(...mixed));
          const target = b.map((v, k) => v + (mixed[k] / ml) * segLen);
          pos[i] = pos[i].map((v, k) => v + (target[k] - v) * bend);
        }
      }
    }

    const tip = pos[STEM_NODES - 1];
    if (!tip.every(Number.isFinite)) { blewUp = true; break; }
    // Per-FRAME movement: this is what the eye sees, and the number that goes
    // wrong when the step count flickers between 1 and 2.
    const step = Math.hypot(...tip.map((v, k) => v - before[k]));
    if (f > fps) {
      maxStep = Math.max(maxStep, step);
      maxDeflect = Math.max(maxDeflect, Math.hypot(tip[0], tip[2]));
    }
    tipPath.push(tip.slice());
  }

  const settled = tipPath.slice(fps);
  // Oscillation rate from zero crossings about the tip's OWN mean: wind blows
  // the stem to one side, so crossings about the origin never happen and the
  // stem reads as frozen when it is in fact swaying around an offset.
  const meanX = settled.reduce((a, p) => a + p[0], 0) / Math.max(1, settled.length);
  let crossings = 0;
  for (let i = 1; i < settled.length; i++) {
    if ((settled[i - 1][0] - meanX) * (settled[i][0] - meanX) < 0) crossings++;
  }
  const hz = crossings / 2 / Math.max(1e-6, settled.length / fps);
  const xs = settled.map((p) => p[0]), zs = settled.map((p) => p[2]);
  const swayMm = 1000 * Math.max(Math.max(...xs) - Math.min(...xs),
                                 Math.max(...zs) - Math.min(...zs));
  // Frame-to-frame CHANGE in step size. A stem swaying smoothly moves a
  // similar amount each frame; one that lurches does not. This is the jitter.
  let jerk = 0;
  for (let i = 2; i < settled.length; i++) {
    const a = Math.hypot(...settled[i].map((v, k) => v - settled[i - 1][k]));
    const b = Math.hypot(...settled[i - 1].map((v, k) => v - settled[i - 2][k]));
    jerk = Math.max(jerk, Math.abs(a - b));
  }

  return {
    blewUp,
    tipDeflectMm: +(maxDeflect * 1000).toFixed(1),
    maxStepMm: +(maxStep * 1000).toFixed(2),
    maxJerkMm: +(jerk * 1000).toFixed(2),
    oscillationHz: +hz.toFixed(2),
    swayMm: +swayMm.toFixed(1),
    finalTip: tipPath.length ? tipPath[tipPath.length - 1].map((v) => +v.toFixed(4)) : null,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const show = (label, o) => console.log(`  ${label.padEnd(14)}`, JSON.stringify(simulate(o)));

  // The field spans a 78mm common daisy to a 330mm cornflower, so the segment
  // length varies more than fourfold and the same integrator has to stay
  // stable across all of it. Nothing in the shader is scaled per species on
  // purpose -- see the comment on `expose` in wind.wgsl -- so this is where
  // that decision is checked rather than assumed.
  // The field, not a guess at it. Every plant carries its own height and its
  // own cantilever gain (species.js), and the two are correlated through
  // vigour -- a big plant is both taller and thicker -- so the extremes have
  // to be taken from the actual generator rather than from the corners of the
  // parameter box, which contains combinations nothing ever grows into.
  console.log('every stem the field actually grows, at the shipped policy:');
  const field = growField({ min: BOUNDS.min, max: BOUNDS.max }, { target: 700 });
  let unstable = 0;
  for (const [i, sp] of SPECIES.entries()) {
    const mine = field.plants.filter((p) => p.species === i).map((p) => ({
      h: p.stemHeight,
      gain: stemWindGain(p.stemHeight, sp.stem.baseRadius * p.scale),
      lean: p.lean,
    })).sort((a, b) => a.gain - b.gain);
    if (mine.length === 0) continue;
    const pick = [mine[0], mine[mine.length >> 1], mine[mine.length - 1]];
    const rows = pick.map(({ h, gain, lean }, k) => {
      const o = simulate({ stemHeight: h, windGain: gain, lean, leanDir: 1.1, policy: 'snapped' });
      // Instability is a LURCH, not a large sway: a stem in a gust genuinely
      // moves. maxJerk is the frame-to-frame change in step size, which is
      // what you actually see go wrong.
      if (o.blewUp || o.maxJerkMm > 0.5) unstable++;
      return `${['min', 'med', 'max'][k]} ${gain.toFixed(2)}x ` +
             `${String(o.swayMm).padStart(5)}mm/${String(o.maxJerkMm).padStart(4)}jerk`;
    });
    console.log(`  ${sp.key.padEnd(11)} n=${String(mine.length).padStart(3)}   ${rows.join('   ')}`);
  }
  // And at the top of the wind slider, which is nearly four times the default.
  const gusty = SPECIES.map((sp, i) => {
    const mine = field.plants.filter((p) => p.species === i);
    if (!mine.length) return null;
    const worst = mine.reduce((a, b) =>
      stemWindGain(a.stemHeight, sp.stem.baseRadius * a.scale) >
      stemWindGain(b.stemHeight, sp.stem.baseRadius * b.scale) ? a : b);
    const o = simulate({ stemHeight: worst.stemHeight, lean: worst.lean, leanDir: 1.1,
                         windGain: stemWindGain(worst.stemHeight, sp.stem.baseRadius * worst.scale),
                         strength: 2.0, policy: 'snapped' });
    if (o.blewUp || o.maxJerkMm > 1.2) unstable++;
    return `${sp.key} ${o.swayMm}mm`;
  }).filter(Boolean);
  console.log(`  at the top of the wind slider: ${gusty.join('  ')}`);
  console.log(unstable ? `  ${unstable} case(s) lurch at the shipped constants`
                       : '  every stem in the field is stable on one set of constants');

  const policies = ['rounded', 'catchup1', 'one', 'snapped'];
  for (const [name, o] of [
    ['steady 60fps', {}],
    ['steady 40fps', { fps: 40 }],
    ['steady 144fps', { fps: 144 }],
    ['jittery frame times', { jitterFps: true }],
    ['60fps with hitches', { hitches: true }],
    ['jittery + hitches', { jitterFps: true, hitches: true }],
  ]) {
    console.log(`\n${name}:`);
    for (const policy of policies) show(policy, { ...o, policy });
  }
}
