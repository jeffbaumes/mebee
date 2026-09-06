//!include common.wgsl

// Airborne pollen and dust motes. No collision, no readback -- they exist to
// catch the sun and, once defocused, to become the bokeh discs that read as
// macro photography more than any amount of geometry does.

struct Mote {
  pos  : vec4f,   // xyz, w = size
  vel  : vec4f,   // xyz, w = seed
}

@group(1) @binding(0) var<storage, read_write> motes : array<Mote>;

// Motes are recycled through a box that FOLLOWS the camera rather than through
// a fixed volume. Over a field several metres across, a fixed box would put
// every mote somewhere the bee is not; a box that travels keeps the density
// constant wherever it flies, for the same six thousand particles.
const MOTE_BOX = vec3f(0.55, 0.34, 0.55);

fn moteBounds() -> array<vec3f, 2> {
  let c = vec3f(G.cameraPos.x, max(MOTE_BOX.y * 0.55, G.cameraPos.y), G.cameraPos.z);
  return array<vec3f, 2>(vec3f(c.x - MOTE_BOX.x, max(0.0, c.y - MOTE_BOX.y), c.z - MOTE_BOX.z),
                         vec3f(c.x + MOTE_BOX.x, c.y + MOTE_BOX.y, c.z + MOTE_BOX.z));
}

fn windAtSimple(p: vec3f, t: f32) -> vec3f {
  let dir = normalize(vec3f(G.windParams.z, 0.0, G.windParams.w) + vec3f(1e-5, 0.0, 0.0));
  let phase = dot(p, dir) * 1.35 - t * 2.1;
  let gust = pow(0.5 + 0.5 * sin(phase), 3.0);
  let turb = vec3f(
    fbm3(p * 9.0 + vec3f(t * 1.1, 0.0, 0.0), 2),
    fbm3(p * 9.0 + vec3f(0.0, t * 0.9, 7.0), 2),
    fbm3(p * 9.0 + vec3f(0.0, 0.0, t * 1.3 + 19.0), 2),
  ) - vec3f(0.5);
  return dir * G.windParams.x * (0.25 + 1.5 * gust) + turb * G.windParams.x * 1.2;
}

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= arrayLength(&motes)) { return; }
  var m = motes[i];
  let dt = clamp(G.state.w, 1.0 / 240.0, 1.0 / 30.0);

  let w = windAtSimple(m.pos.xyz, G.windParams.y);
  // Stokes drag dominates at this size: a mote follows the air almost exactly,
  // with a slow settling velocity. It never ballistics like a big particle.
  let settle = vec3f(0.0, -0.020 - 0.03 * fract(m.vel.w), 0.0);
  m.vel = vec4f(mix(m.vel.xyz, w + settle, 1.0 - exp(-6.0 * dt)), m.vel.w);
  m.pos = vec4f(m.pos.xyz + m.vel.xyz * dt, m.pos.w);

  // Recycle through the volume so density stays constant.
  let p = m.pos.xyz;
  let bounds = moteBounds();
  if (any(p < bounds[0]) || any(p > bounds[1])) {
    let r = hash33(vec3f(f32(i), G.windParams.y, m.vel.w));
    m.pos = vec4f(mix(bounds[0], bounds[1], r), m.pos.w);
  }
  motes[i] = m;
}
