// The flower's morphospace: a handful of meadow composites, and the rules for
// drawing one individual out of a species.
//
// The point of this file is that colour is NOT a free parameter. A meadow does
// not contain a uniform random distribution of hues -- it contains a few taxa,
// each of which loads two or three pigments into the same white, air-filled
// petal tissue, and varies only in how much. So a ray floret's albedo here is
// built the way a real one is: a scattering ground, minus what the pigments
// absorb. Vary the loading and you get the range a species actually shows;
// vary the loading a lot and you get a different species. You cannot get a
// colour that no flower has, which is exactly the constraint that makes a
// field of these read as a field rather than as a colour picker.

import { makeRng } from './rand.js';

// ---------------------------------------------------------------------------
// Pigments
// ---------------------------------------------------------------------------

/**
 * Absorbance per unit pigment loading, in linear RGB.
 *
 * Carotenoids (lutein, beta-carotene) eat blue and leave yellow. Anthocyanins
 * eat green and leave magenta. The blue of a cornflower is the same
 * anthocyanin class complexed with metal ions and shifted to eat red as well
 * -- which is why blue is rare in the Asteraceae and why it is a separate
 * loading here rather than a hue rotation.
 */
const PIGMENT = {
  carotenoid:  [0.03, 0.30, 1.55],
  anthocyanin: [0.10, 1.30, 0.35],
  cyanic:      [1.15, 0.80, 0.06],
};

/** White, air-filled ray tissue: a strong diffuse scatterer, faintly warm. */
const GROUND = [0.780, 0.762, 0.720];

/** Total absorbance of a pigment load, as a per-channel vector. */
function absorbance(load) {
  const a = [0, 0, 0];
  for (const [name, amount] of Object.entries(load)) {
    const p = PIGMENT[name];
    if (!p || !amount) continue;
    for (let c = 0; c < 3; c++) a[c] += p[c] * amount;
  }
  return a;
}

/** Reflectance of pigmented tissue: ground light minus what the load eats. */
export function petalAlbedo(load, ground = GROUND) {
  const a = absorbance(load);
  return [0, 1, 2].map((c) => ground[c] * Math.exp(-a[c]));
}

/**
 * Fraction of light that survives a crossing of the same tissue.
 *
 * Transmission takes a longer path through the pigment than reflection does,
 * so the same load bites harder -- which is why a backlit pink petal glows a
 * deeper red than it looks in reflection, and why this is a separate number
 * rather than a copy of the albedo.
 */
export function petalTransmit(load, path = 1.35) {
  const a = absorbance(load);
  return [0, 1, 2].map((c) => Math.min(0.97, Math.max(0.02, Math.exp(-a[c] * path))));
}

/** Foliage: chlorophyll over the same ground, with a little carotenoid. */
function leafAlbedo(chlorophyll, senescence = 0) {
  const green = [0.115, 0.230, 0.062];
  const dry = [0.240, 0.185, 0.070];
  const k = Math.exp(-chlorophyll * 0.55);
  return [0, 1, 2].map((c) => (green[c] * (1 - senescence) + dry[c] * senescence) * (0.55 + 0.75 * k));
}

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

// Ray counts below are all Fibonacci numbers, and deliberately so: the ray
// whorl sits on the same phyllotactic lattice as the disc, so a capitulum with
// 20 or 22 rays is a thing you have to go looking for. It is also the one
// trait held constant WITHIN a species here -- individuals vary in size,
// pigment and phenology, but a species that makes 21 rays makes 21 rays.

/**
 * The trefoil every clover entry shares, so the leaf-only form and the
 * flowering minority are recognisably the same plant. Sized to clear short
 * turf rather than hide in it -- see geom/clover.js for the builder.
 */
const CLOVER_LEAF = {
  // Low on the stem: the leaf sways with the plant's near-pinned base rather
  // than its tip, which is most of what keeps it still against the gust a
  // full-height peduncle answers to.
  attachFrac: 0.15,
  petioleLength: 0.045,
  petioleRadius: 0.00060,
  // A short stalk of its own before each leaflet's blade starts: three
  // leaflets this close to round cannot fit 120 degrees apart from a single
  // shared point without their bases overlapping.
  petiolule: 0.0035,
  leafletLength: 0.014,
  leafletWidth: 0.0115,
  fold: 0.32,
  notch: 0.20,
};

/**
 * The taxa. Lengths are metres; a bee works at this scale, so "head" numbers
 * in the 20-50mm range are the whole subject.
 *
 * `niche` is what the sampler in field.js reads: where on the moisture and
 * exposure gradients this species actually wins. `dispersal` is how it gets
 * there -- clonal spreaders make tight patches, wind-dispersed annuals make
 * loose drifts. Between them they are why a meadow looks like drifts of a few
 * things rather than a shuffled deck.
 */
export const SPECIES = [
  {
    key: 'oxeye',
    name: 'Ox-eye daisy',
    abundance: 1.00,
    head: { discRadius: 0.0072, dome: 0.0021, domeExp: 0.85, floretCount: 380 },
    rays: {
      whorls: [
        { count: 21, length: 0.0215, width: 0.0044, droop: 0.30, tilt: 0.10 },
        { count: 13, length: 0.0176, width: 0.0038, droop: 0.20, tilt: 0.26 },
      ],
      twist: 0.16, notchDepth: 0.05, notchCount: 1.5, cup: 0.16,
      waviness: 0.13, veinCount: 5,
    },
    ray:  { carotenoid: 0.05, anthocyanin: 0.0, cyanic: 0.0 },
    tip:  { carotenoid: 0.02, anthocyanin: 0.0, cyanic: 0.0 },
    disc: { carotenoid: 1.85, anthocyanin: 0.05, cyanic: 0.0 },
    guide: 0.55,      // nectar-guide strength at the ray's base
    tipReach: 0.06,   // how far down from the tip the tip pigment runs
    chlorophyll: 1.35,
    stem: { height: 0.300, baseRadius: 0.00135, topRadius: 0.00105,
            leafScale: 0.85, leanMax: 0.13 },
    phenology: { bloom: 0.94, bloomSpread: 0.10, front: 0.34, frontSpread: 0.22 },
    niche: { moisture: 0.48, tolerance: 0.30, exposure: 0.55, shortTurf: 0.2 },
    dispersal: { patchRadius: 0.52, clumpiness: 0.55, spacing: 0.055 },
  },
  {
    key: 'mayweed',
    name: 'Scentless mayweed',
    abundance: 0.72,
    head: { discRadius: 0.0058, dome: 0.0038, domeExp: 0.55, floretCount: 340 },
    rays: {
      whorls: [
        { count: 21, length: 0.0128, width: 0.0035, droop: 0.52, tilt: 0.04 },
        { count: 13, length: 0.0104, width: 0.0030, droop: 0.38, tilt: 0.22 },
      ],
      twist: 0.24, notchDepth: 0.09, notchCount: 2.5, cup: 0.24,
      waviness: 0.19, veinCount: 4,
    },
    ray:  { carotenoid: 0.03, anthocyanin: 0.0, cyanic: 0.0 },
    tip:  { carotenoid: 0.0,  anthocyanin: 0.0, cyanic: 0.0 },
    disc: { carotenoid: 2.20, anthocyanin: 0.0, cyanic: 0.0 },
    guide: 0.45,      // nectar-guide strength at the ray's base
    tipReach: 0.05,   // how far down from the tip the tip pigment runs
    chlorophyll: 1.15,
    stem: { height: 0.235, baseRadius: 0.00110, topRadius: 0.00085,
            leafScale: 0.62, leanMax: 0.22 },
    phenology: { bloom: 0.88, bloomSpread: 0.18, front: 0.30, frontSpread: 0.26 },
    // A disturbance annual: it takes the bare, trodden, wetter ground.
    niche: { moisture: 0.70, tolerance: 0.26, exposure: 0.80, shortTurf: 0.0 },
    dispersal: { patchRadius: 0.34, clumpiness: 0.85, spacing: 0.040 },
  },
  {
    key: 'marigold',
    name: 'Corn marigold',
    abundance: 0.55,
    head: { discRadius: 0.0095, dome: 0.0028, domeExp: 0.80, floretCount: 420 },
    rays: {
      whorls: [
        { count: 21, length: 0.0182, width: 0.0072, droop: 0.24, tilt: 0.16 },
        { count: 13, length: 0.0150, width: 0.0060, droop: 0.16, tilt: 0.32 },
      ],
      twist: 0.10, notchDepth: 0.12, notchCount: 2.5, cup: 0.12,
      waviness: 0.10, veinCount: 6,
    },
    ray:  { carotenoid: 1.55, anthocyanin: 0.02, cyanic: 0.0 },
    tip:  { carotenoid: 1.15, anthocyanin: 0.0,  cyanic: 0.0 },
    disc: { carotenoid: 2.60, anthocyanin: 0.18, cyanic: 0.0 },
    guide: 0.95,      // nectar-guide strength at the ray's base
    tipReach: 0.22,   // how far down from the tip the tip pigment runs
    chlorophyll: 0.95,
    stem: { height: 0.255, baseRadius: 0.00150, topRadius: 0.00120,
            leafScale: 1.00, leanMax: 0.16 },
    phenology: { bloom: 0.92, bloomSpread: 0.12, front: 0.42, frontSpread: 0.24 },
    niche: { moisture: 0.38, tolerance: 0.24, exposure: 0.85, shortTurf: 0.0 },
    dispersal: { patchRadius: 0.44, clumpiness: 0.80, spacing: 0.062 },
  },
  {
    key: 'catsear',
    name: "Common cat's-ear",
    abundance: 0.85,
    // Ligulate: every floret is a strap, so the "disc" is small, flat and
    // hidden under three dense whorls of rays rather than being the subject.
    head: { discRadius: 0.0042, dome: 0.0009, domeExp: 1.10, floretCount: 190 },
    rays: {
      whorls: [
        { count: 34, length: 0.0126, width: 0.0022, droop: 0.16, tilt: 0.18 },
        { count: 21, length: 0.0104, width: 0.0020, droop: 0.10, tilt: 0.34 },
        { count: 13, length: 0.0082, width: 0.0018, droop: 0.05, tilt: 0.52 },
      ],
      twist: 0.06, notchDepth: 0.16, notchCount: 2.5, cup: 0.30,
      waviness: 0.08, veinCount: 3,
    },
    ray:  { carotenoid: 1.72, anthocyanin: 0.0, cyanic: 0.0 },
    tip:  { carotenoid: 1.95, anthocyanin: 0.06, cyanic: 0.0 },
    disc: { carotenoid: 1.90, anthocyanin: 0.0, cyanic: 0.0 },
    guide: 0.75,      // nectar-guide strength at the ray's base
    tipReach: 0.28,   // how far down from the tip the tip pigment runs
    chlorophyll: 1.45,
    stem: { height: 0.205, baseRadius: 0.00105, topRadius: 0.00080,
            leafScale: 0.35, leanMax: 0.10 },
    phenology: { bloom: 0.86, bloomSpread: 0.22, front: 0.18, frontSpread: 0.20 },
    // The generalist. Wide tolerance is what makes it the matrix species that
    // shows up between everyone else's patches.
    niche: { moisture: 0.50, tolerance: 0.46, exposure: 0.60, shortTurf: 0.5 },
    dispersal: { patchRadius: 0.75, clumpiness: 0.30, spacing: 0.038 },
  },
  {
    key: 'bellis',
    name: 'Common daisy',
    abundance: 0.95,
    head: { discRadius: 0.0038, dome: 0.0014, domeExp: 0.75, floretCount: 150 },
    rays: {
      whorls: [
        { count: 34, length: 0.0072, width: 0.0014, droop: 0.34, tilt: 0.12 },
        { count: 21, length: 0.0060, width: 0.0013, droop: 0.24, tilt: 0.30 },
      ],
      twist: 0.12, notchDepth: 0.04, notchCount: 1.5, cup: 0.20,
      waviness: 0.10, veinCount: 3,
    },
    ray:  { carotenoid: 0.04, anthocyanin: 0.03, cyanic: 0.0 },
    // The crimson underside every schoolchild knows: anthocyanin loaded into
    // the tip and the abaxial face only.
    tip:  { carotenoid: 0.06, anthocyanin: 1.45, cyanic: 0.0 },
    disc: { carotenoid: 2.05, anthocyanin: 0.0, cyanic: 0.0 },
    guide: 0.30,      // nectar-guide strength at the ray's base
    tipReach: 0.40,   // how far down from the tip the tip pigment runs
    chlorophyll: 1.55,
    stem: { height: 0.078, baseRadius: 0.00075, topRadius: 0.00062,
            leafScale: 0.0, leanMax: 0.09 },
    phenology: { bloom: 0.90, bloomSpread: 0.20, front: 0.26, frontSpread: 0.28 },
    // A rosette of a plant: it wins exactly where the sward is grazed short.
    niche: { moisture: 0.55, tolerance: 0.34, exposure: 0.45, shortTurf: 1.0 },
    // Clonal, so it makes tight sheets rather than drifts.
    dispersal: { patchRadius: 0.22, clumpiness: 1.00, spacing: 0.024 },
  },
  {
    key: 'cornflower',
    name: 'Cornflower',
    abundance: 0.34,
    head: { discRadius: 0.0055, dome: 0.0016, domeExp: 1.20, floretCount: 120 },
    rays: {
      whorls: [
        { count: 13, length: 0.0155, width: 0.0092, droop: -0.28, tilt: 0.62 },
        { count: 8,  length: 0.0104, width: 0.0070, droop: -0.18, tilt: 0.86 },
      ],
      // The flared, deeply cut trumpets of the sterile outer ring.
      twist: 0.34, notchDepth: 0.34, notchCount: 2.5, cup: 0.42,
      waviness: 0.16, veinCount: 3,
    },
    ray:  { carotenoid: 0.0, anthocyanin: 0.16, cyanic: 1.40 },
    tip:  { carotenoid: 0.0, anthocyanin: 0.30, cyanic: 1.85 },
    disc: { carotenoid: 0.10, anthocyanin: 1.05, cyanic: 1.15 },
    guide: 0.60,      // nectar-guide strength at the ray's base
    tipReach: 0.55,   // how far down from the tip the tip pigment runs
    chlorophyll: 0.80,
    stem: { height: 0.330, baseRadius: 0.00125, topRadius: 0.00098,
            leafScale: 0.55, leanMax: 0.20 },
    phenology: { bloom: 0.90, bloomSpread: 0.14, front: 0.50, frontSpread: 0.20 },
    niche: { moisture: 0.30, tolerance: 0.22, exposure: 0.90, shortTurf: 0.0 },
    dispersal: { patchRadius: 0.40, clumpiness: 0.90, spacing: 0.070 },
  },
  {
    key: 'clover',
    name: 'White clover',
    // The plant most people mean by "clover patch" is the leaf, not the
    // flower -- so this is the common form: a short, almost hidden bud under
    // a big trefoil. `cloverBloom` below is the minority that actually
    // flowers; the two share a niche and a dispersal kernel so they read as
    // one patch, not two competing species.
    abundance: 1.70,
    head: { discRadius: 0.0012, dome: 0.0010, domeExp: 0.70, floretCount: 12 },
    rays: { whorls: [], twist: 0, notchDepth: 0, notchCount: 1, cup: 0, waviness: 0, veinCount: 3 },
    ray:  { carotenoid: 0.0,  anthocyanin: 0.0,  cyanic: 0.0 },
    tip:  { carotenoid: 0.0,  anthocyanin: 0.0,  cyanic: 0.0 },
    disc: { carotenoid: 0.04, anthocyanin: 0.20, cyanic: 0.0 },
    guide: 0.0,       // no ray whorl to guide a bee into
    tipReach: 0.0,
    chlorophyll: 1.30,
    cloverLeaf: CLOVER_LEAF,
    // Short AND thick: a stiff, stubby peduncle carrying a bud nobody is
    // meant to notice under the leaf canopy. Thickness matters as much as
    // height here -- see stemWindGain in this file -- because a stem this
    // short on the old thin radius still swayed enough to read as jitter.
    stem: { height: 0.032, baseRadius: 0.00110, topRadius: 0.00090,
            leafScale: 1.0, leanMax: 0.08 },
    // Low bloom AND low front keep the tiny disc folded -- floret.wgsl's
    // openness is bloom times the maturation front -- so what would
    // otherwise be a white fleck under the leaves stays a closed green bud.
    phenology: { bloom: 0.22, bloomSpread: 0.10, front: 0.10, frontSpread: 0.10 },
    // Stoloniferous and short: it wins on the grazed, trodden turf a lawn is
    // made of, and forms a tight mat rather than reaching for open ground.
    niche: { moisture: 0.55, tolerance: 0.42, exposure: 0.40, shortTurf: 0.90 },
    // Clonal spread by stolon, so a patch is dense and packed edge to edge.
    dispersal: { patchRadius: 0.26, clumpiness: 0.95, spacing: 0.022 },
  },
  {
    key: 'cloverBloom',
    name: 'White clover (flowering)',
    abundance: 0.40,
    // Not a composite: a clover head is a dense globe of small pea-flower
    // tubes with no ray whorl at all. That happens to be exactly the disc
    // floret this file already builds for every other species, so a "clover"
    // here is just that floret, packed onto a near-spherical dome instead of
    // a flat one, with the ray whorl left empty.
    head: { discRadius: 0.0078, dome: 0.0072, domeExp: 0.62, floretCount: 260 },
    rays: { whorls: [], twist: 0, notchDepth: 0, notchCount: 1, cup: 0, waviness: 0, veinCount: 3 },
    ray:  { carotenoid: 0.0,  anthocyanin: 0.0,  cyanic: 0.0 },
    tip:  { carotenoid: 0.0,  anthocyanin: 0.0,  cyanic: 0.0 },
    // The whole visible head is disc floret, so its pigment carries the
    // colour: a warm white with the faint rose blush a clover ball ages into.
    disc: { carotenoid: 0.04, anthocyanin: 0.20, cyanic: 0.0 },
    guide: 0.0,       // no ray whorl to guide a bee into
    tipReach: 0.0,
    chlorophyll: 1.30,
    cloverLeaf: CLOVER_LEAF,
    // Taller than the leaf-only form so the head clears the canopy, and just
    // as thick: the same fix for the same jitter.
    stem: { height: 0.100, baseRadius: 0.00115, topRadius: 0.00095,
            leafScale: 1.0, leanMax: 0.10 },
    // The disc is the whole flower here -- there is no ray whorl to hide an
    // unopened crown -- so the front needs to run much further than a
    // composite's before the head reads as blooming rather than budded.
    phenology: { bloom: 0.88, bloomSpread: 0.16, front: 0.68, frontSpread: 0.22 },
    niche: { moisture: 0.55, tolerance: 0.42, exposure: 0.40, shortTurf: 0.90 },
    dispersal: { patchRadius: 0.26, clumpiness: 0.95, spacing: 0.022 },
  },
];

export const SPECIES_BY_KEY = Object.fromEntries(SPECIES.map((s) => [s.key, s]));

/**
 * The reference plant the stem solver's constants were tuned against: an
 * ox-eye at its species mean. tools/sim-stem.mjs runs at exactly these values.
 */
const REFERENCE_STEM = { height: SPECIES[0].stem.height, radius: SPECIES[0].stem.baseRadius };

/**
 * How hard the wind moves THIS stem, relative to the reference.
 *
 * A stem is a cantilever: tip deflection under a distributed load goes as
 * L^4 / r^4, so a 78mm common daisy on a 0.75mm stalk should barely nod while
 * a 330mm cornflower on a stalk not much thicker whips about. Measured
 * offline, the solver's own deflection is almost independent of chain length
 * at a fixed acceleration -- so the whole of that ratio has to come in here,
 * as a per-plant gain on the wind force.
 *
 * The exponent is 2, not the beam theory's 4. Two reasons, both honest: a
 * flower stem is a fluid-filled tube with a stiffening rind rather than a
 * solid rod, so its second moment does not follow r^4; and at 4 the daisy
 * comes out at 0.7mm of sway, which is visibly less than a daisy actually
 * does in a breeze. At 2 the field runs from about 3mm on a daisy to 20mm on
 * a cornflower, which is what the reference photographs show. The clamp keeps
 * every plant inside the range tools/sim-stem.mjs has actually measured.
 */
export function stemWindGain(stemHeight, baseRadius) {
  const g = (stemHeight / REFERENCE_STEM.height) ** 2 *
            (REFERENCE_STEM.radius / Math.max(1e-5, baseRadius)) ** 2;
  return Math.min(2.5, Math.max(0.15, g));
}

/** Widest extent of a species' head, which is what culling and LOD measure. */
export function headRadius(species) {
  let r = species.head.discRadius;
  for (const w of species.rays.whorls) r = Math.max(r, species.head.discRadius * 0.92 + w.length);
  return r;
}

/** Total ray count across every whorl. */
export const rayCount = (species) =>
  species.rays.whorls.reduce((n, w) => n + w.count, 0);

/**
 * Rays in the outermost whorl, which is the number that shows in silhouette --
 * the inner whorls sit in the outer one's gaps. This is what the impostor
 * modulates its star by, so a distant cornflower reads as thirteen broad
 * lobes and a distant cat's-ear as a finely fringed disc.
 */
export const silhouetteRays = (species) => species.rays.whorls[0]?.count ?? 0;

// ---------------------------------------------------------------------------
// Individuals
// ---------------------------------------------------------------------------

/**
 * Draw one plant from a species.
 *
 * Every axis of variation here is one a botanist would recognise: overall
 * vigour (which correlates size, stem height and pigment strength, because
 * they all come out of the same carbon budget), a phenological offset (this
 * one opened three days before that one), and a pigment loading that scatters
 * around the species mean. Nothing is an independent random colour. Two plants
 * of the same species in the same patch therefore look like siblings, which is
 * the whole cue that they ARE the same species.
 *
 * `vigour` is passed in rather than drawn, so the sampler can correlate it
 * with the habitat -- a plant on the good ground is a bigger plant.
 */
export function individual(species, rng, vigour = 1) {
  const v = Math.max(0.45, Math.min(1.6, vigour * rng.range(0.86, 1.16)));
  // Pigment loadings scale with vigour and scatter a little. The scatter is
  // MULTIPLICATIVE, so a species with no anthocyanin cannot acquire any.
  const jitter = (load, k) => Object.fromEntries(
    Object.entries(load).map(([p, a]) => [p, a * k]));
  const pigmentK = rng.range(0.80, 1.22) * (0.72 + 0.28 * v);

  const ray = jitter(species.ray, pigmentK);
  const tip = jitter(species.tip, pigmentK);
  const disc = jitter(species.disc, rng.range(0.90, 1.12));
  const senescence = Math.min(0.85, Math.max(0, rng.gauss(0.10, 0.10)));

  const ph = species.phenology;
  return {
    scale: v,
    stemHeight: species.stem.height * rng.range(0.80, 1.24) * (0.65 + 0.35 * v),
    lean: rng.range(0, species.stem.leanMax) * rng.range(0.3, 1.0),
    leanDir: rng.range(0, Math.PI * 2),
    yaw: rng.range(0, Math.PI * 2),
    // Phenology: an individual is somewhere in its own flowering, and the
    // maturation front is somewhere in its own sweep across the disc.
    bloom: Math.max(0.18, Math.min(1, rng.gauss(ph.bloom, ph.bloomSpread))),
    front: Math.max(0, Math.min(1, rng.gauss(ph.front, ph.frontSpread))),
    rayAlbedo: petalAlbedo(ray),
    rayTransmit: petalTransmit(ray),
    tipAlbedo: petalAlbedo(tip),
    discAlbedo: petalAlbedo(disc, [0.62, 0.58, 0.50]),
    leafAlbedo: leafAlbedo(species.chlorophyll * rng.range(0.85, 1.15), senescence),
    senescence,
    // Transmission through a leaf falls off as it dries and its air spaces
    // collapse, so this rides on the same number the colour does.
    leafTransmit: 1.0 - 0.55 * senescence,
    variant: rng.next(),
  };
}
