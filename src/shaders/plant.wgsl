//!include scene.wgsl

// Main surface shader for every lamina and stem in the field.
//
// The realism here is carried by three things, in order of importance:
//   1. transmission -- these are thin backlit membranes, not opaque solids;
//   2. a sky-filled ambient term, so shadow never crushes to black;
//   3. anisotropic specular aligned to the vein grain, which is what makes a
//      leaf's sheen sweep as the view moves instead of sitting still.
//
// Colour is per plant, not per material: the material uniform now carries only
// what is true of a KIND of tissue (how rough a cuticle is, how strongly it
// scatters, whether it has veins), and the pigment loading comes off the
// instance. That is what lets one draw cover a whole drift of one species
// while still varying between individuals.
//
// Everything procedural fades with `sharp`, the resolvable-detail number
// render/lod.js computes by dividing projected size by the circle of
// confusion. Below about a pixel of blur nothing is lost; well inside the
// bokeh, the ribs, mottle and pollen sparkle are gone -- not because they are
// far away, but because the lens has already erased them.

const KIND_PETAL      = 0.0;
const KIND_LEAF       = 1.0;
const KIND_STEM       = 2.0;
const KIND_RECEPTACLE = 3.0;

struct Material {
  albedo      : vec4f,   // rgb fallback base colour, w = alpha cutoff
  transmit    : vec4f,   // rgb fallback transmission tint, w = thickness scale
  surface     : vec4f,   // roughness, anisotropy, specular f0, sheen
  flags       : vec4f,   // kind, veinStrength, mottleStrength, unused
}

@group(2) @binding(0) var<uniform> M : Material;
@group(2) @binding(1) var veinMap   : texture_2d<f32>;
@group(2) @binding(2) var detailMap : texture_2d<f32>;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world  : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) tan    : vec3f,
  @location(3) uv     : vec2f,
  @location(4) params : vec3f,   // axis, stemHeight, variant
  @location(5) @interpolate(flat) vid : u32,
  @location(6) viewZ  : f32,
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

/** Bloom and maturation: the plant's own phase, nudged by the panel. */
fn plantBloom(P: PlantInstance) -> f32 { return clamp(P.phase.x * G.state.x, 0.0, 1.0); }
fn plantFront(P: PlantInstance) -> f32 { return clamp(P.phase.y + G.state.y, 0.0, 1.0); }

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let vis = visible[ii];
  let P = plants[vis.plant];

  // Blooming is a straight morph between the two states baked into the vertex.
  let bloom = plantBloom(P);
  let rest    = mix(v.budPos, v.pos, bloom);
  let restNrm = normalize(mix(v.budNrm, v.nrm, bloom));

  let s = skinToPlant(P, vis.plant, rest, restNrm, v.tan,
                      v.params.y, v.params.x, v.params.z);

  var o: VOut;
  o.world = s.pos;
  o.nrm = s.nrm;
  o.tan = s.tan;
  o.uv = v.uv;
  o.params = v.params;
  o.vid = ii;
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

/**
 * The disc, drawn on the receptacle instead of with geometry.
 *
 * At the finest tier the capitulum is several hundred instanced florets. One
 * tier coarser they are gone, and this stands in: the SAME golden-angle
 * lattice, expressed as the interference of its two dominant Fibonacci
 * parastichy families rather than as points. For family F the spiral arms
 * satisfy F*theta - k*n = const, where k is 2*pi times the fractional part of
 * F/phi -- tiny for a Fibonacci F, which is exactly why those families and no
 * others show up as visible spirals on a real sunflower.
 *
 * Returns the floret-scale height field in x and the anther mask in y.
 */
fn discPattern(rn: f32, theta: f32, floretCount: f32) -> vec2f {
  let n = rn * rn * floretCount;
  let s21 = cos(21.0 * theta - 0.13383 * n);
  let s34 = cos(34.0 * theta + 0.08292 * n);
  let bump = pow(0.5 + 0.5 * s21, 2.0) * pow(0.5 + 0.5 * s34, 2.0);
  // Anthers sit on the crown of each floret, which is where the pollen is.
  return vec2f(bump, smoothstep(0.55, 0.95, bump));
}

/** Debug view: which tier drew this fragment. */
fn tierColor(tier: u32) -> vec3f {
  if (tier == 0u) { return vec3f(0.90, 0.20, 0.20); }
  if (tier == 1u) { return vec3f(0.95, 0.65, 0.10); }
  if (tier == 2u) { return vec3f(0.20, 0.70, 0.30); }
  return vec3f(0.20, 0.40, 0.95);
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  let vis = visible[i.vid];
  let P = plants[vis.plant];
  let kind = M.flags.x;
  // How much fine detail the image can still resolve here, after the lens.
  let sharp = clamp(vis.sharp * G.plant.z, 0.0, 1.0);

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
  // Base colour and transmission both come off the plant now.
  var albedo = M.albedo.rgb;
  var transmitTint = M.transmit.rgb;

  if (isLeaf) {
    bump = vec2f(ridgeR - ridgeL, ridgeU - ridgeD) * M.flags.y * sharp;
    // Veins are opaque ribs; the lamina between them is what glows.
    thickness = (1.0 - vein.g * 0.92) * M.transmit.w * P.transmit.w;
    ao = detail.a;
    let a = vein.b * PI;
    grain = normalize(T * cos(a) + B * sin(a));
    albedo = P.leafCol.rgb;
    transmitTint = clamp(P.leafCol.rgb * 3.4 + vec3f(0.10, 0.30, 0.02), vec3f(0.02), vec3f(0.96));
  } else if (kind == KIND_PETAL) {
    let pv = petalVeins(i.uv, i.params.z);
    bump = vec2f(pv.y * pv.x * 2.2, 0.0) * M.flags.y * sharp;
    thickness = (1.0 - pv.x * 0.55 * sharp) * M.transmit.w;
    grain = normalize(B);      // ribs run along the strap
    albedo = P.rayCol.rgb;
    transmitTint = P.transmit.rgb;
  } else {
    // Stem and receptacle: fine longitudinal fluting.
    let f = sin(i.uv.x * 2.0 * PI * 3.0);
    bump = vec2f(f * 0.35, 0.0) * M.flags.y * sharp;
    thickness = 0.10 * M.transmit.w;
    albedo = P.leafCol.rgb * select(1.0, 1.25, kind == KIND_RECEPTACLE);
    transmitTint = clamp(P.leafCol.rgb * 2.8, vec3f(0.02), vec3f(0.9));
  }

  var roughness = M.surface.x;
  var specular = M.surface.z;

  // --- the disc, when the florets themselves are not drawn ---------------
  // Everything past the finest tier gets its capitulum here rather than from
  // several hundred instances. The receptacle's u runs 0..1 out to the bract
  // rim and its v wraps the head, so the polar coordinates the lattice needs
  // are already in the mesh.
  if (kind == KIND_RECEPTACLE) {
    let rn = clamp(sin(i.uv.y * PI * 0.5) * 1.22, 0.0, 1.22);
    if (rn <= 1.0 && vis.tier > 0u) {
      let theta = i.uv.x * (2.0 * PI / 6.0);
      let d = discPattern(rn, theta, max(24.0, P.florets.y));
      let front = plantFront(P);
      let open = smoothstep(front, front + 0.20, rn) * plantBloom(P);
      let unopened = P.leafCol.rgb * 0.75;
      let discCol = mix(unopened, P.discCol.rgb, smoothstep(0.05, 0.65, open));
      // Pollen on the anthers of the open ring, faded out with `sharp`: a
      // grain is tens of microns, so it is the very first thing the blur eats.
      let pollen = d.y * open * sharp * P.discCol.w;
      albedo = mix(discCol * (0.72 + 0.55 * d.x), vec3f(0.96, 0.80, 0.30), pollen * 0.55);
      // Florets are little tubes, so the disc is optically rough and its
      // normal ripples on the lattice. Both fade as the pattern stops
      // resolving, leaving a smooth cushion of the right average colour.
      bump = vec2f(cos(21.0 * theta) * (d.x - 0.5), sin(34.0 * theta) * (d.x - 0.5)) * 0.9 * sharp;
      roughness = mix(0.55, 0.82, sharp);
      specular = 0.030;
      thickness = 0.05;
    }
  }
  N = normalize(N - (T * bump.x + B * bump.y));
  B = cross(N, T);

  // --- albedo -------------------------------------------------------------
  let mottle = fbm3(vec3f(i.uv * 22.0, i.params.z * 17.0), 3);
  albedo *= 1.0 - M.flags.z * (0.5 - mottle) * sharp;

  if (isLeaf) {
    albedo = mix(albedo, albedo * vec3f(1.28, 1.16, 0.72), vein.r * 0.55);
    // Necrosis: dead margin tissue, which every real leaf has some of, and
    // more of on a plant that is going over.
    albedo = mix(albedo, vec3f(0.29, 0.16, 0.055),
                 detail.b * (0.35 + 0.65 * sharp) * (0.45 + 1.4 * P.leafCol.w));
    albedo *= ao;
  } else if (kind == KIND_PETAL) {
    // Ray florets are pigmented along their length, not uniformly. Two
    // gradients do most of the work: the nectar guide, which darkens and warms
    // toward the disc and which bees track straight in on, and the tip tint --
    // a common daisy's crimson margin is anthocyanin loaded into the last
    // fifth of the strap and nowhere else.
    let guide = pow(1.0 - i.uv.y, 2.6);
    albedo = mix(albedo, albedo * vec3f(1.05, 0.62, 0.30), guide * P.rayCol.w);
    let tipReach = max(0.02, P.tipCol.w);
    albedo = mix(albedo, P.tipCol.rgb, smoothstep(1.0 - tipReach, 1.0, i.uv.y));
    // Papery edge: the very margin of a ray floret is thin and desaturated.
    let edge = pow(abs(i.uv.x - 0.5) * 2.0, 5.0);
    albedo = mix(albedo, albedo * 1.15 + vec3f(0.06), edge * 0.5 * sharp);
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
  let f0 = vec3f(specular);
  let ndh = max(0.0, dot(N, H));
  var D: f32;
  if (isLeaf && M.surface.y > 0.01) {
    let aniso = M.surface.y;
    let ax = max(0.008, roughness * roughness * (1.0 + aniso));
    let ay = max(0.008, roughness * roughness * (1.0 - aniso));
    D = distributionGGXAniso(H, N, grain, cross(N, grain), ax, ay);
  } else {
    D = distributionGGX(ndh, roughness);
  }
  let Gv = smithGGX(ndv, max(0.0, ndl), roughness);
  let F = fresnelSchlick(f0, max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Transmission -- the reason this reads as a living plant. Per-channel
  // absorption: light crossing pink tissue emerges deeper red, green tissue
  // emerges yellow-green, because the pigment eats the other wavelengths. The
  // tint comes from the same pigment load the albedo does, so a pale
  // individual glows pale and a deeply pigmented one glows saturated.
  let trans = translucency(L, V, N, thickness, 3.2, 0.28);
  let absorb = exp(-(1.0 - transmitTint) * (1.0 + (1.0 - thickness) * 2.5));
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

  if (i32(G.plant.w + 0.5) == 7) { color = tierColor(vis.tier) * (0.35 + 0.65 * diff); }

  return vec4f(aerial(color, i.viewZ, -V, L), 1.0);
}
