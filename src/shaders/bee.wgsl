//!include common.wgsl

// The bee, drawn now that the camera sits behind it.
//
// One draw, one small uniform, and no instancing: there is exactly one bee.
// The mesh (geom/bee.js) is built in the bee's own frame -- +Z forward, +Y up
// -- and this places it with the basis the flight model is already computing
// for the camera, so the body can never disagree with the view.
//
// It is shaded rather than textured, off two numbers carried in the vertex:
// `variant` says which part this is, and `axis` runs 0 at the waist to 1 at
// the sting so the abdominal stripes have a coordinate. Nothing here is
// pretending to be a photograph -- at 13mm the bee is inside the bokeh
// whenever the lens is focused on a flower, which is most of the time.

// Part ids as they arrive in the vertex, and the midpoints that separate
// them. Comparing against half of the NEXT id was the obvious thing to write
// and is wrong at every boundary: a wing carries exactly 1.0, and `part < 1.0`
// is false for it, so every wing in the mesh was shaded as a leg.
const WING_LO = 0.5;
const LEG_LO  = 1.5;
const EYE_LO  = 2.5;

/**
 * Where the bee is and which way it is pointing.
 *
 * A basis rather than a matrix: the flight model and the crawl both hand the
 * camera an orthonormal triple already (forward, up, and their cross), so
 * building a 4x4 here would only be a chance for the two to drift.
 */
struct BeeXform {
  origin : vec4f,   // xyz world position of the thorax, w = uniform scale
  right  : vec4f,   // xyz the bee's own +X
  up     : vec4f,   // xyz the bee's own +Y
  fwd    : vec4f,   // xyz the bee's own +Z, w = a per-frame stipple seed
}

@group(1) @binding(0) var<uniform> B : BeeXform;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,
  @location(1) nrm   : vec3f,
  @location(2) uv    : vec2f,
  @location(3) part  : f32,
  @location(4) along : f32,
  @location(5) viewZ : f32,
}

struct VIn {
  @location(0) pos    : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) budPos : vec3f,
  @location(3) budNrm : vec3f,
  @location(4) tan    : vec3f,
  @location(5) uv     : vec2f,
  @location(6) params : vec3f,   // axis (0 waist, 1 sting), unused, part id
}

fn toWorld(v: vec3f) -> vec3f {
  return B.right.xyz * v.x + B.up.xyz * v.y + B.fwd.xyz * v.z;
}

@vertex
fn vs(v: VIn) -> VOut {
  let s = B.origin.w;
  let world = B.origin.xyz + toWorld(v.pos * s);
  var o: VOut;
  o.world = world;
  // The basis is orthonormal and the scale uniform, so the normal takes the
  // same rotation as the position with nothing to correct for.
  o.nrm = normalize(toWorld(v.nrm));
  o.uv = v.uv;
  o.part = v.params.z;
  o.along = v.params.x;
  o.clip = G.viewProj * vec4f(world, 1.0);
  o.viewZ = -(G.view * vec4f(world, 1.0)).z;
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

  var albedo = vec3f(0.20, 0.14, 0.06);
  var rough = 0.75;
  var spec = 0.035;
  var fuzz = 0.0;

  if (i.part < WING_LO) {
    // Body. `along` is -1 on the thorax and head and 0..1 down the abdomen,
    // so one branch covers "fur" and "stripes" without a second part id.
    if (i.along < 0.0) {
      // Thorax and head: dense tawny pile, which is the furriest thing on the
      // animal and the reason a bee reads as soft rather than as a beetle.
      albedo = vec3f(0.235, 0.150, 0.052);
      fuzz = 1.0;
      rough = 0.92;
    } else {
      // Four dark tergites over amber. Sharpened toward the sting, because
      // the bands crowd together as the abdomen tapers.
      let band = 0.5 + 0.5 * cos(i.along * 25.0 - 0.6);
      let dark = smoothstep(0.42, 0.78, band);
      albedo = mix(vec3f(0.320, 0.185, 0.045), vec3f(0.045, 0.032, 0.022), dark);
      // The last segment is dark whatever the band says.
      albedo = mix(albedo, vec3f(0.040, 0.030, 0.020), smoothstep(0.82, 1.0, i.along));
      fuzz = 0.55 * (1.0 - smoothstep(0.25, 0.7, i.along));
      rough = mix(0.60, 0.85, fuzz);
      spec = 0.045;
    }
  } else if (i.part < LEG_LO) {
    // Wing. What the mesh carries is the ARC the wing beats through, not the
    // blade -- at a couple of hundred hertz there is no frame rate that could
    // draw the blade -- so it is stippled out to something like the coverage
    // a real one leaves on a photograph. A screen-space hash rather than
    // alpha blending: it needs no sort, no second pipeline and no depth
    // trickery, and everything downstream (defocus, bloom) turns the stipple
    // back into the smooth blur it is standing in for.
    let px = i.clip.xy + vec2f(B.fwd.w);
    let keep = 0.30 + 0.34 * (1.0 - smoothstep(0.15, 1.0, i.uv.y));
    if (hash21(floor(px)) > keep) { discard; }
    albedo = vec3f(0.62, 0.63, 0.66);
    rough = 0.22;
    spec = 0.070;
  } else if (i.part < EYE_LO) {
    // Legs and antennae: dark, hard chitin.
    albedo = vec3f(0.070, 0.050, 0.028);
    rough = 0.45;
    spec = 0.055;
  } else {
    // Compound eye: near black, and the one genuinely glossy thing on a bee.
    albedo = vec3f(0.028, 0.024, 0.026);
    rough = 0.16;
    spec = 0.090;
  }

  let shade = shadowFactor(i.world, ndl);

  // Fur scatters light well past the terminator and lifts hard at grazing
  // angles, which is the whole visual difference between a bumbling furry
  // insect and a lacquered model of one.
  let wrap = mix(0.10, 0.55, fuzz);
  let diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  var color = albedo * sun * diff * shade / PI;

  let D = distributionGGX(max(0.0, dot(N, H)), rough);
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  let F = fresnelSchlick(vec3f(spec), max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Rim: backlit pile glows, and a bee flying between the eye and the sun is
  // mostly a halo of it.
  let rim = pow(1.0 - ndv, 3.0) * fuzz;
  color += sun * shade * rim * albedo * 2.4 * max(0.0, 0.25 + 0.75 * dot(-V, L));

  color += albedo * skyAmbient(N);

  if (i32(G.plant.w + 0.5) == 7) { color = vec3f(0.95, 0.85, 0.20) * 0.6; }
  return vec4f(aerial(color, i.viewZ, -V, L), 1.0);
}
