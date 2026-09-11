// The bee.
//
// New with the third-person camera: in first person there was nothing to draw,
// and the whole point of moving the camera behind is that you can now watch
// yourself crawl over a flower. Deliberately modest -- it is 13mm long, it is
// almost always inside the bokeh, and none of the botany machinery in the rest
// of geom/ applies to it. What it has to get right is the SILHOUETTE: a stout
// striped abdomen, a fat furry thorax, a small head, four wings held out and
// blurred, six legs. Recognisable at a glance and cheap at any distance.
//
// Local frame: +Z forward (the way the bee faces), +Y up, +X to its right,
// origin at the thorax. Metres, like everything else here.

import { MeshBuilder, sampleSurface } from './mesh.js';

/** Part ids, carried in the vertex's `variant` slot and read by bee.wgsl. */
export const BEE_PART = { BODY: 0, WING: 1, LEG: 2, EYE: 3 };

/** Nose to sting, in metres. A worker honeybee, near enough. */
export const BEE_LENGTH = 0.013;

/**
 * A closed surface of revolution about +Z, given a radius profile.
 *
 * `z0`/`z1` bracket the part along the body axis and `radius(t)` is its
 * half-width, so a lopsided ovoid (which is what both an abdomen and a thorax
 * are) is one call. It closes at both ends by taking the radius to zero, so
 * there is never a hole to see into.
 */
function revolve(mb, { z0, z1, radius, yScale = 1, xScale = 1, part, nu = 17, nv = 13,
                       along = (t) => t }) {
  sampleSurface(mb, (u, v) => {
    const th = v * Math.PI * 2;
    const r = radius(u);
    return [Math.cos(th) * r * xScale, Math.sin(th) * r * yScale, z0 + (z1 - z0) * u];
  }, nu, nv, {
    uv: (u, v) => [v, u],
    axis: (u) => along(u),
    stemHeight: 0,
    variant: part,
  });
}

/**
 * One wing, as the ARC it sweeps rather than as the blade itself.
 *
 * A honeybee beats at a couple of hundred hertz. There is no frame rate at
 * which the blade is the right thing to draw, and animating one would only
 * ever strobe -- so this is the swept envelope, and bee.wgsl stipples it out
 * to fake the transparency. That is what a real photograph of a flying bee
 * shows, and it costs two dozen triangles.
 *
 * @param {number} side  -1 left, +1 right
 * @param {number} root  z of the wing base on the thorax
 */
function wingArc(mb, side, { root, length, sweepFrom, sweepTo, lift, chord }) {
  // u runs out along the wing, v across the arc it beats through.
  sampleSurface(mb, (u, v) => {
    const ang = sweepFrom + (sweepTo - sweepFrom) * v;
    // Tapered and rounded, so the envelope is a blade's sweep and not a fan.
    const r = length * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.62)), 0.45);
    const back = -chord * u * u;
    return [
      side * (r * Math.cos(ang) + 0.0006),
      lift + r * Math.sin(ang),
      root + back,
    ];
  }, 9, 7, {
    uv: (u, v) => [v, u], axis: (u) => u, stemHeight: 0, variant: BEE_PART.WING,
    doubleSided: true,
  });
}

/** One leg: a thin tapered tube along a two-segment path. */
function leg(mb, side, { root, out, down, back, knee, length, radius }) {
  const path = (t) => {
    // Femur out and down, then tibia down and back -- enough of a joint that
    // the silhouette has an angle in it rather than a straight spike.
    const a = Math.min(1, t / knee);
    const b = Math.max(0, (t - knee) / (1 - knee));
    return [
      side * (out * a + out * 0.25 * b),
      -down * a - down * 1.15 * b,
      root + back * b,
    ];
  };
  sampleSurface(mb, (u, v) => {
    const th = v * Math.PI * 2;
    const c = path(u);
    const r = radius * (1 - 0.55 * u);
    // The tube's cross-section is put in the plane square to the body's long
    // axis, which is close enough at this thickness and needs no frame.
    return [c[0] + Math.cos(th) * r, c[1] + Math.sin(th) * r * 0.8, c[2] + Math.cos(th) * r * 0.3];
  }, 9, 7, {
    uv: (u, v) => [v, u], axis: (u) => u, stemHeight: 0, variant: BEE_PART.LEG,
  });
  void length;
}

/**
 * The whole bee, at true scale. One mesh, one draw; the renderer places it
 * with the flight model's own basis.
 */
export function buildBeeMesh() {
  const mb = new MeshBuilder();

  // Abdomen: the striped part, tapering to the sting. `along` runs 0 at the
  // waist to 1 at the tip, which is the coordinate the stripes are drawn on.
  revolve(mb, {
    z0: 0.0008, z1: -0.0078, part: BEE_PART.BODY, nu: 17, nv: 13,
    radius: (t) => 0.00235 * Math.pow(Math.sin(Math.PI * Math.pow(0.06 + 0.94 * t, 0.42)), 0.55),
    yScale: 0.92,
    along: (t) => t,
  });

  // Thorax: almost spherical and, on a real bee, the furriest part of it.
  revolve(mb, {
    z0: -0.0009, z1: 0.0034, part: BEE_PART.BODY, nu: 13, nv: 13,
    radius: (t) => 0.00215 * Math.sin(Math.PI * (0.10 + 0.80 * t)),
    // Held at -1 so the shader can tell thorax fur from abdomen stripe with
    // the same channel the stripes ride on.
    along: () => -1,
  });

  // Head, and the two big compound eyes wrapped round the sides of it.
  revolve(mb, {
    z0: 0.0030, z1: 0.0058, part: BEE_PART.BODY, nu: 11, nv: 11,
    radius: (t) => 0.00135 * Math.sin(Math.PI * (0.16 + 0.72 * t)),
    xScale: 0.92, along: () => -1,
  });
  for (const side of [-1, 1]) {
    sampleSurface(mb, (u, v) => {
      const th = v * Math.PI * 2;
      const r = 0.00072 * Math.sin(Math.PI * (0.12 + 0.80 * u));
      return [
        side * (0.00098 + Math.abs(Math.cos(th)) * 0.0002),
        Math.sin(th) * r * 1.15,
        0.0044 + (u - 0.5) * 0.0022 + Math.cos(th) * r * 0.5,
      ];
    }, 7, 9, {
      uv: (u, v) => [v, u], axis: () => 0, stemHeight: 0, variant: BEE_PART.EYE,
    });
  }

  // Antennae: elbowed, and short enough not to read as horns.
  for (const side of [-1, 1]) {
    sampleSurface(mb, (u, v) => {
      const th = v * Math.PI * 2;
      const r = 0.00016 * (1 - 0.4 * u);
      const bend = Math.pow(u, 1.8);
      return [
        side * (0.00055 + 0.0011 * u) + Math.cos(th) * r,
        0.00055 + 0.0016 * u - 0.0009 * bend + Math.sin(th) * r,
        0.0056 + 0.0018 * u,
      ];
    }, 7, 5, {
      uv: (u, v) => [v, u], axis: (u) => u, stemHeight: 0, variant: BEE_PART.LEG,
    });
  }

  // Four wings, held out and back over the abdomen. The forewing is the long
  // one; the hindwing is short and tucked under it, which is why a bee in
  // flight reads as one blurred shape per side rather than two.
  for (const side of [-1, 1]) {
    // Held out and swept well back over the abdomen, which is the posture
    // that reads as flight rather than as a moth at rest -- and the arc is
    // narrow, because a beat that carried the envelope through 45 degrees
    // drew a pair of cones instead of a pair of blurs.
    wingArc(mb, side, {
      root: 0.0020, length: 0.0074, chord: 0.0060,
      sweepFrom: 0.16, sweepTo: 0.62, lift: 0.0013,
    });
    wingArc(mb, side, {
      root: 0.0006, length: 0.0044, chord: 0.0040,
      sweepFrom: 0.06, sweepTo: 0.44, lift: 0.0009,
    });
  }

  // Six legs. The hind pair is the long one that trails, and it is the pair
  // that carries the pollen basket, so it is also the one worth seeing.
  const legs = [
    { root: 0.0030, out: 0.0016, down: 0.0016, back: -0.0012, knee: 0.45, radius: 0.00022 },
    { root: 0.0010, out: 0.0020, down: 0.0018, back: -0.0016, knee: 0.45, radius: 0.00024 },
    { root: -0.0008, out: 0.0022, down: 0.0020, back: -0.0034, knee: 0.42, radius: 0.00028 },
  ];
  for (const side of [-1, 1]) for (const l of legs) leg(mb, side, { ...l, length: 0 });

  return mb.finish();
}
