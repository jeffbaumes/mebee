// The clover leaf: three round leaflets fanned from one petiole.
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

import { MeshBuilder, sampleSurface } from './mesh.js';
import { makeRng } from './rand.js';

const LEAFLETS = 3;

/**
 * One leaflet as a parametric surface: obovate (widest a little past the
 * middle), with a shallow notch cut into the tip and a gentle fold held
 * along the midrib -- the crease a real trefoil leaflet keeps even at rest.
 * Returns a LOCAL offset: x = along the leaflet's own midrib (away from the
 * hub), y = up out of its rest plane, z = across.
 *
 * `petiolule` is the short stalk each leaflet stands off the hub on. Without
 * it three leaflets this close to round cannot fit 120 degrees apart without
 * their bases overlapping -- the blade's own half-width already exceeds the
 * gap to its neighbour before it has extended far enough to clear it. A real
 * trefoil solves this exactly the way its name says: three short stalks
 * before the blade proper starts.
 */
function leafletSurface(length, width, fold, notch, droop, petiolule, variant) {
  return (u, v) => {
    const widthAt = width * Math.sin(Math.PI * Math.pow(u, 0.60)) *
      (1 - notch * Math.pow(Math.max(0, u), 5));
    const across = (v - 0.5) * 2 * widthAt;
    const along = petiolule + u * length;
    const y = -fold * widthAt * Math.pow((v - 0.5) * 2, 2)
      - droop * length * Math.pow(u, 2.2);
    return [along, y, across];
  };
}

/**
 * The whole trefoil: a petiole rising from the attach point to a hub, then
 * three leaflets fanned evenly around it and tilted up a little. Built once
 * per species and shared by every individual, the way every other part is.
 *
 * @param {{attachFrac:number, petioleLength:number, petioleRadius:number,
 *          leafletLength:number, leafletWidth:number, fold:number,
 *          notch:number}} cfg
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
  // small on purpose: the leaflets are already sized to almost touch their
  // neighbours (see CLOVER_LEAF in species.js), and a wider swing risks
  // crossing into them.
  for (let i = 0; i < LEAFLETS; i++) {
    const az = (i / LEAFLETS) * Math.PI * 2 + rng.sym(0.05);
    const tilt = rng.range(0.10, 0.24);        // leaflets tip up from the hub
    const cosA = Math.cos(az), sinA = Math.sin(az);
    const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
    const variant = rng.next();
    const length = cfg.leafletLength * rng.range(0.92, 1.08);
    const width = cfg.leafletWidth * rng.range(0.90, 1.10);

    const local = leafletSurface(length, width, cfg.fold, cfg.notch, 0.10, cfg.petiolule, variant);
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
    sampleSurface(mb, surf, 11, 9, {
      uv: (u, v) => [v, u], axis: () => 0, stemHeight: cfg.attachFrac, variant,
    });
  }
  return mb.finish();
}
