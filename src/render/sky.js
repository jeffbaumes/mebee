// Single-scattering Rayleigh + Mie atmosphere (Nishita et al.).
//
// Chosen over Preetham/Hosek-Wilkie because it is driven by a handful of
// physical constants rather than dozens of fitted polynomial coefficients: a
// mistyped fit coefficient produces a subtly wrong sky that is very hard to
// spot, while these constants are checkable against physics. It also reddens
// correctly at low sun angles for free, which a fit does not.
//
// This module is the CPU twin of sky.wgsl. It runs at startup to project the
// sky into spherical harmonics for ambient irradiance -- the single most
// important thing separating "lit scene" from "game CG", because it means
// shadowed surfaces are filled by blue skylight instead of going black.

export const ATMOSPHERE = {
  earthRadius: 6360e3,
  atmosphereRadius: 6420e3,
  // Rayleigh scattering at 680/550/440nm, in m^-1.
  betaR: [5.8e-6, 13.5e-6, 33.1e-6],
  betaM: 21e-6,
  scaleHeightR: 8000,
  scaleHeightM: 1200,
  mieG: 0.76,
  sunIntensity: 22.0,
};

/** Distance to the far intersection of a ray with a sphere at the origin. */
function raySphereFar(origin, dir, radius) {
  const b = 2 * (origin[0] * dir[0] + origin[1] * dir[1] + origin[2] * dir[2]);
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) return -1;
  return (-b + Math.sqrt(disc)) / 2;
}

/**
 * Scattered radiance along `dir` from an observer just above the ground.
 * @param {number[]} dir      normalised view direction, +Y up
 * @param {number[]} sunDir   normalised direction to the sun
 */
export function skyRadiance(dir, sunDir, A = ATMOSPHERE) {
  const STEPS = 16, LIGHT_STEPS = 8;
  const origin = [0, A.earthRadius + 2, 0];
  const far = raySphereFar(origin, dir, A.atmosphereRadius);
  if (far <= 0) return [0, 0, 0];

  const segLen = far / STEPS;
  let odR = 0, odM = 0;
  const sumR = [0, 0, 0], sumM = [0, 0, 0];

  for (let i = 0; i < STEPS; i++) {
    const t = (i + 0.5) * segLen;
    const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    const h = Math.hypot(p[0], p[1], p[2]) - A.earthRadius;
    const hr = Math.exp(-h / A.scaleHeightR) * segLen;
    const hm = Math.exp(-h / A.scaleHeightM) * segLen;
    odR += hr; odM += hm;

    // Optical depth from the sample toward the sun.
    const lFar = raySphereFar(p, sunDir, A.atmosphereRadius);
    let lOdR = 0, lOdM = 0, blocked = false;
    if (lFar > 0) {
      const lSeg = lFar / LIGHT_STEPS;
      for (let j = 0; j < LIGHT_STEPS; j++) {
        const lt = (j + 0.5) * lSeg;
        const lp = [p[0] + sunDir[0] * lt, p[1] + sunDir[1] * lt, p[2] + sunDir[2] * lt];
        const lh = Math.hypot(lp[0], lp[1], lp[2]) - A.earthRadius;
        if (lh < 0) { blocked = true; break; }
        lOdR += Math.exp(-lh / A.scaleHeightR) * lSeg;
        lOdM += Math.exp(-lh / A.scaleHeightM) * lSeg;
      }
    }
    if (blocked) continue;

    for (let c = 0; c < 3; c++) {
      const tau = A.betaR[c] * (odR + lOdR) + A.betaM * 1.1 * (odM + lOdM);
      const att = Math.exp(-tau);
      sumR[c] += att * hr;
      sumM[c] += att * hm;
    }
  }

  const mu = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = A.mieG;
  const phaseM = (3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu)) /
    ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));

  return [0, 1, 2].map((c) =>
    (sumR[c] * A.betaR[c] * phaseR + sumM[c] * A.betaM * phaseM) * A.sunIntensity);
}

/**
 * Project the sky into 9 order-2 SH coefficients of RGB irradiance.
 * Cosine-convolved, so a shader recovers diffuse ambient with a plain dot.
 */
export function projectSkySH(sunDir, samples = 4096, A = ATMOSPHERE) {
  const sh = Array.from({ length: 9 }, () => [0, 0, 0]);
  // Fibonacci sphere: even coverage without clumping at the poles.
  const ga = Math.PI * (3 - Math.sqrt(5));
  let taken = 0;
  for (let i = 0; i < samples; i++) {
    const y = 1 - (i + 0.5) / samples * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    const d = [Math.cos(th) * r, y, Math.sin(th) * r];
    if (d[1] < -0.10) continue;            // below the horizon contributes ~0
    taken++;
    const L = skyRadiance(d, sunDir, A);
    const b = shBasis(d);
    for (let k = 0; k < 9; k++) {
      for (let c = 0; c < 3; c++) sh[k][c] += L[c] * b[k];
    }
  }
  const w = (4 * Math.PI) / Math.max(1, taken);
  for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) sh[k][c] *= w;
  return sh;
}

export function shBasis(d) {
  const [x, y, z] = d;
  return [
    0.282095,
    0.488603 * y, 0.488603 * z, 0.488603 * x,
    1.092548 * x * y, 1.092548 * y * z,
    0.315392 * (3 * z * z - 1),
    1.092548 * x * z,
    0.546274 * (x * x - y * y),
  ];
}

/** Convolve SH radiance with the clamped-cosine lobe -> irradiance. */
export function shToIrradiance(sh) {
  const A = [3.141593, 2.094395, 2.094395, 2.094395,
             0.785398, 0.785398, 0.785398, 0.785398, 0.785398];
  return sh.map((c, k) => c.map((v) => v * A[k]));
}
