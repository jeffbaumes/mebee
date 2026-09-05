//!include common.wgsl

// Airborne pollen and dust motes. No collision, no readback -- they exist to
// catch the sun and, once defocused, to become the bokeh discs that read as
// macro photography more than any amount of geometry does.

struct Mote {
  pos  : vec4f,   // xyz, w = size
  vel  : vec4f,   // xyz, w = seed
}

// Read-only view of the mote buffer. WebGPU forbids a writable storage
// buffer in the vertex stage, so the simulation and the draw cannot share
// one module -- they would have to agree on an access mode that is illegal
// for one of them.
@group(1) @binding(0) var<storage, read> motes : array<Mote>;

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
