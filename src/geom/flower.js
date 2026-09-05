// Procedural composite flower (Asteraceae): a domed disc of florets ringed by
// strap-shaped ray florets. All dimensions are metres -- the head is ~45mm
// across, which is the scale a bee actually works at.

import { MeshBuilder, sampleSurface, normalize, cross, sub } from './mesh.js';
import { makeRng, fbm2 } from './rand.js';
import { leafMargin, leafHalfWidth, DEFAULT_SHAPE } from './venation.js';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 137.507...deg

export const FLOWER = {
  discRadius: 0.0115,
  discDome: 0.0058,
  floretCount: 420,
  rayWhorls: [
    { count: 21, length: 0.0235, width: 0.0062, droop: 0.62, tilt: 0.10 },
    { count: 13, length: 0.0181, width: 0.0050, droop: 0.40, tilt: 0.34 },
  ],
  stemHeight: 0.40,
  stemBaseRadius: 0.0027,
  stemTopRadius: 0.0018,
};

// ---------------------------------------------------------------------------
// Ray floret (petal)
// ---------------------------------------------------------------------------

/**
 * One strap-shaped ray floret as a parametric surface.
 *
 * u runs base->tip, v runs across the strap. The surface stacks, in order:
 * a drooping centreline, a width profile, apical notches, lateral cupping,
 * a slow twist, longitudinal vein ridges and margin waviness.
 */
function petalSurface(cfg) {
  const {
    length, width, droop, tilt, twist, notchDepth, notchCount,
    cup, veinCount, veinAmp, waviness, variant, curlBud,
  } = cfg;

  // Centreline in the (radial, up) plane, integrated from a pitch angle that
  // accelerates downward -- differential growth on the abaxial side is what
  // makes ray florets arch over rather than stick out straight.
  const STEPS = 48;
  const path = [{ r: 0, y: 0 }];
  {
    let r = 0, y = 0;
    for (let i = 1; i <= STEPS; i++) {
      const u = i / STEPS;
      const theta = tilt - droop * Math.pow(u, 1.7);
      const ds = length / STEPS;
      r += Math.cos(theta) * ds;
      y += Math.sin(theta) * ds;
      path.push({ r, y });
    }
  }
  const centre = (u) => {
    const f = Math.min(0.999999, Math.max(0, u)) * STEPS;
    const i = Math.floor(f), t = f - i;
    const a = path[i], b = path[Math.min(STEPS, i + 1)];
    return { r: a.r + (b.r - a.r) * t, y: a.y + (b.y - a.y) * t };
  };
  const tangentAt = (u) => {
    const h = 1e-3;
    const a = centre(Math.max(0, u - h)), b = centre(Math.min(1, u + h));
    const dr = b.r - a.r, dy = b.y - a.y;
    const l = Math.hypot(dr, dy) || 1;
    return { dr: dr / l, dy: dy / l };
  };

  // Strap profile: widens fast, holds, then rounds off at the tip.
  const widthAt = (u) => width * Math.pow(Math.sin(Math.PI * Math.pow(Math.min(1, u), 0.34)), 0.42);

  // Apical teeth. Ray florets of most composites end in 2-3 shallow notches,
  // cut into the tip edge rather than the sides, so they shorten u, not width.
  const tipCut = (v) =>
    1 - notchDepth * (0.5 - 0.5 * Math.cos(2 * Math.PI * notchCount * (v - 0.5)));

  /** @param {number} bloom 0 = furled bud, 1 = fully open */
  return function surface(u, v, bloom = 1) {
    const uu = Math.min(1, u * tipCut(v));
    const c = centre(uu);
    const tg = tangentAt(uu);
    const s = (v - 0.5) * widthAt(uu);          // lateral offset

    // Vein ridges: evenly spaced longitudinal ribs, fading toward the tip.
    let ridge = 0;
    for (let k = 0; k < veinCount; k++) {
      const vk = (k + 0.5) / veinCount;
      const d = (v - vk) / 0.085;
      ridge += Math.exp(-d * d);
    }
    ridge *= veinAmp * (1 - 0.55 * uu);

    // Lateral cupping (adaxial concave) plus low-frequency margin waviness.
    const cupping = -cup * widthAt(uu) * Math.pow((v - 0.5) * 2, 2) * (0.35 + 0.65 * uu);
    const wave = waviness * width *
      (fbm2(uu * 3.4 + variant * 7.1, v * 1.6 + variant * 3.3, 3) - 0.5);

    const lift = ridge + cupping + wave;

    // Local frame: tangent along the centreline, normal perpendicular in the
    // (radial, up) plane, binormal lateral.
    const nR = -tg.dy, nY = tg.dr;
    let r = c.r + nR * lift;
    let y = c.y + nY * lift;

    // Slow axial twist, applied as a rotation of the lateral offset out of
    // plane. Real ray florets are never perfectly planar.
    const tw = twist * uu;
    const lateral = s * Math.cos(tw);
    const outOfPlane = s * Math.sin(tw);
    r += nR * outOfPlane;
    y += nY * outOfPlane;

    if (bloom >= 1) return { r, y, lateral };

    // --- bud state ------------------------------------------------------
    // Furled: the strap stands up, curls inward over the disc and wraps
    // tangentially, which is how ray florets are packed before anthesis.
    const b = 1 - bloom;
    const curl = curlBud * b;
    const ang = curl * Math.pow(uu, 1.25);
    const up = uu * length * (1 - 0.28 * b);
    const rb = c.r * (1 - 0.72 * b) + Math.sin(-ang) * up * 0.55;
    const yb = c.y * (1 - b) + Math.cos(ang) * up * (0.62 + 0.38 * bloom);
    return {
      r: rb + nR * lift * (1 - 0.5 * b),
      y: yb + nY * lift * (1 - 0.5 * b),
      lateral: lateral * (1 - 0.42 * b) + outOfPlane * b * 0.6,
    };
  };
}

/** Build all ray florets of one whorl into `mb`. */
function addRayWhorl(mb, whorl, whorlIndex, rng, headY) {
  const { count, length, width, droop, tilt } = whorl;
  const NU = 26, NV = 9;

  for (let i = 0; i < count; i++) {
    // Offset successive whorls by the golden angle so the inner ring sits in
    // the gaps of the outer one instead of shadowing it.
    const phi = (i / count) * Math.PI * 2 + whorlIndex * GOLDEN_ANGLE + rng.sym(0.035);
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    const variant = rng.next();

    const surf = petalSurface({
      length: length * rng.range(0.90, 1.10),
      width: width * rng.range(0.88, 1.12),
      droop: droop * rng.range(0.82, 1.18),
      tilt: tilt + rng.sym(0.07),
      twist: rng.sym(0.30),
      notchDepth: rng.range(0.05, 0.13),
      notchCount: rng.next() < 0.5 ? 1.5 : 2.5,
      cup: rng.range(0.12, 0.26),
      veinCount: 3 + ((rng.next() * 3) | 0),
      veinAmp: width * rng.range(0.030, 0.058),
      waviness: rng.range(0.10, 0.24),
      curlBud: rng.range(1.5, 2.2),
      variant,
    });

    const r0 = FLOWER.discRadius * 0.92;
    const place = (bloom) => (u, v) => {
      const s = surf(u, v, bloom);
      const r = r0 + s.r;
      return [
        cosP * r - sinP * s.lateral,
        headY + s.y,
        sinP * r + cosP * s.lateral,
      ];
    };

    sampleSurface(mb, place(1), NU, NV, {
      bud: place(0),
      uv: (u, v) => [v, u],
      axis: (u) => u,
      stemHeight: 1,
      variant,
    });
  }
}

// ---------------------------------------------------------------------------
// Disc floret
// ---------------------------------------------------------------------------

/**
 * A single disc floret, generated once and instanced across the capitulum.
 * Built in local space: +Y is the floret's own axis, origin at its base.
 *
 * The open and closed states are both baked into the vertex, so the maturation
 * wave that sweeps the disc is a single per-instance scalar in the shader.
 */
export function buildDiscFloretMesh() {
  const mb = new MeshBuilder();
  // Built at unit scale: the instance buffer supplies the real size, derived
  // from the Vogel spiral's own neighbour spacing.
  const R = 0.40, TUBE_H = 0.52, LOBE = 0.40;
  const LOBES = 5, U_LOBE = 0.55;

  const corolla = (splay) => (u, v) => {
    const th = v * Math.PI * 2;
    // 5-fold lobe mask: 1 at a lobe centre, 0 in the sinus between lobes.
    const lobe = 0.5 + 0.5 * Math.cos(LOBES * th);
    if (u <= U_LOBE) {
      const t = u / U_LOBE;
      const r = R * (0.62 + 0.38 * t);
      return [Math.cos(th) * r, t * TUBE_H, Math.sin(th) * r];
    }
    const t = (u - U_LOBE) / (1 - U_LOBE);
    const reach = LOBE * t * (0.28 + 0.72 * lobe);
    const r = R + reach * (0.18 + 1.25 * splay);
    const y = TUBE_H + reach * (1.05 - 0.92 * splay);
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  };

  // Style + anthers: a slim column that only emerges once the floret opens.
  // This is where the pollen actually sits, so it drives the pollen shader.
  const style = (splay) => (u, v) => {
    const th = v * Math.PI * 2;
    const r = R * 0.26 * (1 - 0.45 * u);
    const y = TUBE_H * 0.55 + u * (TUBE_H * 0.30 + LOBE * 1.32 * splay);
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  };

  sampleSurface(mb, corolla(1), 9, 21, {
    bud: corolla(0), uv: (u, v) => [v, u], axis: (u) => u, variant: 0,
  });
  sampleSurface(mb, style(1), 7, 9, {
    bud: style(0), uv: (u, v) => [v, u], axis: (u) => u, variant: 1,
  });
  return mb.finish();
}

/**
 * Vogel's model: r = c*sqrt(n), theta = n * goldenAngle. The golden angle is
 * the only divergence that never lets florets fall into radial rows, which is
 * why every real capitulum shows the same interlocking Fibonacci spirals.
 *
 * @returns {{data: Float32Array, count: number}} 8 floats per instance:
 *   position(3), dome normal(3), scale(1), maturity(1)
 */
export function buildFloretInstances(seed = 5) {
  const rng = makeRng(seed);
  const N = FLOWER.floretCount;
  const Rd = FLOWER.discRadius;
  const data = new Float32Array(N * 8);

  // Dome the disc slightly; y falls off toward the rim.
  const domeY = (rn) => FLOWER.discDome * Math.pow(Math.max(0, 1 - rn * rn), 0.70);

  for (let n = 0; n < N; n++) {
    const rn = Math.sqrt((n + 0.5) / N);          // uniform areal density
    const r = Rd * rn;
    const th = n * GOLDEN_ANGLE;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const y = domeY(rn);

    // Dome normal from the analytic slope.
    const h = 1e-4;
    const slope = (domeY(Math.min(1, rn + h)) - domeY(Math.max(0, rn - h))) / (2 * h * Rd);
    const nr = -slope;
    const nml = normalize([Math.cos(th) * nr, 1, Math.sin(th) * nr]);

    // Hexagonal packing of N florets over a disc of radius Rd puts the
    // neighbour spacing at Rd*sqrt(2*pi/(sqrt(3)*N)); a floret is about half
    // that across, so neighbours just touch the way a real capitulum does.
    const spacing = Rd * Math.sqrt((2 * Math.PI) / (Math.sqrt(3) * N));
    const scale = spacing * 0.52 * rng.range(0.88, 1.12);

    const o = n * 8;
    data[o] = x; data[o + 1] = y; data[o + 2] = z;
    data[o + 3] = nml[0]; data[o + 4] = nml[1]; data[o + 5] = nml[2];
    data[o + 6] = scale;
    data[o + 7] = rn;                              // normalised radius
  }
  return { data, count: N };
}

// ---------------------------------------------------------------------------
// Stem and leaf
// ---------------------------------------------------------------------------

/** Straight canonical stem; the wind chain bends it in the vertex shader. */
export function buildStemMesh(seed = 11) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const H = FLOWER.stemHeight, NU = 40, NV = 13;
  const RIDGES = 7;

  const surf = (u, v) => {
    const th = v * Math.PI * 2;
    // Taper, with a slight swell just under the head (the peduncle thickens).
    const taper = FLOWER.stemBaseRadius +
      (FLOWER.stemTopRadius - FLOWER.stemBaseRadius) * Math.pow(u, 0.85);
    const swell = 1 + 0.28 * Math.exp(-Math.pow((u - 0.985) / 0.045, 2));
    // Longitudinal ridging -- stems are fluted, not round.
    const flute = 1 + 0.055 * Math.cos(RIDGES * th + u * 1.4);
    const r = taper * swell * flute;
    return [Math.cos(th) * r, u * H, Math.sin(th) * r];
  };

  sampleSurface(mb, surf, NU, NV, {
    uv: (u, v) => [v * 3.0, u * 26],
    axis: (u) => u,
    stemHeight: 1,
    variant: rng.next(),
    doubleSided: false,
  });
  // stemHeight must vary along the stem for the wind skin; patch it per row.
  const V = 20, verts = mb.verts;
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      verts[(i * NV + j) * V + 18] = i / (NU - 1);
    }
  }
  return mb.finish();
}

/** Leaf blade matching the venation outline, so the baked maps register. */
export function buildLeafMesh(bladeLength, attachHeight, azimuth, seed = 17) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const NU = 44, NV = 17;
  const shape = DEFAULT_SHAPE;
  const cosA = Math.cos(azimuth), sinA = Math.sin(azimuth);
  const variant = rng.next();
  const droop = rng.range(0.16, 0.27);
  const rise = rng.range(0.10, 0.17);   // leaves lift before they arch over
  const cup = rng.range(0.10, 0.20);
  const PETIOLE = 0.17;                 // fraction of total length that is stalk
  const PETIOLE_HALF = 0.010;           // stalk half-width, in blade-length units
  const span = bladeLength * (1 - PETIOLE);

  const bladeU = (u) => Math.max(0, (u - PETIOLE) / (1 - PETIOLE));
  // The stalk needs real width: leafMargin(0) is exactly zero, so driving the
  // petiole from it collapses every ring onto the midline and the whole stalk
  // degenerates into zero-area triangles.
  // Mesh follows the SMOOTH outline and lets the baked alpha cut the marginal
  // teeth. Twenty-six teeth cannot be resolved by a 36-sample grid, so putting
  // them in the geometry just loses them; in the texture they stay crisp at any
  // mesh density, and the same alpha carries the chew holes.
  // hypot() rather than max() unions stalk and blade without a corner at the
  // junction, which otherwise shows as a lump where the two profiles cross.
  const halfAt = (u) => Math.hypot(
    PETIOLE_HALF * bladeLength * (0.72 + 0.28 * (1 - u)),
    leafHalfWidth(bladeU(u), shape) * span,
  );

  const surf = (u, v) => {
    const half = halfAt(u);
    const across = (v - 0.5) * 2 * half;
    const along = u * bladeLength;
    // Arch: the petiole lifts away from the stem, then the blade droops under
    // its own weight. A pure downward curve reads as a wilted leaf.
    let y = attachHeight
      + rise * bladeLength * Math.sin(Math.PI * Math.min(1, u * 1.15)) * 0.5
      - droop * bladeLength * Math.pow(u, 2.1);
    y += cup * half * Math.pow((v - 0.5) * 2, 2);
    y += 0.05 * half * (fbm2(bladeU(u) * 4.0 + variant * 9, v * 2.2, 3) - 0.5);
    return [cosA * along - sinA * across, y, sinA * along + cosA * across];
  };

  sampleSurface(mb, surf, NU, NV, {
    // Register with the baked maps: lx in [-0.5,0.5], v_tex = 1 - bladeU.
    uv: (u, v) => [0.5 + (v - 0.5) * 2 * leafHalfWidth(bladeU(u), shape), 1 - bladeU(u)],
    axis: (u) => u,
    stemHeight: attachHeight / FLOWER.stemHeight,
    variant,
  });
  return mb.finish();
}

/** Assemble every ray floret of the head into one mesh. */
export function buildRayMesh(seed = 23) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const headY = FLOWER.stemHeight;
  FLOWER.rayWhorls.forEach((w, i) => addRayWhorl(mb, w, i, rng, headY));
  return mb.finish();
}

/** Receptacle: the fleshy cushion the florets sit on, plus involucral bracts. */
export function buildReceptacleMesh() {
  const mb = new MeshBuilder();
  const Rd = FLOWER.discRadius, headY = FLOWER.stemHeight;
  const surf = (u, v) => {
    const th = v * Math.PI * 2;
    // A shallow bowl under the disc that flares into reflexed bracts.
    const r = Rd * (0.20 + 1.02 * Math.sin(u * Math.PI * 0.5));
    const y = headY + FLOWER.discDome * Math.pow(1 - u, 1.6) * 0.9
      - Rd * 0.42 * Math.pow(u, 2.3)
      + Rd * 0.035 * Math.cos(th * 13) * u;
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  };
  sampleSurface(mb, surf, 16, 33, { uv: (u, v) => [v * 6, u], axis: (u) => 1 - u, stemHeight: 1 });
  return mb.finish();
}
