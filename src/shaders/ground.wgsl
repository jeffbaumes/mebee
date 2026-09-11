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

  // Sward texture. The high frequency is blade scale and is deliberately
  // allowed to alias into a wash beyond a few centimetres -- that IS what a
  // lawn looks like once it is smaller than the resolving limit, and the
  // defocus pass finishes the job.
  //
  // Both lattices are turned off the world axes before they are sampled.
  // Value noise is built on an axis-aligned grid and its gradient vanishes at
  // every lattice point, so sampled square-on over a flat plane the cells read
  // as a literal checkerboard -- which is exactly what the ground was showing
  // once the sward stopped hiding it. The turn costs two multiplies and leaves
  // the cells crossing the view at an angle, where they read as mottling.
  let rot = mat2x2f(0.8763, -0.4818, 0.4818, 0.8763);   // ~28 degrees
  let q = rot * i.world.xz;
  // Three octaves rather than two, and the contrast well under what it was.
  // Beyond half a metre `detail` has faded the blade-scale octave out
  // entirely, so this is the only thing left carrying the texture -- and one
  // dominant cell size at +/-28% reads as patches of ground laid out on a
  // grid rather than as mottling in it.
  let mid  = fbm2(q * 26.0, 3);
  let detail = clamp(1.0 / (1.0 + i.dist * 14.0), 0.0, 1.0);
  // The blade-scale octave is gone past about fifteen centimetres, and the
  // ground past fifteen centimetres is most of the frame. Reading it anyway
  // and then multiplying it by a zero `detail` cost a lattice fetch over every
  // pixel of the field for a contribution of nothing.
  var fine = 0.0;
  if (detail > 0.004) { fine = valueNoise2(q * 210.0); }
  albedo *= 0.82 + 0.36 * mix(mid, fine, detail);

  // Litter and thatch: the dead layer under any real sward. Softened at both
  // ends for the same reason -- a tight threshold on a noise field turns its
  // cells into hard-edged blotches, and on the bare, hard-grazed ground where
  // this term is strongest there is no sward left to hide them.
  let litter = smoothstep(0.48, 1.0, mid) * (0.35 + 0.65 * hab.b);
  albedo = mix(albedo, vec3f(0.135, 0.098, 0.045), litter * 0.32);

  // A sward is a mat of near-vertical blades, so it is far darker than a flat
  // Lambertian surface of the same pigment: light that enters gets trapped.
  // Tilting the shading normal is the cheap stand-in for that, and it is why
  // a grass field does not read as flat green paper.
  //
  // It is a stand-in for blades that are NOT DRAWN, so it fades in on exactly
  // the schedule the real ones fade out. grass.wgsl lays blades over the first
  // metre or so and thins them by the lens past that; inside the first metre
  // this term is both redundant and ruinous, because a thirty-degree swing of
  // the normal at one spatial frequency under a low sun is not a sward, it is
  // a chequerboard of light and dark cells -- and at bee height those cells
  // are a centimetre across rather than the sub-pixel they were designed as.
  // (Interpolated noise rather than the per-cell hash it used to be, which had
  // the same problem twice as badly: constant normal per cell, hard edges.)
  //
  // The other half of that bargain is that inside 35cm the amplitude is zero,
  // so the two noise fetches are skipped there entirely -- and inside 35cm is
  // exactly where the near ground fills the frame.
  let tiltAmp = 0.55 * smoothstep(0.35, 1.6, i.dist);
  var tilt = vec2f(0.0);
  if (tiltAmp > 0.002) {
    // The two components sample the lattice through a quarter turn from each
    // other, not merely at a translated origin: value noise is periodic in its
    // own grid, so two offsets of the same field give one field and a copy of
    // it, and a normal built from those tilts along one diagonal everywhere.
    // (The 3D form this replaced got the same thing for free by taking two
    // different z-planes.)
    let qa = q * 95.0 + vec2f(11.3, 4.7);
    let qb = vec2f(-q.y, q.x) * 95.0 + vec2f(23.9, 61.1);
    tilt = (vec2f(valueNoise2(qa), valueNoise2(qb)) - 0.5) * 2.0;
  }
  let N = normalize(vec3f(tilt.x * tiltAmp, 1.0, tilt.y * tiltAmp));
  let ndl = max(0.0, dot(N, L));
  let shade = shadowFactor(i.world, dot(N, L));
  var color = albedo * G.sunColor.rgb * G.sunColor.w * ndl * shade / PI;
  color += albedo * skyAmbient(N) * mix(0.55, 1.0, smoothstep(0.0, 0.5, hab.r));

  return vec4f(aerial(landingMark(color, i.world), i.viewZ, -V, L), 1.0);
}
