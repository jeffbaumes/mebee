// The clover leaf: three obcordate leaflets fanned from one petiole.
//
// Every other species in this field is a composite (Asteraceae), and its
// leaves are single blades -- see buildLeafMesh in flower.js. Clover is a
// legume, and the leaf people actually mean by "clover" is this compound
// trefoil, not the flower head, so it earns its own builder rather than being
// bent to fit the daisy-shaped one.
//
// It attaches to the plant's stem chain the same way every other lamina does
// (one fixed point, given by `attachFrac`), but with `axis` held at zero
// throughout: the receptacle does the same, for the same reason -- a real
// trefoil leaf is stiff, not flappy, and giving it the independent
// per-vertex wind flutter a petal gets is what read as jitter.
//
// This is GROUND cover. White clover is a stoloniferous mat: the petiole is
// short, the leaflets are held out nearly flat, and a patch closes over the
// soil rather than standing above it on stalks. Everything here is sized for
// that -- see CLOVER_LEAF in species.js for the numbers, and note that they
// are what the trefoil's own footprint (and so its LOD radius) comes from.

import { MeshBuilder, sampleSurface } from './mesh.js';
import { makeRng } from './rand.js';
import { leafHalfWidth, DEFAULT_SHAPE } from './venation.js';

const LEAFLETS = 3;

/** Grid of one leaflet. 17x9 so both coarse levels (stride 2 and 4) divide. */
const GRID = [17, 9];

/**
 * Outline of a white clover leaflet, normalised to peak at 1.
 *
 * Obcordate: a narrow wedge at the base, widest about seven tenths of the way
 * up, and -- the part that matters -- still 70% of that width at the apex,
 * which is then cut by the notch below. It used to be `sin(PI * u^0.6)`, which
 * peaks at u = 0.31: widest near the BASE, which is an ovate leaf and belongs
 * to a different plant entirely. Carrying the width to zero at the apex is the
 * other half of the same mistake -- it ends the leaflet in a spike, and a
 * trefoil of spikes reads as a pinwheel rather than as clover.
 */
const OUTLINE_PEAK = 0.7119;   // max of the raw curve below, at u = 0.708
const outline = (u) => {
  const t = Math.min(1, Math.max(0, u));
  return Math.pow(t, 0.55) *
    Math.pow(Math.max(0, 1 - 0.72 * Math.pow(t, 3.2)), 0.55) / OUTLINE_PEAK;
};

/**
 * One leaflet as a parametric surface. Returns a LOCAL offset: x = along the
 * leaflet's own midrib (away from the hub), y = up out of its rest plane,
 * z = across.
 *
 * `petiolule` is the short stalk each leaflet stands off the hub on. Without
 * it three leaflets this broad cannot fit 120 degrees apart without their
 * bases overlapping -- the blade's own half-width already exceeds the gap to
 * its neighbour before it has extended far enough to clear it. A real trefoil
 * solves this exactly the way its name says: three short stalks before the
 * blade proper starts.
 */
function leafletSurface(length, width, fold, notch, droop, petiolule) {
  return (u, v) => {
    const across = (v - 0.5) * 2 * width * outline(u);
    // Apical notch: the heart-shaped nick every trefoil leaflet carries. It
    // is cut into the LENGTH at the midrib, not out of the width -- a clover
    // leaflet is not narrower at the tip, it is shorter down the middle. The
    // u^8 confines it to the apex so the base outline is untouched.
    const nick = notch * Math.exp(-Math.pow((v - 0.5) * 4.0, 2)) * Math.pow(u, 8);
    const along = petiolule + (u - nick) * length;
    // A shallow channel along the midrib, and a tip that bends down toward
    // the soil -- the leaflet lies on the sward rather than hovering over it.
    const y = -fold * width * Math.pow((v - 0.5) * 2, 2)
      - droop * length * Math.pow(u, 2.4);
    return [along, y, across];
  };
}

/**
 * The whole trefoil: a short petiole rising from the attach point to a hub,
 * then three leaflets fanned evenly around it and held almost flat. Built once
 * per species and shared by every individual, the way every other part is.
 *
 * @param {{attachFrac:number, petioleLength:number, petioleRadius:number,
 *          petiolule:number, leafletLength:number, leafletWidth:number,
 *          fold:number, notch:number}} cfg
 */
export function buildCloverLeafMesh(cfg, seed = 19) {
  const rng = makeRng(seed);
  const mb = new MeshBuilder();

  // Petiole: a thin tapering tube from the attach point up to the hub. It
  // hangs off the ONE point `attachFrac` names on the plant's stem chain, so
  // -- unlike the main stem's own tube -- its rise is stored as real offset,
  // not something a per-vertex chain lookup supplies.
  const petioleSurf = (u, v) => {
    const th = v * Math.PI * 2;
    const r = cfg.petioleRadius * (1 - 0.35 * u);
    return [Math.cos(th) * r, u * cfg.petioleLength, Math.sin(th) * r];
  };
  sampleSurface(mb, petioleSurf, 9, 6, {
    uv: (u, v) => [v, u], axis: () => 0, stemHeight: cfg.attachFrac, variant: rng.next(),
  });

  // Three leaflets, evenly fanned with a little jitter in angle and tilt so
  // the whorl does not read as a machined part. The angle jitter is kept
  // small on purpose: the leaflets are sized to almost touch their
  // neighbours, and a wider swing risks crossing into them.
  for (let i = 0; i < LEAFLETS; i++) {
    const az = (i / LEAFLETS) * Math.PI * 2 + rng.sym(0.05);
    // Barely off the horizontal. The leaflets used to tip up 6-14 degrees
    // from a 45mm petiole, which held the trefoil out as a little table on a
    // stick; held flat on a short one they close over the ground, which is
    // what a clover patch actually does.
    const tilt = rng.range(0.02, 0.11);
    const cosA = Math.cos(az), sinA = Math.sin(az);
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const variant = rng.next();
    const length = cfg.leafletLength * rng.range(0.92, 1.08);
    const width = cfg.leafletWidth * rng.range(0.90, 1.10);

    const local = leafletSurface(length, width, cfg.fold, cfg.notch, 0.16, cfg.petiolule);
    const surf = (u, v) => {
      const [along, y, across] = local(u, v);
      // Tilt the leaflet's own plane up before fanning it around the hub.
      const alongT = along * cosT - y * sinT;
      const yT = along * sinT + y * cosT;
      return [
        cosA * alongT - sinA * across,
        cfg.petioleLength + yT,
        sinA * alongT + cosA * across,
      ];
    };
    sampleSurface(mb, surf, GRID[0], GRID[1], {
      // Registered with the baked leaf maps, exactly the way buildLeafMesh
      // registers a single blade. The maps are baked once for the whole field
      // against DEFAULT_SHAPE, and plant.wgsl DISCARDS wherever their alpha
      // says "outside the blade" -- so a leaflet whose uv ran the plain unit
      // square had the daisy's own silhouette cut out of it. Squeezing the
      // leaflet's parameter domain inside that silhouette instead means the
      // outline is the geometry's business (which is where a compound leaf's
      // shape belongs) and the texture only ever supplies veins.
      //
      // The 0.86 keeps the apex off the reference blade's own tip, where the
      // half-width goes to zero and every texel of the leaflet's broad end
      // would collapse onto one column of the map. The 0.90 across (1.80/2)
      // keeps the margin inside the reference blade's TEETH, which cut in to
      // 0.94 of its smooth half-width; the chew holes it does still cross are
      // welcome -- a clover patch is grazed harder than anything else here.
      uv: (u, v) => [0.5 + (v - 0.5) * 1.80 * leafHalfWidth(u * 0.86, DEFAULT_SHAPE),
                     1 - u * 0.86],
      axis: () => 0, stemHeight: cfg.attachFrac, variant,
    });
  }
  return mb.finish();
}
