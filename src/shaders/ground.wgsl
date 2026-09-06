//!include common.wgsl

// The ground the meadow stands in.
//
// A camera-centred radial grid with geometrically spaced rings: dense
// centimetre-scale cells right under the bee, metre-scale cells at the far
// side of the field, out to a horizon distance. The whole thing is generated
// from vertex_index -- there are no buffers -- because it is a flat plane and
// the only interesting thing about its geometry is how the tessellation is
// distributed.
//
// It exists for one reason the sky's ray-plane ground could not serve: DEPTH.
// The sky writes the far plane, so anything it drew was defocused as if it
// were twelve metres away, and at bee scale the ground is four centimetres
// away. A real surface with a real depth is what lets dof.wgsl give the turf
// under the bee the same shallow field as the flower it is looking at.

const RINGS   : u32 = 44u;
const SECTORS : u32 = 72u;
const R_INNER = 0.012;
const R_OUTER = 60.0;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,
  @location(1) dist  : f32,
  @location(2) viewZ : f32,
}

/** Geometric ring radii: constant angular size per ring from any eye height. */
fn ringRadius(k: f32) -> f32 {
  return R_INNER * pow(R_OUTER / R_INNER, k / f32(RINGS));
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let cell = vi / 6u;
  let corner = vi % 6u;
  let ring = cell / SECTORS;
  let sector = cell % SECTORS;

  // Two triangles per cell, as (0,0) (1,0) (0,1) / (0,1) (1,0) (1,1).
  let du = array<u32, 6>(0u, 1u, 0u, 0u, 1u, 1u);
  let dv = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let r = ringRadius(f32(ring + du[corner]));
  let a = f32(sector + dv[corner]) * (2.0 * PI / f32(SECTORS));

  // Anchored to the camera, so the fine rings are always underfoot. The
  // shading is a pure function of world position, so nothing swims: only the
  // tessellation moves, and a plane is exactly a plane at any density.
  let world = vec3f(G.cameraPos.x + cos(a) * r, 0.0, G.cameraPos.z + sin(a) * r);

  var o: VOut;
  o.world = world;
  o.dist = r;
  o.clip = G.viewProj * vec4f(world, 1.0);
  o.viewZ = -(G.view * vec4f(world, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let hab = habitatAt(i.world.xz);
  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);

  // Turf colour follows the habitat: damp hollows run lush and blue-green,
  // dry rises run olive and thin, and hard-grazed ground shows dead thatch and
  // bare soil between the tillers.
  let lush = vec3f(0.052, 0.108, 0.030);
  let dry  = vec3f(0.098, 0.104, 0.042);
  let soil = vec3f(0.085, 0.062, 0.040);
  var albedo = mix(dry, lush, smoothstep(0.25, 0.75, hab.r));
  albedo = mix(albedo, soil, clamp(hab.b * 0.55, 0.0, 0.5));

  // Sward texture. Two octaves, and only two: this covers the whole lower half
  // of the frame, so an octave here costs more than the entire flower field.
  // The high frequency is blade scale and is deliberately allowed to alias
  // into a wash beyond a few centimetres -- that IS what a lawn looks like
  // once it is smaller than the resolving limit, and the defocus pass finishes
  // the job.
  let fine = valueNoise3(vec3f(i.world.x * 210.0, 0.0, i.world.z * 210.0));
  let mid  = fbm3(vec3f(i.world.x * 17.0, 3.0, i.world.z * 17.0), 2);
  let detail = clamp(1.0 / (1.0 + i.dist * 14.0), 0.0, 1.0);
  albedo *= 0.72 + 0.56 * mix(mid, fine, detail);

  // Litter and thatch: the dead layer under any real sward.
  let litter = smoothstep(0.62, 0.86, mid) * (0.35 + 0.65 * hab.b);
  albedo = mix(albedo, vec3f(0.135, 0.098, 0.045), litter * 0.5);

  // A sward is a mat of near-vertical blades, so it is far darker than a flat
  // Lambertian surface of the same pigment: light that enters gets trapped.
  // Tilting the shading normal is the cheap stand-in for that, and it is why
  // grass fields do not read as flat green paper. One hash rather than a noise
  // sum -- at this frequency the difference is below a pixel anyway.
  let jitter = hash33(vec3f(floor(i.world.xz * 30.0), 7.0)) - vec3f(0.5);
  let N = normalize(vec3f(jitter.x * 0.55, 1.0, jitter.z * 0.55));
  let ndl = max(0.0, dot(N, L));
  let shade = shadowFactor(i.world, dot(N, L));
  var color = albedo * G.sunColor.rgb * G.sunColor.w * ndl * shade / PI;
  color += albedo * skyAmbient(N) * mix(0.55, 1.0, smoothstep(0.0, 0.5, hab.r));

  return vec4f(aerial(color, i.viewZ, -V, L), 1.0);
}
