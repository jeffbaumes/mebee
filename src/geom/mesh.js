// Interleaved mesh builder shared by every procedural plant part.
//
// Vertex layout: 20 floats / 80 bytes.
//   0..2   position   (bloomed / open state)
//   3..5   normal     (open)
//   6..8   position   (bud / closed state)
//   9..11  normal     (bud)
//   12..14 tangent    (open, along the surface's u direction)
//   15..16 uv
//   17     axis       0 at the attachment, 1 at the free tip -- wind response
//   18     stemHeight 0..1 height of the attachment along the stem
//   19     variant    per-element random id, breaks up shared detail textures
//
// Storing both a bud and an open state lets the vertex shader morph the whole
// flower with one uniform, which is what makes "flowers open" a shader
// variable rather than an animation system.

export const FLOATS_PER_VERTEX = 20;
export const VERTEX_STRIDE = FLOATS_PER_VERTEX * 4;

/**
 * Levels of detail every grid-based mesh is stitched at, coarsening by a
 * factor of two each time. Three is the useful range: past level 2 a petal is
 * two triangles and there is nothing left to remove, which is where the
 * impostor takes over instead.
 */
export const LOD_COUNT = 3;

export class MeshBuilder {
  constructor() {
    this.verts = [];
    this.indices = [];
    /** One record per stitched grid, so every LOD can be re-derived. */
    this.grids = [];
  }

  get vertexCount() { return this.verts.length / FLOATS_PER_VERTEX; }

  push(v) {
    const a = this.verts;
    a.push(v.p[0], v.p[1], v.p[2]);
    a.push(v.n[0], v.n[1], v.n[2]);
    const bp = v.bp || v.p, bn = v.bn || v.n;
    a.push(bp[0], bp[1], bp[2]);
    a.push(bn[0], bn[1], bn[2]);
    const t = v.t || [1, 0, 0];
    a.push(t[0], t[1], t[2]);
    a.push(v.uv[0], v.uv[1]);
    a.push(v.axis ?? 0, v.stemHeight ?? 0, v.variant ?? 0);
    return a.length / FLOATS_PER_VERTEX - 1;
  }

  tri(a, b, c) { this.indices.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  /**
   * Stitch a (nu x nv) vertex grid, at every level of detail at once.
   *
   * Plant laminae are two-sided -- a petal seen from beneath must not vanish --
   * but that is a rasteriser state, not a geometry property: the pipelines do
   * not cull, and the fragment shaders flip the normal by `front_facing` for
   * transmission. Emitting each quad twice therefore doubles the triangle
   * count for no visible difference, so `doubleSided` defaults off and exists
   * only for the rare surface that genuinely needs duplicated winding.
   *
   * The coarser levels are index-only: they stitch every 2nd or every 4th row
   * and column of the SAME vertices. That is what makes LOD nearly free here.
   * Nothing is re-evaluated, nothing is re-uploaded, and because the coarse
   * mesh's vertices are a subset of the fine one's, the silhouette does not
   * shift when a plant changes tier -- it only loses smoothness, which is the
   * one thing the blur is already destroying.
   */
  grid(base, nu, nv, opts = {}) {
    this.grids.push({ base, nu, nv, doubleSided: opts.doubleSided === true,
                      dropAt: opts.dropAt ?? LOD_COUNT });
  }

  /** Emit one grid's triangles at a given row/column stride. */
  static stitch(out, { base, nu, nv, doubleSided }, stride) {
    // A stride that does not divide the grid would drop the last row, moving
    // the silhouette; back off to the largest stride that does.
    let s = stride;
    while (s > 1 && ((nu - 1) % s !== 0 || (nv - 1) % s !== 0)) s >>= 1;
    for (let i = 0; i + s < nu; i += s) {
      for (let j = 0; j + s < nv; j += s) {
        const a = base + i * nv + j;
        const b = base + (i + s) * nv + j;
        const c = b + s;
        const d = a + s;
        out.push(a, b, c, a, c, d);
        if (doubleSided) out.push(a, d, c, a, c, b);
      }
    }
  }

  /**
   * Pack the vertices once and the indices once per level of detail.
   *
   * `indices`/`indexCount`/`indexFormat` stay on the result as the finest
   * level, so anything that only ever wanted one mesh (the offline rasteriser,
   * the previews) is unaffected.
   */
  finish() {
    const vertexCount = this.vertexCount;
    const wide = vertexCount > 65535;
    const Ctor = wide ? Uint32Array : Uint16Array;
    const lods = [];
    for (let level = 0; level < LOD_COUNT; level++) {
      const out = [];
      for (const g of this.grids) {
        if (level >= g.dropAt) continue;
        MeshBuilder.stitch(out, g, 1 << level);
      }
      lods.push({ indices: new Ctor(out), indexCount: out.length,
                  indexFormat: wide ? 'uint32' : 'uint16' });
    }
    return {
      vertices: new Float32Array(this.verts),
      vertexCount,
      lods,
      indices: lods[0].indices,
      indexCount: lods[0].indexCount,
      indexFormat: lods[0].indexFormat,
    };
  }
}

// --- small vector helpers (plain arrays; these run once at load) ------------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function normalize(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Sample a parametric surface into a vertex grid, taking normals and tangents
 * from central differences. The petal surface stacks curl, cupping, twist,
 * vein ridges and margin noise; differentiating that analytically is a source
 * of bugs, and at these grid densities the numeric derivative is exact enough
 * that the difference never survives the normal map.
 */
export function sampleSurface(mb, fn, nu, nv, meta = {}) {
  const h = 1e-4;
  const base = mb.vertexCount;
  for (let i = 0; i < nu; i++) {
    const u = i / (nu - 1);
    for (let j = 0; j < nv; j++) {
      const v = j / (nv - 1);
      const p = fn(u, v);
      const du = sub(fn(Math.min(1, u + h), v), fn(Math.max(0, u - h), v));
      const dv = sub(fn(u, Math.min(1, v + h)), fn(u, Math.max(0, v - h)));
      let n = cross(du, dv);
      if (Math.hypot(n[0], n[1], n[2]) < 1e-12) n = [0, 1, 0];
      n = normalize(n);
      const t = normalize(du);
      let bud = meta.bud ? meta.bud(u, v) : null;
      let bn = n;
      if (bud) {
        const bdu = sub(meta.bud(Math.min(1, u + h), v), meta.bud(Math.max(0, u - h), v));
        const bdv = sub(meta.bud(u, Math.min(1, v + h)), meta.bud(u, Math.max(0, v - h)));
        let c = cross(bdu, bdv);
        bn = Math.hypot(c[0], c[1], c[2]) < 1e-12 ? n : normalize(c);
      }
      // Positions are stored as an OFFSET from the point on the stem the part
      // hangs off, not as an absolute height. Normals and tangents are taken
      // first, from the absolute surface, so subtracting a per-row offset
      // cannot flatten a derivative -- a stem tube is a ring at every u, and
      // differentiating its offset form along u gives nothing to build a
      // frame out of. Storing the offset is what lets one mesh serve plants of
      // different heights: the height only ever enters through the frame the
      // shader looks the attachment up in.
      if (meta.detach) {
        const d = meta.detach(u, v);
        p[0] -= d[0]; p[1] -= d[1]; p[2] -= d[2];
        if (bud) bud = [bud[0] - d[0], bud[1] - d[1], bud[2] - d[2]];
      }
      mb.push({
        p, n, t, bp: bud, bn,
        uv: meta.uv ? meta.uv(u, v) : [u, v],
        axis: meta.axis ? meta.axis(u, v) : u,
        stemHeight: meta.stemHeight ?? 1,
        variant: meta.variant ?? 0,
      });
    }
  }
  mb.grid(base, nu, nv, { doubleSided: meta.doubleSided === true, dropAt: meta.dropAt });
  return base;
}
