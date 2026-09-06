// The landing-site table: every flower head's live frame, as the GPU published
// it.
//
// This is the whole collision system. The stem solver writes one LandingSite
// per plant in the same compute pass that moves the stem, so the pads can
// never drift out of sync with the geometry that sways, and the flight model
// never tests a triangle. What used to be a single site is now a flat array
// several hundred long -- which is why "the nearest flower" is a linear scan
// of contiguous floats rather than a query against any scene structure. At
// this size that is faster than anything cleverer, and it cannot go stale.

/** Floats per LandingSite; must match the struct in stem.wgsl. */
export const SITE_FLOATS = 16;

const S = {
  posX: 0, posY: 1, posZ: 2, discRadius: 3,
  upX: 4, upY: 5, upZ: 6, nectar: 7,
  velX: 8, velY: 9, velZ: 10, occupied: 11,
  sideX: 12, sideY: 13, sideZ: 14, headRadius: 15,
};

export class HeadSites {
  constructor(capacity = 0) {
    this.data = new Float32Array(capacity * SITE_FLOATS);
    this.count = 0;
  }

  /** Adopt a readback straight from the GPU. */
  adopt(floats, count) {
    this.data = floats;
    this.count = count;
    return this;
  }

  /** Build a table by hand, for tests and for the first frames before any
   *  readback has landed. */
  static fromFrames(frames) {
    const s = new HeadSites(frames.length);
    frames.forEach((f, i) => {
      const o = i * SITE_FLOATS;
      const d = s.data;
      d[o + S.posX] = f.pos[0]; d[o + S.posY] = f.pos[1]; d[o + S.posZ] = f.pos[2];
      d[o + S.discRadius] = f.discRadius ?? 0.008;
      d[o + S.upX] = f.up[0]; d[o + S.upY] = f.up[1]; d[o + S.upZ] = f.up[2];
      d[o + S.nectar] = f.nectar ?? 1;
      const v = f.velocity ?? [0, 0, 0];
      d[o + S.velX] = v[0]; d[o + S.velY] = v[1]; d[o + S.velZ] = v[2];
      d[o + S.sideX] = f.side[0]; d[o + S.sideY] = f.side[1]; d[o + S.sideZ] = f.side[2];
      d[o + S.headRadius] = f.headRadius ?? 0.034;
    });
    s.count = frames.length;
    return s;
  }

  /**
   * The frame of head `i`, written into `out` so a per-frame query allocates
   * nothing.
   */
  frame(i, out = HeadSites.scratch()) {
    const d = this.data, o = i * SITE_FLOATS;
    out.index = i;
    out.pos[0] = d[o + S.posX]; out.pos[1] = d[o + S.posY]; out.pos[2] = d[o + S.posZ];
    out.up[0] = d[o + S.upX]; out.up[1] = d[o + S.upY]; out.up[2] = d[o + S.upZ];
    out.side[0] = d[o + S.sideX]; out.side[1] = d[o + S.sideY]; out.side[2] = d[o + S.sideZ];
    out.velocity[0] = d[o + S.velX]; out.velocity[1] = d[o + S.velY]; out.velocity[2] = d[o + S.velZ];
    out.discRadius = d[o + S.discRadius];
    out.headRadius = d[o + S.headRadius];
    out.nectar = d[o + S.nectar];
    return out;
  }

  static scratch() {
    return {
      index: -1, pos: [0, 0, 0], up: [0, 1, 0], side: [1, 0, 0],
      velocity: [0, 0, 0], discRadius: 0.008, headRadius: 0.034, nectar: 1,
    };
  }

  /** Index of the head nearest `p`, or -1 if the table is empty. */
  nearest(p) {
    const d = this.data;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * SITE_FLOATS;
      const dx = d[o] - p[0], dy = d[o + 1] - p[1], dz = d[o + 2] - p[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD) { bestD = dd; best = i; }
    }
    return best;
  }

  /**
   * Index of the nearest head whose capture shell contains `p`, or -1.
   *
   * Tested in the head's own normalised space, where the crawl surface is
   * exactly the unit sphere whatever the head's size or orientation -- so one
   * comparison covers a 10mm daisy and a 56mm ox-eye without a special case.
   */
  landable(p, out = HeadSites.scratch()) {
    let best = -1, bestR = 1.0;
    for (let i = 0; i < this.count; i++) {
      const f = this.frame(i, out);
      // Cheap reject first: nothing outside the head's own radius plus its
      // margin can possibly be inside the shell.
      const dx = f.pos[0] - p[0], dy = f.pos[1] - p[1], dz = f.pos[2] - p[2];
      const reach = f.headRadius * 1.6;
      if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
      const r = shellRadius(p, f);
      if (r < bestR) { bestR = r; best = i; }
    }
    return best;
  }
}

/** Normalised distance of `p` from the head's capture ellipsoid: <1 is inside. */
export function shellRadius(p, f) {
  const A = crawlAxes(f.headRadius);
  const m = landMargin(f.headRadius);
  const y = f.up;
  let x = f.side;
  const xy = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  x = [x[0] - y[0] * xy, x[1] - y[1] * xy, x[2] - y[2] * xy];
  const xl = Math.hypot(x[0], x[1], x[2]) || 1;
  x = [x[0] / xl, x[1] / xl, x[2] / xl];
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const d = [p[0] - f.pos[0], p[1] - f.pos[1], p[2] - f.pos[2]];
  const lx = d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
  const ly = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
  const lz = d[0] * z[0] + d[1] * z[1] + d[2] * z[2];
  return Math.hypot(lx / (A[0] + m), ly / (A[1] + m), lz / (A[2] + m));
}

/**
 * The landable surface, as an oblate ellipsoid standing in for a flower head.
 * Approximating rather than colliding against the real petals means the walk
 * never catches on a notch and never falls between two florets. Proportions
 * are fixed and the head's own radius sets the size, so the same walk works on
 * a common daisy and an ox-eye.
 */
export const crawlAxes = (headRadius) => [headRadius * 1.17, headRadius * 0.38, headRadius * 1.17];

/**
 * Capture shell, as a margin in metres around that ellipsoid rather than a
 * scale factor. A normalised threshold looks even but is not: at 1.3 it
 * reaches much further out at the rim than above the disc, because the head is
 * thin. A margin proportional to the head's size gives the same forgiving
 * approach from every angle, on every species.
 */
export const landMargin = (headRadius) => headRadius * 0.38;
