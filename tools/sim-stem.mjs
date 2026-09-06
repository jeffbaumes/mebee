// Offline port of the GPU stem solver, to check stability without a GPU.
// Mirrors src/shaders/wind.wgsl: same integrator, constraints and ordering.

const STEM_NODES = 16;

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

export function simulate(opts = {}) {
  const {
    seconds = 12, fps = 60, strength = 0.55, windDir = 0.9,
    force = 9.0, damping = 0.985, bend = 0.28, iterations = 8,
    fixedDt = null, gravity = 0.045, stemHeight = 0.40, jitterFps = false,
    pinBase = false, restBias = 0.0, substeps = 1,
  } = opts;

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
    pos.push([0, i * segLen, 0]);
    prev.push([0, i * segLen, 0]);
  }

  const tipPath = [];
  let maxStep = 0, maxDeflect = 0, blewUp = false;
  const frames = Math.round(seconds * fps);

  for (let f = 0; f < frames; f++) {
    // Real frame times wobble; the shader clamps dt to [1/240, 1/30].
    let dt = jitterFps ? (1 / fps) * (0.6 + Math.random() * 0.9) : 1 / fps;
    dt = fixedDt ?? Math.min(1 / 30, Math.max(1 / 240, dt));
    const t = f / fps;

    const before = pos[STEM_NODES - 1].slice();

    for (let i = 1; i < STEM_NODES; i++) {
      const restH = i / (STEM_NODES - 1);
      const drag = windAt(pos[i], t);
      const expose = restH * restH;
      const accel = [
        drag[0] * force * expose,
        drag[1] * force * expose - 9.81 * gravity,
        drag[2] * force * expose,
      ];
      const next = pos[i].map((p, k) =>
        p + (p - prev[i][k]) * damping + accel[k] * dt * dt);
      prev[i] = pos[i];
      pos[i] = next;
    }

    for (let it = 0; it < iterations; it++) {
      pos[0] = [0, 0, 0];
      // Anchoring the base DIRECTION as well as its position is what makes
      // this a stem rather than a rope hanging from a point.
      if (pinBase) pos[1] = [0, segLen, 0];
      for (let i = pinBase ? 2 : 1; i < STEM_NODES; i++) {
        const a = pos[i - 1];
        const d = pos[i].map((v, k) => v - a[k]);
        const l = Math.max(1e-6, Math.hypot(...d));
        pos[i] = a.map((v, k) => v + d[k] * (segLen / l));
      }
      for (let i = 2; i < STEM_NODES; i++) {
        const a = pos[i - 2], b = pos[i - 1];
        const dv = b.map((v, k) => v - a[k]);
        const l = Math.max(1e-6, Math.hypot(...dv));
        // Blend the bend target between "straight on from the parent" and the
        // rest pose (vertical). restBias is the stem's memory of its own shape:
        // straightness alone lets the whole chain lean over and stay there.
        const cont = dv.map((v) => v / l);
        const mixed = cont.map((v, k) => v * (1 - restBias) + [0, 1, 0][k] * restBias);
        const ml = Math.max(1e-6, Math.hypot(...mixed));
        const target = b.map((v, k) => v + (mixed[k] / ml) * segLen);
        pos[i] = pos[i].map((v, k) => v + (target[k] - v) * bend);
      }
    }

    const tip = pos[STEM_NODES - 1];
    if (!tip.every(Number.isFinite)) { blewUp = true; break; }
    const step = Math.hypot(...tip.map((v, k) => v - before[k]));
    if (f > fps) {                                  // ignore the initial settle
      maxStep = Math.max(maxStep, step);
      maxDeflect = Math.max(maxDeflect, Math.hypot(tip[0], tip[2]));
    }
    tipPath.push(tip.slice());
  }

  // Oscillation rate from zero crossings about the tip's OWN mean: wind blows
  // the stem to one side, so crossings about the origin never happen and the
  // stem reads as frozen when it is in fact swaying around an offset.
  const settled = tipPath.slice(fps);
  const meanX = settled.reduce((a, p) => a + p[0], 0) / Math.max(1, settled.length);
  let crossings = 0;
  for (let i = 1; i < settled.length; i++) {
    if ((settled[i - 1][0] - meanX) * (settled[i][0] - meanX) < 0) crossings++;
  }
  const hz = crossings / 2 / Math.max(1e-6, settled.length / fps);
  // How far the tip actually travels, i.e. whether it looks alive at all.
  const xs = settled.map((p) => p[0]), zs = settled.map((p) => p[2]);
  const swayMm = 1000 * Math.max(Math.max(...xs) - Math.min(...xs),
                                 Math.max(...zs) - Math.min(...zs));

  return {
    blewUp,
    tipDeflectMm: +(maxDeflect * 1000).toFixed(1),
    maxStepMm: +(maxStep * 1000).toFixed(2),
    oscillationHz: +hz.toFixed(2),
    swayMm: +swayMm.toFixed(1),
    finalTip: tipPath.length ? tipPath[tipPath.length - 1].map((v) => +v.toFixed(4)) : null,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('current shipped settings:');
  console.log(' ', JSON.stringify(simulate()));
  console.log('  with jittery frame times:');
  console.log(' ', JSON.stringify(simulate({ jitterFps: true })));
}
