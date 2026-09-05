// Deterministic RNG + value/gradient noise shared by CPU generators.
// Every procedural asset seeds from here so a given seed always rebuilds the
// identical flower — otherwise you can't iterate on a look you liked.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small helper bundle: uniform, signed, ranged, gaussian, pick. */
export function makeRng(seed) {
  const r = mulberry32(seed);
  return {
    next: r,
    /** Uniform in [lo, hi). */
    range: (lo, hi) => lo + r() * (hi - lo),
    /** Uniform in [-a, a). */
    sym: (a) => (r() * 2 - 1) * a,
    /** Approx normal via Box-Muller, clamped to +/-3 sigma. */
    gauss: (mu = 0, sigma = 1) => {
      const u = Math.max(1e-9, r()), v = r();
      const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mu + sigma * Math.max(-3, Math.min(3, g));
    },
    pick: (arr) => arr[(r() * arr.length) | 0],
  };
}

// ---------------------------------------------------------------------------
// 2D value noise with quintic interpolation. Used for petal edge irregularity,
// blemish masks and albedo mottling. Cheap and plenty for surface detail.
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = quintic(xf), v = quintic(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal sum. Returns roughly [0,1]. */
export function fbm2(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5, seed = 0) {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(x * f, y * f, seed + i * 131);
    norm += amp;
    amp *= gain; f *= lacunarity;
  }
  return sum / norm;
}
