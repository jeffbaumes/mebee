// Procedural composite flowers (Asteraceae): a domed disc of florets ringed by
// strap-shaped ray florets. All dimensions are metres -- an ox-eye head is
// ~55mm across, which is the scale a bee actually works at.
//
// Every builder here takes a species from species.js. Nothing is hard-coded to
// one flower any more: the same surfaces, sampled with a different set of
// numbers, give an ox-eye daisy, a cat's-ear and a cornflower.
//
// Two conventions matter for the field:
//
//   * Vertices are stored as an OFFSET from the point on the stem the part
//     attaches to, with the normalised attachment height in the vertex. A
//     plant's stem height therefore enters only through the solved chain, so
//     one mesh per species serves every individual whatever height it grew to.
//   * Every grid is stitched at three levels of detail from the same vertices
//     (see mesh.js), so switching tier costs an index-buffer swap and moves
//     nothing on screen.

import { MeshBuilder, sampleSurface, normalize } from './mesh.js';
import { makeRng, fbm2 } from './rand.js';
import { leafHalfWidth, DEFAULT_SHAPE } from './venation.js';
import { SPECIES, headRadius, rayCount } from './species.js';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // 137.507...deg

/** The reference plant: an ox-eye daisy at its species mean. */
export const REFERENCE = SPECIES[0];

/**
 * Dimensions of the reference plant, in the shape the rest of the app has
 * always expected. The camera's framing, the flight model's fallback aim and
 * the offline previews all want "how big is a flower, roughly"; they should
 * not have to know that there are now six answers.
 */
export const FLOWER = {
  discRadius: REFERENCE.head.discRadius,
  discDome: REFERENCE.head.dome,
  floretCount: REFERENCE.head.floretCount,
  rayWhorls: REFERENCE.rays.whorls,
  stemHeight: REFERENCE.stem.height,
  stemBaseRadius: REFERENCE.stem.baseRadius,
  stemTopRadius: REFERENCE.stem.topRadius,
  headRadius: headRadius(REFERENCE),
};

// Grid densities of the finest level. Each is 4k+1 in both directions so the
// stride-2 and stride-4 levels land exactly on the last row and column and the
// coarse silhouette matches the fine one.
const GRID = {
  petal: [21, 9],
  receptacle: [17, 33],
  stem: [33, 13],
  leaf: [41, 17],
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
  // makes ray florets arch over rather than stick out straight. A negative
  // droop runs the other way, which is how a cornflower's outer trumpets flare
  // upward and outward instead of arching over.
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
function addRayWhorl(mb, species, whorl, whorlIndex, rng) {
  const { count, length, width, droop, tilt } = whorl;
  const R = species.rays;
  const [NU, NV] = GRID.petal;

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
      twist: R.twist * rng.range(-1.2, 1.2),
      notchDepth: R.notchDepth * rng.range(0.7, 1.35),
      notchCount: R.notchCount,
      cup: R.cup * rng.range(0.75, 1.30),
      veinCount: R.veinCount,
      veinAmp: width * rng.range(0.030, 0.058),
      waviness: R.waviness * rng.range(0.7, 1.4),
      curlBud: rng.range(1.5, 2.2),
      variant,
    });

    const r0 = species.head.discRadius * 0.92;
    const place = (bloom) => (u, v) => {
      const s = surf(u, v, bloom);
      const r = r0 + s.r;
      return [
        cosP * r - sinP * s.lateral,
        s.y,
        sinP * r + cosP * s.lateral,
      ];
    };

    sampleSurface(mb, place(1), NU, NV, {
      bud: place(0),
      uv: (u, v) => [v, u],
      axis: (u) => u,
      stemHeight: 1,
      variant,
      // Whorls past the first are dropped at the coarsest level: at that tier
      // the head is a few pixels wide before the lens even gets to it, and the
      // inner ring only ever sat in the gaps of the outer one.
      dropAt: whorlIndex === 0 ? 3 : 2,
    });
  }
}

/** Assemble every ray floret of one species' head into one mesh. */
export function buildRayMesh(species = REFERENCE, seed = 23) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  species.rays.whorls.forEach((w, i) => addRayWhorl(mb, species, w, i, rng));
  return mb.finish();
}

// ---------------------------------------------------------------------------
// Disc floret
// ---------------------------------------------------------------------------

/**
 * A single disc floret, generated once and instanced across every capitulum.
 * Built in local space: +Y is the floret's own axis, origin at its base.
 *
 * The open and closed states are both baked into the vertex, so the maturation
 * wave that sweeps the disc is a single per-instance scalar in the shader.
 * Shared by every species -- what differs between them is how many there are
 * and how tightly they pack, both of which live in the instance buffer.
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

  // Around a millimetre across on screen: a denser grid buys nothing, and it
  // is multiplied by every instance on the disc. Disc florets are only ever
  // drawn on the handful of plants at the finest tier, so there is one level.
  sampleSurface(mb, corolla(1), 7, 15, {
    bud: corolla(0), uv: (u, v) => [v, u], axis: (u) => u, variant: 0,
  });
  sampleSurface(mb, style(1), 5, 7, {
    bud: style(0), uv: (u, v) => [v, u], axis: (u) => u, variant: 1,
  });
  return mb.finish();
}

/**
 * Field order of one FloretInstance, which MUST match the struct in
 * floret.wgsl. WGSL packs a struct of two vec4f as eight contiguous floats, so
 * `scale` belongs in slot 3 (the w of the first vec4), not after the normal.
 *
 *   struct FloretInstance {
 *     posScale : vec4f,   // 0,1,2 = position   3 = scale
 *     nrmRad   : vec4f,   // 4,5,6 = normal     7 = normalised radius
 *   }
 */
export const FLORET_INSTANCE_FLOATS = 8;
const FI = { posX: 0, posY: 1, posZ: 2, scale: 3, nrmX: 4, nrmY: 5, nrmZ: 6, radius: 7 };

/**
 * Crown of the disc: height above the head plane as a function of the
 * normalised radius rn = r / discRadius. Exported because the receptacle and
 * the florets standing on it must read the same curve -- if they drift apart
 * the cushion either floats above its florets or sinks away beneath them.
 */
export const discDomeY = (rn, species = REFERENCE) =>
  species.head.dome * Math.pow(Math.max(0, 1 - rn * rn), species.head.domeExp);

/**
 * Vogel's model: r = c*sqrt(n), theta = n * goldenAngle. The golden angle is
 * the only divergence that never lets florets fall into radial rows, which is
 * why every real capitulum shows the same interlocking Fibonacci spirals.
 *
 * @returns {{data: Float32Array, count: number}}
 */
export function buildFloretInstances(species = REFERENCE, seed = 5) {
  const rng = makeRng(seed);
  const N = species.head.floretCount;
  const Rd = species.head.discRadius;
  const data = new Float32Array(N * FLORET_INSTANCE_FLOATS);

  for (let n = 0; n < N; n++) {
    const rn = Math.sqrt((n + 0.5) / N);          // uniform areal density
    const r = Rd * rn;
    const th = n * GOLDEN_ANGLE;
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    const y = discDomeY(rn, species);

    // Dome normal from the analytic slope.
    const h = 1e-4;
    const slope = (discDomeY(Math.min(1, rn + h), species)
                 - discDomeY(Math.max(0, rn - h), species)) / (2 * h * Rd);
    const nr = -slope;
    const nml = normalize([Math.cos(th) * nr, 1, Math.sin(th) * nr]);

    // Hexagonal packing of N florets over a disc of radius Rd puts the
    // neighbour spacing at Rd*sqrt(2*pi/(sqrt(3)*N)); a floret is about half
    // that across, so neighbours just touch the way a real capitulum does.
    const spacing = Rd * Math.sqrt((2 * Math.PI) / (Math.sqrt(3) * N));
    const scale = spacing * 0.52 * rng.range(0.88, 1.12);

    // Written through named slots: the previous version laid the fields out in
    // source order (pos, normal, scale, radius), which put the normal's x into
    // the slot the shader reads as `scale`. Florets meant to be 1mm across
    // rendered up to 1.9m, half of them inverted by a negative scale.
    const o = n * FLORET_INSTANCE_FLOATS;
    data[o + FI.posX] = x;
    data[o + FI.posY] = y;
    data[o + FI.posZ] = z;
    data[o + FI.scale] = scale;
    data[o + FI.nrmX] = nml[0];
    data[o + FI.nrmY] = nml[1];
    data[o + FI.nrmZ] = nml[2];
    data[o + FI.radius] = rn;
  }
  return { data, count: N };
}

// ---------------------------------------------------------------------------
// Stem and leaf
// ---------------------------------------------------------------------------

/**
 * Straight canonical stem; the wind chain bends it in the vertex shader.
 *
 * Vertices carry only the cross-section offset -- the height is entirely the
 * chain's business -- so the same tube serves a 78mm daisy and a 330mm
 * cornflower without rebuilding anything.
 */
export function buildStemMesh(species = REFERENCE, seed = 11) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const H = species.stem.height;
  const [NU, NV] = GRID.stem;
  const RIDGES = 7;

  const surf = (u, v) => {
    const th = v * Math.PI * 2;
    // Taper, with a slight swell just under the head (the peduncle thickens).
    const taper = species.stem.baseRadius +
      (species.stem.topRadius - species.stem.baseRadius) * Math.pow(u, 0.85);
    const swell = 1 + 0.28 * Math.exp(-Math.pow((u - 0.985) / 0.045, 2));
    // Longitudinal ridging -- stems are fluted, not round.
    const flute = 1 + 0.055 * Math.cos(RIDGES * th + u * 1.4);
    const r = taper * swell * flute;
    return [Math.cos(th) * r, u * H, Math.sin(th) * r];
  };

  sampleSurface(mb, surf, NU, NV, {
    uv: (u, v) => [v * 3.0, u * 26],
    // No secondary flutter: the stem's motion is the solved chain, and adding
    // an independent wobble on top slides it against the head it carries.
    axis: () => 0,
    stemHeight: 1,
    variant: rng.next(),
    doubleSided: false,
    detach: (u) => [0, u * H, 0],
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

/**
 * Leaf blade matching the venation outline, so the baked maps register.
 *
 * `attachFrac` is where on the stem it hangs, as a fraction of stem height;
 * the blade's own shape is in metres and independent of it.
 */
export function buildLeafMesh(bladeLength, attachFrac, azimuth, seed = 17) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();
  const [NU, NV] = GRID.leaf;
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
    let y = rise * bladeLength * Math.sin(Math.PI * Math.min(1, u * 1.15)) * 0.5
      - droop * bladeLength * Math.pow(u, 2.1);
    y += cup * half * Math.pow((v - 0.5) * 2, 2);
    y += 0.05 * half * (fbm2(bladeU(u) * 4.0 + variant * 9, v * 2.2, 3) - 0.5);
    return [cosA * along - sinA * across, y, sinA * along + cosA * across];
  };

  sampleSurface(mb, surf, NU, NV, {
    // Register with the baked maps: lx in [-0.5,0.5], v_tex = 1 - bladeU.
    uv: (u, v) => [0.5 + (v - 0.5) * 2 * leafHalfWidth(bladeU(u), shape), 1 - bladeU(u)],
    axis: (u) => u,
    stemHeight: attachFrac,
    variant,
  });
  return mb.finish();
}

/** Receptacle: the fleshy cushion the florets sit on, plus involucral bracts. */
export function buildReceptacleMesh(species = REFERENCE) {
  const mb = new MeshBuilder();
  const Rd = species.head.discRadius;
  const [NU, NV] = GRID.receptacle;
  const RIM = 1.22;   // how far the bracts flare past the disc, in disc radii

  const surf = (u, v) => {
    const th = v * Math.PI * 2;
    // Radial profile of a closed cap: r = 0 at u = 0. It used to start at
    // 0.20*Rd, which made the cushion an annulus with a 2.3mm hole punched
    // through the crown. Disc florets are round and pack with gaps, so they
    // could never tile over it -- you saw straight through the middle of the
    // flower to the sky behind.
    const r = Rd * RIM * Math.sin(u * Math.PI * 0.5);
    const rn = r / Rd;

    // Under the disc the cushion IS the dome the florets stand on, read from
    // the same curve their instances are placed on, so the two cannot drift.
    // Past the rim it falls away into the reflexed involucral bracts; `beyond`
    // is zero at the rim with zero slope, so the two halves meet smoothly.
    const beyond = Math.max(0, rn - 1) / (RIM - 1);
    const y = discDomeY(Math.min(1, rn), species)
      - Rd * 0.42 * Math.pow(beyond, 1.4)
      + Rd * 0.035 * Math.cos(th * 13) * beyond;
    return [Math.cos(th) * r, y, Math.sin(th) * r];
  };

  // axis 0: the receptacle is structural, not a lamina. Everything on the head
  // -- receptacle, florets, petal bases -- shares one frame at the stem tip and
  // must move as a single rigid body. Giving each part its own flutter phase is
  // what made the head warp and the disc florets lag behind the cup they sit in.
  sampleSurface(mb, surf, NU, NV, { uv: (u, v) => [v * 6, u], axis: () => 0, stemHeight: 1 });
  return mb.finish();
}

/**
 * Every mesh one species needs, at every level of detail.
 *
 * Leaves are skipped for species that carry none above the rosette -- a common
 * daisy's leaves are flat on the ground under the sward, so drawing them is
 * paying for geometry that is never visible.
 */
export function buildSpeciesMeshes(species) {
  const leafScale = species.stem.leafScale;
  const bladeLength = species.stem.height * 0.20 * leafScale;
  return {
    stem: buildStemMesh(species),
    receptacle: buildReceptacleMesh(species),
    ray: buildRayMesh(species),
    leafA: leafScale > 0.05 ? buildLeafMesh(bladeLength, 0.58, 0.65, 17) : null,
    leafB: leafScale > 0.05 ? buildLeafMesh(bladeLength * 0.80, 0.37, -2.05, 29) : null,
    florets: buildFloretInstances(species),
    headRadius: headRadius(species),
    rayCount: rayCount(species),
  };
}
