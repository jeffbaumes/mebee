// Does the baked sky table say the same thing the raymarch did?
//
// sky.wgsl used to evaluate skyRadiance() per fragment; it now reads a
// 512x256 lat-long table that sky_lut.wgsl filled. Two things can go wrong
// silently, and both look like a plausible sky:
//
//   * skyUv and skyDirOf stop being exact inverses, so every direction reads
//     the wrong texel and the sky is subtly rotated or squashed;
//   * the table is too coarse where the sky varies fastest -- the horizon
//     band, and the Mie forward lobe around the sun -- and bilinear filtering
//     flattens a gradient into steps.
//
// So: round-trip the mapping, then bake the table with the CPU twin of the
// atmosphere (render/sky.js) and compare a bilinear fetch against the exact
// function over the whole visible hemisphere, at several sun elevations.

import { skyRadiance, ATMOSPHERE } from '../src/render/sky.js';

const W = 512, H = 256;

// Mirrors skyUv/skyDirOf in src/shaders/common.wgsl.
const sign = (x) => (x < 0 ? -1 : 1);
function skyUv(d) {
  const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
  const y = Math.max(-1, Math.min(1, d[1]));
  return [u, 0.5 - 0.5 * sign(y) * Math.sqrt(Math.abs(y))];
}
function skyDirOf(uv) {
  const a = (uv[0] - 0.5) * 2 * Math.PI;
  const t = 1 - 2 * uv[1];
  const y = sign(t) * t * t;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return [Math.cos(a) * r, y, Math.sin(a) * r];
}

let problems = 0;
const fail = (msg) => { console.log(msg); problems++; };

// --- the mapping is its own inverse ---------------------------------------
{
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const z = Math.random() * 2 - 1;
    const a = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - z * z);
    const d = [Math.cos(a) * r, z, Math.sin(a) * r];
    const back = skyDirOf(skyUv(d));
    worst = Math.max(worst, Math.hypot(back[0] - d[0], back[1] - d[1], back[2] - d[2]));
  }
  console.log(`round-trip: worst direction error ${worst.toExponential(2)}`);
  if (worst > 1e-5) fail('skyUv and skyDirOf are not inverses');
}

// --- the table resolves what the raymarch resolved -------------------------
// Relative error in luminance, which is what the eye grades a sky by; an
// absolute error is meaningless across the four stops between zenith and the
// horizon into the sun.
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

for (const elev of [0.06, 0.30, 0.80, 1.35]) {
  const sun = [Math.cos(elev) * Math.sin(2.35), Math.sin(elev), Math.cos(elev) * Math.cos(2.35)];

  // Bake, exactly as sky_lut.wgsl does: one sample at each texel centre.
  const lut = new Float64Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = skyRadiance(skyDirOf([(x + 0.5) / W, (y + 0.5) / H]), sun, ATMOSPHERE);
      const o = (y * W + x) * 3;
      lut[o] = c[0]; lut[o + 1] = c[1]; lut[o + 2] = c[2];
    }
  }

  // Bilinear, repeat in u and clamp in v -- the sampler sky.wgsl binds.
  const fetch = (uv) => {
    const fx = uv[0] * W - 0.5, fy = Math.max(0, Math.min(H - 1, uv[1] * H - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const out = [0, 0, 0];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const xi = ((x0 + i) % W + W) % W;
        const yi = Math.max(0, Math.min(H - 1, y0 + j));
        const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty);
        const o = (yi * W + xi) * 3;
        out[0] += lut[o] * w; out[1] += lut[o + 1] * w; out[2] += lut[o + 2] * w;
      }
    }
    return out;
  };

  let worst = 0, worstAt = null, sum = 0, n = 0;
  for (let i = 0; i < 6000; i++) {
    // Upper hemisphere only: below the horizon sky.wgsl draws ground instead.
    const y = Math.random() * Math.random();      // biased toward the horizon
    const a = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(1 - y * y);
    const d = [Math.cos(a) * r, y, Math.sin(a) * r];
    const exact = lum(skyRadiance(d, sun, ATMOSPHERE));
    if (exact < 1e-6) continue;
    const err = Math.abs(lum(fetch(skyUv(d))) - exact) / exact;
    sum += err; n++;
    if (err > worst) { worst = err; worstAt = d; }
  }
  const mean = sum / n;
  console.log(`sun ${elev.toFixed(2)} rad: mean ${(mean * 100).toFixed(3)}%  ` +
              `worst ${(worst * 100).toFixed(2)}% at elevation ` +
              `${(Math.asin(worstAt[1]) * 180 / Math.PI).toFixed(1)} deg`);
  // A per-texel error under a per cent is well inside the grain the post chain
  // lays over it, let alone a 16-bit render target.
  if (mean > 0.01) fail(`sun ${elev}: mean table error ${(mean * 100).toFixed(2)}% is visible`);
  if (worst > 0.06) fail(`sun ${elev}: worst table error ${(worst * 100).toFixed(2)}%`);
}

console.log(problems ? `\n${problems} problem(s)` : '\nsky table matches the raymarch');
process.exit(problems ? 1 : 0);
