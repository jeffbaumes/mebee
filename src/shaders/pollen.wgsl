//!include common.wgsl

// Airborne pollen and dust motes. No collision, no readback -- they exist to
// catch the sun and, once defocused, to become the bokeh discs that read as
// macro photography more than any amount of geometry does.

struct Mote {
  pos  : vec4f,   // xyz, w = size
  vel  : vec4f,   // xyz, w = seed
}

@group(1) @binding(0) var<storage, read_write> motes : array<Mote>;

const BOUNDS_LO = vec3f(-0.22, 0.0,  -0.22);
const BOUNDS_HI = vec3f( 0.22, 0.62,  0.22);

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
  if (any(p < BOUNDS_LO) || any(p > BOUNDS_HI)) {
    let r = hash33(vec3f(f32(i), G.windParams.y, m.vel.w));
    m.pos = vec4f(mix(BOUNDS_LO, BOUNDS_HI, r), m.pos.w);
  }
  motes[i] = m;
}

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) local : vec2f,
  @location(1) glow  : f32,
  @location(2) viewZ : f32,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let m = motes[ii];
  let corner = array(vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0),
                     vec2f(-1.0, 1.0), vec2f(1.0,-1.0), vec2f( 1.0,1.0));
  let c = corner[vi];

  let toCam = G.cameraPos.xyz - m.pos.xyz;
  let dist = length(toCam);
  let fwd = toCam / max(1e-5, dist);
  var upRef = vec3f(0.0, 1.0, 0.0);
  if (abs(fwd.y) > 0.95) { upRef = vec3f(1.0, 0.0, 0.0); }
  let right = normalize(cross(upRef, fwd));
  let up = cross(fwd, right);

  // Hold a floor of about two pixels: a mote smaller than a pixel just
  // aliases into flicker instead of resolving into a highlight.
  let pxWorld = 2.0 * G.cameraPos.w * dist / G.screen.y;
  let size = max(m.pos.w, pxWorld * 1.1);
  let world = m.pos.xyz + (right * c.x + up * c.y) * size;

  var o: VOut;
  o.local = c;
  o.glow = fract(m.vel.w * 7.31);
  o.clip = G.viewProj * vec4f(world, 1.0);
  o.viewZ = -(G.view * vec4f(world, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let r = length(i.local);
  if (r > 1.0) { discard; }
  // Soft-edged, forward-scattering: a dust mote lit from behind is far
  // brighter than one lit from the front.
  let alpha = pow(1.0 - r, 1.6);
  let sun = G.sunColor.rgb * G.sunColor.w;
  let tint = mix(vec3f(0.95, 0.88, 0.66), vec3f(0.80, 0.85, 1.0), i.glow);
  return vec4f(sun * tint * alpha * (0.35 + 0.9 * i.glow), alpha);
}
