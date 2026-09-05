// Tiny z-buffered software rasteriser. Existing purely so procedural geometry
// can be eyeballed offline, without a GPU. Not part of the runtime.
import { FLOATS_PER_VERTEX as V } from '../src/geom/mesh.js';

export function render({ meshes, width = 720, height = 720, eye, target, up = [0, 1, 0],
                         fovDeg = 34, sun = [0.4, 0.75, 0.35], bg = [0.10, 0.12, 0.15] }) {
  const color = new Float32Array(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);
  for (let i = 0; i < width * height; i++) {
    color[i * 3] = bg[0]; color[i * 3 + 1] = bg[1]; color[i * 3 + 2] = bg[2];
  }

  const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
  const sb = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cr = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dt = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

  const zAxis = norm(sb(eye, target));
  const xAxis = norm(cr(up, zAxis));
  const yAxis = cr(zAxis, xAxis);
  const view = (p) => {
    const d = sb(p, eye);
    return [dt(d, xAxis), dt(d, yAxis), -dt(d, zAxis)];   // -z forward
  };
  const f = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
  const aspect = width / height;
  const project = (v) => {
    const z = Math.max(1e-6, v[2]);
    return [(v[0] * f / aspect / z * 0.5 + 0.5) * width,
            (1 - (v[1] * f / z * 0.5 + 0.5)) * height, z];
  };
  const L = norm(sun);

  for (const m of meshes) {
    const { mesh, albedo = [0.3, 0.5, 0.2], translucency = 0, xform = (p) => p } = m;
    const vt = mesh.vertices, idx = mesh.indices;
    const n = mesh.vertexCount;
    const P = new Array(n), N = new Array(n), S = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * V;
      P[i] = xform([vt[o], vt[o + 1], vt[o + 2]]);
      N[i] = [vt[o + 3], vt[o + 4], vt[o + 5]];
      S[i] = project(view(P[i]));
    }
    for (let t = 0; t < idx.length; t += 3) {
      const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
      const a = S[ia], b = S[ib], c = S[ic];
      if (a[2] <= 0 || b[2] <= 0 || c[2] <= 0) continue;
      const area = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          let w0 = ((b[0]-a[0])*(py-a[1]) - (b[1]-a[1])*(px-a[0])) / area;
          let w1 = ((c[0]-b[0])*(py-b[1]) - (c[1]-b[1])*(px-b[0])) / area;
          let w2 = 1 - w0 - w1;
          // w0 weights c, w1 weights a, w2 weights b
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w1 * a[2] + w2 * b[2] + w0 * c[2];
          const k = y * width + x;
          if (z >= depth[k]) continue;
          depth[k] = z;
          let nx = w1*N[ia][0] + w2*N[ib][0] + w0*N[ic][0];
          let ny = w1*N[ia][1] + w2*N[ib][1] + w0*N[ic][1];
          let nz = w1*N[ia][2] + w2*N[ib][2] + w0*N[ic][2];
          const nl = Math.hypot(nx, ny, nz) || 1; nx/=nl; ny/=nl; nz/=nl;
          const ndl = nx*L[0] + ny*L[1] + nz*L[2];
          const diff = Math.max(0, ndl);
          // Crude two-sided translucency so backlit laminae read correctly.
          const trans = translucency * Math.max(0, -ndl) * 0.9;
          const sky = 0.30 + 0.22 * (ny * 0.5 + 0.5);
          for (let ch = 0; ch < 3; ch++) {
            color[k*3+ch] = albedo[ch] * (diff * 1.15 + sky) + trans * albedo[ch] * 1.8;
          }
        }
      }
    }
  }

  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let ch = 0; ch < 3; ch++) {
      let v = color[i*3+ch];
      v = v / (1 + v);                       // Reinhard, just to keep it sane
      out[i*4+ch] = Math.round(255 * Math.pow(Math.min(1, Math.max(0, v)), 1/2.2));
    }
    out[i*4+3] = 255;
  }
  return out;
}
