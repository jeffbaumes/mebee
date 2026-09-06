// Culling and level of detail, driven by the lens rather than by distance.
//
// The usual LOD metric is projected size in pixels. That is the wrong metric
// for this scene, and by a wide margin. At a bee's working distance a 55mm
// lens at f/4 has a depth of field a few millimetres deep, so a flower half a
// metre away is already smeared across a 45-pixel circle of confusion. It may
// still cover two hundred pixels -- projected size says "draw it in full" --
// but nothing finer than that circle survives to the screen. Every triangle
// spent resolving a petal margin is thrown away by dof.wgsl a few passes later.
//
// So the metric here is how many features the image can still RESOLVE across
// the subject:
//
//     detail = projected diameter in pixels / (1 + circle of confusion)
//
// which is the projected size divided by the size of the smallest thing the
// lens can still distinguish. Stopping down to f/16 sharpens the image and
// pulls geometry back in; opening up to f/1.4 throws the whole meadow into
// bokeh and lets almost all of it collapse to two triangles. That is the
// budget working the way it should -- the blur is not a post-process laid over
// the scene, it is the thing that decides how much scene there needs to be.
//
// The same number is handed to the shaders as `sharp`, so procedural surface
// detail -- petal ribs, pollen sparkle, the parastichy pattern on the disc --
// fades out on exactly the same schedule the geometry does.

/** Tiers, finest first. 0-2 are meshes; 3 is the two-triangle impostor. */
export const TIER = { FULL: 0, MID: 1, COARSE: 2, IMPOSTOR: 3, CULLED: 4 };
export const MESH_TIERS = 3;

/** Resolvable-feature counts at which each tier takes over. */
export const THRESHOLD = [60, 16, 4];

/**
 * Detail below which a plant is not drawn at all.
 *
 * The same metric again, used as a noise floor rather than as a tier. A
 * defocused flower does not vanish -- it spreads -- so culling on projected
 * size alone would be wrong: what falls away is its PEAK brightness, as the
 * square of the projected size divided by the blur. At 0.06 the brightest
 * pixel of the blob is under half a per cent of the surface it came from,
 * which is below the grain.
 *
 * Deliberately measured on the UNBIASED detail, so the panel's detail slider
 * moves plants between tiers without ever making one disappear.
 */
const MIN_DETAIL = 0.06;

/**
 * Per-tier caps, so the frame cost is bounded by the budget rather than by
 * where the camera happens to be pointing. A plant that does not fit its tier
 * falls to the next one down; it never disappears.
 */
export const BUDGET = [5, 24, 150, 900];

/** Must match MAX_COC in common.wgsl -- past this the disc is featureless. */
export const MAX_COC = 48.0;

/** Four words per visible instance; must match struct Visible in scene.wgsl. */
export const VISIBLE_WORDS = 4;

/**
 * Signed circle of confusion in pixels. A CPU twin of signedCoC() in
 * common.wgsl: if these two disagree, the geometry is chosen for a blur the
 * image does not have.
 */
export function signedCoC(viewDepth, lens, screenH) {
  const { focusDistance: focus, fNumber, focalLength: focal, sensorHeight } = lens;
  const aperture = focal / Math.max(0.5, fNumber);
  const cocSensor = aperture * focal * (viewDepth - focus) /
                    Math.max(1e-6, viewDepth * (focus - focal));
  return Math.max(-MAX_COC, Math.min(MAX_COC, cocSensor / sensorHeight * screenH));
}

/** The six frustum planes of a column-major view-projection, as ax+by+cz+d. */
export function frustumPlanes(m, out = new Float32Array(24)) {
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const [x0, x1, x2, x3] = row(0);
  const [y0, y1, y2, y3] = row(1);
  const [z0, z1, z2, z3] = row(2);
  const [w0, w1, w2, w3] = row(3);
  // WebGPU clip space is -w <= x,y <= w and 0 <= z <= w.
  const planes = [
    [w0 + x0, w1 + x1, w2 + x2, w3 + x3],   // left
    [w0 - x0, w1 - x1, w2 - x2, w3 - x3],   // right
    [w0 + y0, w1 + y1, w2 + y2, w3 + y3],   // bottom
    [w0 - y0, w1 - y1, w2 - y2, w3 - y3],   // top
    [z0, z1, z2, z3],                        // near
    [w0 - z0, w1 - z1, w2 - z2, w3 - z3],   // far
  ];
  for (let p = 0; p < 6; p++) {
    const [a, b, c, d] = planes[p];
    const l = Math.hypot(a, b, c) || 1;
    out[p * 4] = a / l; out[p * 4 + 1] = b / l;
    out[p * 4 + 2] = c / l; out[p * 4 + 3] = d / l;
  }
  return out;
}

/**
 * Chooses what to draw, at what detail, every frame.
 *
 * Holds its own scratch buffers so a frame allocates nothing: at several
 * hundred plants and sixty frames a second, a per-frame array of objects is
 * the difference between a steady frame time and a sawtooth of GC pauses.
 */
export class LodSelector {
  /**
   * @param {object[]} plants  the field, from geom/field.js
   * @param {number} speciesCount
   */
  constructor(plants, speciesCount) {
    this.plants = plants;
    this.speciesCount = speciesCount;
    const n = plants.length;

    // Static per-plant geometry, flattened. Read every frame, so it is worth
    // having it contiguous rather than chasing object properties.
    this.headX = new Float32Array(n);
    this.headY = new Float32Array(n);
    this.headZ = new Float32Array(n);
    this.headR = new Float32Array(n);
    this.boundY = new Float32Array(n);
    this.boundR = new Float32Array(n);
    this.species = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = plants[i];
      this.headX[i] = p.x;
      this.headY[i] = p.stemHeight;
      this.headZ[i] = p.z;
      this.headR[i] = p.headRadius;
      // A sphere around the whole plant, for the frustum test: the head sits
      // at the top, the leaves hang out sideways, and the stem leans.
      this.boundY[i] = p.stemHeight * 0.6;
      this.boundR[i] = Math.max(p.headRadius, p.stemHeight * 0.55) + 0.02;
      this.species[i] = p.species;
    }

    // Previous frame's tier, for the hysteresis that stops a plant sitting on
    // a threshold from flipping detail every frame.
    this.lastTier = new Uint8Array(n).fill(TIER.IMPOSTOR);

    this.planes = new Float32Array(24);
    // Candidate list, as parallel arrays indexed by candidate slot.
    this.candPlant = new Int32Array(n);
    this.candTier = new Uint8Array(n);
    this.candDetail = new Float32Array(n);
    this.candDist = new Float32Array(n);
    this.candCoC = new Float32Array(n);
    this.order = new Int32Array(n);

    this.buffer = new ArrayBuffer(n * VISIBLE_WORDS * 4);
    this.visibleU32 = new Uint32Array(this.buffer);
    this.visibleF32 = new Float32Array(this.buffer);

    /** @type {{tier:number, species:number, base:number, count:number}[]} */
    this.runs = [];
    /** Slots of the plants fine enough to draw real disc florets. */
    this.floretSlots = [];
    this.impostor = { base: 0, count: 0 };
    this.stats = { tiers: [0, 0, 0, 0], visible: 0, culled: 0, total: n };
    this.bias = 1.0;
  }

  /**
   * @param {object} camera    a MacroCamera, already updated for this frame
   * @param {number} screenH   render target height in pixels
   * @param {number} sensorHeight
   * @param {number} pinned    plant index to force to the finest tier, or -1
   */
  select(camera, screenH, sensorHeight, pinned = -1) {
    const planes = frustumPlanes(camera.viewProj, this.planes);
    const eye = camera.position;
    const lens = {
      focusDistance: camera.focusDistance,
      fNumber: camera.fNumber,
      focalLength: camera.focalLength,
      sensorHeight,
    };
    // Pixels per radian at the centre of frame, which is what turns a world
    // size into a projected one.
    const focalPx = screenH / (2 * camera.tanHalfFovY);
    const n = this.plants.length;

    // --- cull, and measure what survives ---------------------------------
    let nc = 0, culled = 0;
    for (let i = 0; i < n; i++) {
      const cx = this.headX[i], cy = this.boundY[i], cz = this.headZ[i];
      const r = this.boundR[i];
      let inside = true;
      for (let p = 0; p < 6; p++) {
        const o = p * 4;
        if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -r) {
          inside = false;
          break;
        }
      }
      if (!inside) { culled++; continue; }

      const dx = this.headX[i] - eye[0];
      const dy = this.headY[i] - eye[1];
      const dz = this.headZ[i] - eye[2];
      const dist = Math.max(1e-4, Math.hypot(dx, dy, dz));
      const pxDiameter = 2 * this.headR[i] * focalPx / dist;
      const coc = Math.abs(signedCoC(dist, lens, screenH));
      // The whole point of this file, in one line: the pixel grid is not the
      // limit -- the lens is. Divide the projected size by the width of the
      // smallest feature that survives the blur, and what is left is how many
      // features there is any point drawing.
      const resolvable = pxDiameter / (1 + coc);
      if (resolvable < MIN_DETAIL) { culled++; continue; }
      const detail = resolvable * this.bias;

      this.candPlant[nc] = i;
      this.candDetail[nc] = detail;
      this.candDist[nc] = dist;
      this.candCoC[nc] = coc;
      this.candTier[nc] = i === pinned ? TIER.FULL : this.tierFor(detail, this.lastTier[i]);
      this.order[nc] = nc;
      nc++;
    }

    // --- spend the budget, finest first ----------------------------------
    // Sorting by detail and filling the tiers in order means the budget always
    // buys the plants where it shows most, and a plant that misses out is
    // demoted rather than dropped.
    const sub = this.order.subarray(0, nc);
    sub.sort((a, b) => this.candDetail[b] - this.candDetail[a]);

    const spent = [0, 0, 0, 0];
    for (let k = 0; k < nc; k++) {
      const c = sub[k];
      let t = this.candTier[c];
      // The pinned plant is the one the bee is standing on, four millimetres
      // from the lens. It keeps its tier even if that overruns the budget --
      // there is exactly one of it, and demoting it is the single most
      // visible thing this file could do.
      const isPinned = this.candPlant[c] === pinned;
      while (!isPinned && t < TIER.IMPOSTOR && spent[t] >= BUDGET[t]) t++;
      // The impostor tier is the floor: it is two triangles, so running out of
      // budget there means the field is bigger than the cap and the tail is
      // genuinely dropped.
      if (!isPinned && t === TIER.IMPOSTOR && spent[t] >= BUDGET[t]) { t = TIER.CULLED; }
      else spent[t]++;
      this.candTier[c] = t;
      if (t !== TIER.CULLED) this.lastTier[this.candPlant[c]] = t;
    }

    // --- lay the visible list out in draw order --------------------------
    // Runs must be contiguous per (tier, species) because each one becomes a
    // single instanced draw whose firstInstance is the run's base.
    this.runs.length = 0;
    this.floretSlots.length = 0;
    const u32 = this.visibleU32, f32 = this.visibleF32;
    let slot = 0;

    for (let tier = 0; tier < MESH_TIERS; tier++) {
      for (let sp = 0; sp < this.speciesCount; sp++) {
        const base = slot;
        for (let k = 0; k < nc; k++) {
          const c = sub[k];
          if (this.candTier[c] !== tier) continue;
          const i = this.candPlant[c];
          if (this.species[i] !== sp) continue;
          this.write(slot, i, tier, this.candDetail[c], this.candCoC[c]);
          if (tier === TIER.FULL) this.floretSlots.push({ slot, plant: i, species: sp });
          slot++;
        }
        if (slot > base) this.runs.push({ tier, species: sp, base, count: slot - base });
      }
    }

    // Impostors are alpha blended, so they have to arrive back to front.
    const imps = [];
    for (let k = 0; k < nc; k++) {
      if (this.candTier[sub[k]] === TIER.IMPOSTOR) imps.push(sub[k]);
    }
    imps.sort((a, b) => this.candDist[b] - this.candDist[a]);
    this.impostor.base = slot;
    for (const c of imps) {
      this.write(slot++, this.candPlant[c], TIER.IMPOSTOR,
                 this.candDetail[c], this.candCoC[c]);
    }
    this.impostor.count = slot - this.impostor.base;

    this.stats.tiers = spent;
    this.stats.visible = slot;
    this.stats.culled = culled + (nc - spent[0] - spent[1] - spent[2] - spent[3]);
    this.byteLength = slot * VISIBLE_WORDS * 4;
    return this;
  }

  /** One Visible record: plant id, tier, resolvable detail, blur in pixels. */
  write(slot, plant, tier, detail, coc) {
    const o = slot * VISIBLE_WORDS;
    this.visibleU32[o] = plant;
    this.visibleU32[o + 1] = tier;
    // Normalised against the finest threshold, so the shaders get a plain 0..1
    // "how much fine detail is worth drawing" with no thresholds of their own.
    this.visibleF32[o + 2] = Math.min(1, detail / THRESHOLD[0]);
    this.visibleF32[o + 3] = coc;
  }

  /**
   * Tier for a detail count, with a dead band around every threshold.
   *
   * Without the band a plant hovering on a boundary swaps mesh every frame,
   * and even though the coarse mesh shares the fine one's vertices the shading
   * still ticks. The band is asymmetric: it is easier to stay at the tier you
   * already hold than to reach a finer one.
   */
  tierFor(detail, prev) {
    const UP = 1.15, DOWN = 1 / 1.15;
    for (let k = 0; k < THRESHOLD.length; k++) {
      if (detail >= THRESHOLD[k] * (prev <= k ? DOWN : UP)) return k;
    }
    return TIER.IMPOSTOR;
  }
}
