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

export class MeshBuilder {
  constructor() {
    this.verts = [];
    this.indices = [];
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
   * Stitch a (nu x nv) vertex grid.
   *
   * Plant laminae are two-sided -- a petal seen from beneath must not vanish --
   * but that is a rasteriser state, not a geometry property: the pipelines do
   * not cull, and the fragment shaders flip the normal by `front_facing` for
   * transmission. Emitting each quad twice therefore doubles the triangle
   * count for no visible difference, so `doubleSided` defaults off and exists
   * only for the rare surface that genuinely needs duplicated winding.
   */
  gridIndices(base, nu, nv, doubleSided = false) {
    for (let i = 0; i < nu - 1; i++) {
      for (let j = 0; j < nv - 1; j++) {
        const a = base + i * nv + j, b = a + nv, c = b + 1, d = a + 1;
        this.quad(a, b, c, d);
        if (doubleSided) this.quad(a, d, c, b);
      }
    }
  }

  finish() {
    const vertexCount = this.vertexCount;
    return {
      vertices: new Float32Array(this.verts),
      indices: vertexCount > 65535
        ? new Uint32Array(this.indices)
        : new Uint16Array(this.indices),
      indexFormat: vertexCount > 65535 ? 'uint32' : 'uint16',
      vertexCount,
      indexCount: this.indices.length,
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
      const bud = meta.bud ? meta.bud(u, v) : null;
      let bn = n;
      if (bud) {
        const bdu = sub(meta.bud(Math.min(1, u + h), v), meta.bud(Math.max(0, u - h), v));
        const bdv = sub(meta.bud(u, Math.min(1, v + h)), meta.bud(u, Math.max(0, v - h)));
        let c = cross(bdu, bdv);
        bn = Math.hypot(c[0], c[1], c[2]) < 1e-12 ? n : normalize(c);
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
  mb.gridIndices(base, nu, nv, meta.doubleSided === true);
  return base;
}
