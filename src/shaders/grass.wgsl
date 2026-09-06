//!include common.wgsl

// Instanced grass. One unit blade, placed, scaled and bent per instance.
//
// The bend comes from the same windAt() the stem solver and the petals use, so
// a gust that leans the flower leans the grass under it. Nothing here is a
// separate animation -- it is the same field, sampled at a different point.

struct GrassInstance {
  posHeight : vec4f,   // xyz base position, w = height in metres
  orient    : vec4f,   // x = cos(yaw), y = sin(yaw), z = width, w = variant
}

@group(1) @binding(0) var<storage, read> blades : array<GrassInstance>;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world   : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) uv      : vec2f,
  @location(3) variant : f32,
  @location(4) sway    : f32,
}

struct VIn {
  @location(0) pos    : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) budPos : vec3f,
  @location(3) budNrm : vec3f,
  @location(4) tan    : vec3f,
  @location(5) uv     : vec2f,
  @location(6) params : vec3f,   // axis (0 at root, 1 at tip), stemHeight, variant
}

/** Rodrigues rotation of `p` about a unit `axis`. */
fn rotateAxis(p: vec3f, axis: vec3f, ang: f32) -> vec3f {
  let c = cos(ang);
  let s = sin(ang);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let inst = blades[ii];
  let base = inst.posHeight.xyz;
  let height = max(1e-5, inst.posHeight.w);
  let cs = inst.orient.x;
  let sn = inst.orient.y;
  let width = max(1e-6, inst.orient.z);
  let variant = inst.orient.w;

  // Non-uniform scale, so the normal takes the inverse scale before it is
  // renormalised -- scaling a blade thin and tall otherwise tips its normals
  // toward the long axis and the whole field lights wrongly.
  var p = vec3f(v.pos.x * height, v.pos.y * height, v.pos.z * width);
  var n = normalize(vec3f(v.nrm.x / height, v.nrm.y / height, v.nrm.z / width));

  // Yaw about the vertical.
  p = vec3f(p.x * cs - p.z * sn, p.y, p.x * sn + p.z * cs);
  n = vec3f(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs);

  let t = G.windParams.y;
  let wind = windAt(base, t);
  let speed = length(wind);
  var sway = 0.0;

  if (speed > 1e-5) {
    let flat = vec3f(wind.x, 0.0, wind.z);
    let wdir = normalize(flat + vec3f(1e-6, 0.0, 0.0));
    // Bend about the horizontal axis square to the wind, so the blade lies
    // over downwind rather than twisting.
    let axis = normalize(cross(vec3f(0.0, 1.0, 0.0), wdir));
    // Cantilever: a blade clamped at the root bends with the square of the
    // distance along it, which is why grass curls over at the tip and stays
    // stiff at the base.
    let u = v.params.x;
    // Subtracting the projection of the base position onto the wind gives the
    // travelling phase, so gusts visibly cross the field instead of every
    // blade beating together.
    let phase = t * 7.0 - dot(base, wdir) * 9.0 + variant * 6.283;
    // Clamped: at the top of the wind slider the raw bend reaches about a
    // hundred degrees and lays the sward flat through itself.
    let ang = clamp(speed * 0.55 + sin(phase) * speed * 0.22, -1.1, 1.1) * u * u;
    sway = ang;
    p = rotateAxis(p, axis, ang);
    n = rotateAxis(n, axis, ang);
  }

  let world = base + p;
  var o: VOut;
  o.world = world;
  o.nrm = n;
  o.uv = v.uv;
  o.variant = variant;
  o.sway = sway;
  o.clip = G.viewProj * vec4f(world, 1.0);
  return o;
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  var N = normalize(i.nrm);
  if (!facing) { N = -N; }

  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);
  let H = normalize(L + V);
  let ndl = dot(N, L);
  let ndv = max(1e-4, dot(N, V));
  let sun = G.sunColor.rgb * G.sunColor.w;

  // Per-blade colour variation, and a darker, yellower base where light does
  // not reach into the sward.
  let tint = fract(i.variant * 7.31);
  var albedo = mix(vec3f(0.055, 0.115, 0.028), vec3f(0.105, 0.165, 0.042), tint);
  albedo = mix(albedo * vec3f(0.72, 0.78, 0.55), albedo, smoothstep(0.0, 0.45, i.uv.y));
  // Tips dry out and pale off.
  albedo = mix(albedo, vec3f(0.20, 0.19, 0.085), smoothstep(0.80, 1.0, i.uv.y) * 0.5);

  let shade = shadowFactor(i.world, ndl);

  let wrap = 0.25;
  let diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  var color = albedo * sun * diff * shade / PI;

  // A blade is a thin membrane like any other lamina: backlit grass glows,
  // and at low sun that glow is most of what you see of a field.
  let thickness = 0.85 - 0.35 * smoothstep(0.0, 0.5, i.uv.y);
  let trans = translucency(L, V, N, thickness, 3.0, 0.30);
  color += sun * trans * vec3f(0.42, 0.68, 0.20) * albedo * 3.2 * mix(0.4, 1.0, shade);

  // The keel gives each blade one hard specular line down its length.
  let rough = 0.30;
  let D = distributionGGX(max(0.0, dot(N, H)), rough);
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  let F = fresnelSchlick(vec3f(0.045), max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Ambient, with a crude vertical occlusion: the base of the sward is buried.
  let occlusion = mix(0.35, 1.0, smoothstep(0.0, 0.55, i.uv.y));
  color += albedo * skyAmbient(N) * occlusion;

  return vec4f(color, 1.0);
}
