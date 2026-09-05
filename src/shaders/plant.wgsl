//!include skin.wgsl

// Main surface shader for every lamina and stem in the plant.
//
// The realism here is carried by three things, in order of importance:
//   1. transmission -- these are thin backlit membranes, not opaque solids;
//   2. a sky-filled ambient term, so shadow never crushes to black;
//   3. anisotropic specular aligned to the vein grain, which is what makes a
//      leaf's sheen sweep as the view moves instead of sitting still.

const KIND_PETAL      = 0.0;
const KIND_LEAF       = 1.0;
const KIND_STEM       = 2.0;
const KIND_RECEPTACLE = 3.0;

struct Material {
  albedo      : vec4f,   // rgb base colour, w = alpha cutoff
  transmit    : vec4f,   // rgb transmission tint, w = thickness scale
  surface     : vec4f,   // roughness, anisotropy, specular f0, sheen
  flags       : vec4f,   // kind, veinStrength, mottleStrength, unused
}

@group(1) @binding(1) var veinMap   : texture_2d<f32>;
@group(1) @binding(2) var detailMap : texture_2d<f32>;
@group(2) @binding(0) var<uniform> M : Material;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world  : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) tan    : vec3f,
  @location(3) uv     : vec2f,
  @location(4) params : vec3f,   // axis, stemHeight, variant
  @location(5) viewZ  : f32,
}

struct VIn {
  @location(0) pos     : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) budPos  : vec3f,
  @location(3) budNrm  : vec3f,
  @location(4) tan     : vec3f,
  @location(5) uv      : vec2f,
  @location(6) params  : vec3f,
}

@vertex
fn vs(v: VIn) -> VOut {
  // Blooming is a straight morph between the two states baked into the vertex.
  let bloom = G.state.x;
  let rest    = mix(v.budPos, v.pos, bloom);
  let restNrm = normalize(mix(v.budNrm, v.nrm, bloom));

  let s = skinToStem(rest, restNrm, v.tan, v.params.y, v.params.x,
                     G.plant.x, v.params.z);

  var o: VOut;
  o.world = s.pos;
  o.nrm = s.nrm;
  o.tan = s.tan;
  o.uv = v.uv;
  o.params = v.params;
  o.clip = G.viewProj * vec4f(s.pos, 1.0);
  o.viewZ = -(G.view * vec4f(s.pos, 1.0)).z;
  return o;
}

/** Procedural longitudinal ribs for petals, which carry no baked texture. */
fn petalVeins(uv: vec2f, variant: f32) -> vec2f {
  let n = 4.0 + floor(variant * 3.0);
  let x = uv.x * n;
  let rib = abs(fract(x) - 0.5) * 2.0;
  let profile = pow(1.0 - rib, 3.0);
  // Ribs flatten out toward the tip as the strap thins.
  let fade = 1.0 - 0.6 * uv.y;
  return vec2f(profile * fade, (fract(x) - 0.5));
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  let kind = M.flags.x;

  // Sample everything up front: texture sampling with automatic derivatives
  // must sit in uniform control flow, and the leaf discards below.
  let vein   = textureSample(veinMap, linearSamp, i.uv);
  let detail = textureSample(detailMap, linearSamp, i.uv);
  let texel  = 1.0 / vec2f(textureDimensions(veinMap));
  let ridgeL = textureSample(veinMap, linearSamp, i.uv - vec2f(texel.x, 0.0)).r;
  let ridgeR = textureSample(veinMap, linearSamp, i.uv + vec2f(texel.x, 0.0)).r;
  let ridgeD = textureSample(veinMap, linearSamp, i.uv - vec2f(0.0, texel.y)).r;
  let ridgeU = textureSample(veinMap, linearSamp, i.uv + vec2f(0.0, texel.y)).r;

  let isLeaf = kind == KIND_LEAF;
  if (isLeaf && vein.a < M.albedo.w) { discard; }

  // --- surface frame ------------------------------------------------------
  var N = normalize(i.nrm);
  if (!facing) { N = -N; }
  var T = normalize(i.tan - N * dot(i.tan, N));
  var B = cross(N, T);

  // --- normal perturbation, thickness, grain ------------------------------
  var thickness = 1.0;
  var grain = T;
  var ao = 1.0;
  var bump = vec2f(0.0);

  if (isLeaf) {
    bump = vec2f(ridgeR - ridgeL, ridgeU - ridgeD) * M.flags.y;
    // Veins are opaque ribs; the lamina between them is what glows.
    thickness = (1.0 - vein.g * 0.92) * M.transmit.w;
    ao = detail.a;
    let a = vein.b * PI;
    grain = normalize(T * cos(a) + B * sin(a));
  } else if (kind == KIND_PETAL) {
    let pv = petalVeins(i.uv, i.params.z);
    bump = vec2f(pv.y * pv.x * 2.2, 0.0) * M.flags.y;
    thickness = (1.0 - pv.x * 0.55) * M.transmit.w;
    grain = normalize(B);      // ribs run along the strap
  } else {
    // Stem and receptacle: fine longitudinal fluting.
    let f = sin(i.uv.x * 2.0 * PI * 3.0);
    bump = vec2f(f * 0.35, 0.0) * M.flags.y;
    thickness = 0.10 * M.transmit.w;
  }
  N = normalize(N - (T * bump.x + B * bump.y));
  B = cross(N, T);

  // --- albedo -------------------------------------------------------------
  var albedo = M.albedo.rgb;
  let mottle = fbm3(vec3f(i.uv * 22.0, i.params.z * 17.0), 3);
  albedo *= 1.0 - M.flags.z * (0.5 - mottle);

  if (isLeaf) {
    albedo = mix(albedo, albedo * vec3f(1.28, 1.16, 0.72), vein.r * 0.55);
    // Necrosis: dead margin tissue, which every real leaf has some of.
    albedo = mix(albedo, vec3f(0.29, 0.16, 0.055), detail.b);
    albedo *= ao;
  } else if (kind == KIND_PETAL) {
    // Nectar guide: ray florets darken and warm toward the disc. Bees track
    // exactly this gradient in, and it is strongly UV-patterned in reality.
    let guide = pow(1.0 - i.uv.y, 2.6);
    albedo = mix(albedo, M.albedo.rgb * vec3f(1.05, 0.62, 0.30), guide * 0.85);
    // Papery edge: the very margin of a ray floret is thin and desaturated.
    let edge = pow(abs(i.uv.x - 0.5) * 2.0, 5.0);
    albedo = mix(albedo, albedo * 1.15 + vec3f(0.06), edge * 0.5);
  }

  // --- lighting -----------------------------------------------------------
  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);
  let H = normalize(L + V);
  let ndl = dot(N, L);
  let ndv = max(1e-4, dot(N, V));
  let sun = G.sunColor.rgb * G.sunColor.w;

  let shade = shadowFactor(i.world, ndl);
  var color = vec3f(0.0);

  // Diffuse. Wrapped slightly: thin waxy tissue scatters a little past the
  // terminator, and a hard Lambert edge reads as plastic.
  let wrap = 0.18;
  let diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  // Lambert: albedo/pi * E * cos. No fudge factor -- with the ambient term
  // below now correctly scaled, the sun-to-sky ratio falls out of the physics
  // rather than being dialled in, and exposure is the only knob left.
  color += albedo * sun * diff * shade / PI;

  // Specular. Leaves get anisotropic GGX along the vein grain; everything else
  // is isotropic. The cuticle is a dielectric, so f0 stays low.
  let rough = M.surface.x;
  let f0 = vec3f(M.surface.z);
  let ndh = max(0.0, dot(N, H));
  var D: f32;
  if (isLeaf && M.surface.y > 0.01) {
    let aniso = M.surface.y;
    let ax = max(0.008, rough * rough * (1.0 + aniso));
    let ay = max(0.008, rough * rough * (1.0 - aniso));
    D = distributionGGXAniso(H, N, grain, cross(N, grain), ax, ay);
  } else {
    D = distributionGGX(ndh, rough);
  }
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  let F = fresnelSchlick(f0, max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Transmission -- the reason this reads as a living plant. Per-channel
  // absorption: light crossing pink tissue emerges deeper red, green tissue
  // emerges yellow-green, because the pigment eats the other wavelengths.
  let trans = translucency(L, V, N, thickness, 3.2, 0.28);
  let absorb = exp(-(1.0 - M.transmit.rgb) * (1.0 + (1.0 - thickness) * 2.5));
  // Shadowed transmission still needs the sun term: light comes *through* the
  // leaf, so use a softened shadow rather than the receiver's own occlusion.
  color += sun * trans * absorb * albedo * 2.4 * mix(0.35, 1.0, shade);

  // Sky ambient, plus a bounce term from below.
  let ambient = skyAmbient(N);
  let bounce = skyAmbient(-N) * 0.22 * vec3f(0.55, 0.62, 0.38);
  color += albedo * (ambient + bounce) * ao;

  // Sheen: the waxy cuticle brightens hard at grazing angles.
  let sheen = pow(1.0 - ndv, 4.5) * M.surface.w;
  color += sheen * ambient * 0.5;

  return vec4f(color, 1.0);
}
