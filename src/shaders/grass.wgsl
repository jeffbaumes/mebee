//!include common.wgsl

// The ground sward, placed procedurally around the camera rather than from an
// instance buffer.
//
// This is short, prostrate turf: geom/grass.js grows a blade that reaches
// further out than it stands up, and everything here keeps it that way -- it
// is scaled short, it is bent only a little by the wind, and it is about as
// wide as a flower stem is thick. Tall flowering grasses are a separate thing
// and are not built yet.
//
// The field is now several metres across, and a buffer dense enough to carry
// turf over all of it would be tens of millions of blades -- almost all of
// them behind the camera or inside the bokeh. So there is no buffer: the
// instance index is decoded into a cell of a fixed world grid inside a window
// that follows the camera, and the blade's position, height and lean are
// hashed from the cell. Blades therefore stay nailed to the world (they do not
// swim as the bee moves), the cost is constant wherever it flies, and the
// field could be a hundred metres across for the same price.
//
// Thinning is by the lens, not by distance. A blade is about a millimetre wide;
// once the circle of confusion at its distance is several times that, it cannot
// contribute anything an average colour would not, so it is dropped and the
// ground shader's sward texture carries it. Open the aperture and the sward
// thins out early; stop down and it reaches further, which is the correct
// behaviour and falls out of the same rule the flowers use.
//
// None of that decision is here any more. Where a blade is, whether it exists
// at all and how the wind has laid it over is settled once per blade by
// grass_cull.wgsl, which appends the survivors to a packed buffer; this stage
// reads one of those and does nothing but place the mesh. See that file for
// why -- in short, a blade has twenty-seven vertices and it was doing all of
// it twenty-seven times.

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world   : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) uv      : vec2f,
  @location(3) variant : f32,
  @location(4) viewZ   : f32,
  @location(5) across  : vec3f,   // world-space across axis of this blade
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

/**
 * Depth of the keel, as a fraction of the blade's half-width.
 *
 * A grass blade is V-folded along its length, and at this width that fold is
 * worth exactly one thing: a hard line of specular down the middle of each
 * blade. It is therefore shading, not geometry. Folding it into the mesh is
 * what the old blade did, and because the fold lived in the centreline's own
 * plane the vertex shader's LENGTH scale caught it -- so a fold meant to be a
 * third of a millimetre came out a centimetre deep, and a gust that turned
 * one edge-on made the blade disappear.
 */
const KEEL = 0.55;

/** One blade, as grass_cull.wgsl decided it. Must match struct Blade there. */
struct Blade {
  base : vec4f,   // xyz world position of the crown, w = arc length
  e0   : vec4f,   // frame column 0 (lean then yaw), w = half-width
  e1   : vec4f,   // frame column 1, w = variant hash
  wind : vec4f,   // xyz bend axis, w = bend angle at the tip
}

@group(1) @binding(0) var<storage, read> blades : array<Blade>;

/** Rodrigues rotation of `p` about a unit `axis`. */
fn rotateAxis(p: vec3f, axis: vec3f, ang: f32) -> vec3f {
  let c = cos(ang);
  let s = sin(ang);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let B = blades[ii];
  let len = B.base.w;
  let width = B.e0.w;
  let e0 = B.e0.xyz;
  let e1 = B.e1.xyz;
  // Exact, because the frame came out of a rotation of a right-handed basis.
  let e2 = cross(e0, e1);

  // The mesh keeps the centreline in x and y and the cross-section in z, so
  // the two scale independently: x and y by the arc length, z by the width.
  // Non-uniform scale, so the normal takes the INVERSE scale before it is
  // renormalised -- scaling a blade thin and long otherwise tips its normals
  // toward the long axis and the whole field lights wrongly.
  var p = e0 * (v.pos.x * len) + e1 * (v.pos.y * len) + e2 * (v.pos.z * width);
  var n = normalize(e0 * (v.nrm.x / len) + e1 * (v.nrm.y / len) + e2 * (v.nrm.z / width));
  // The blade's own across axis, carried through the bend below so the
  // fragment stage can tilt the shading normal into the keel.
  var ax = e2;

  // Cantilever: a blade clamped at the root bends with the square of the
  // distance along it, which is why grass curls over at the tip and stays
  // stiff at the base. This is the one thing about a blade that genuinely
  // differs per vertex, and so the one thing left in this stage.
  let u = v.params.x;
  let ang = B.wind.w * u * u;
  if (abs(ang) > 1e-6) {
    p = rotateAxis(p, B.wind.xyz, ang);
    n = rotateAxis(n, B.wind.xyz, ang);
    ax = rotateAxis(ax, B.wind.xyz, ang);
  }

  let world = B.base.xyz + p;
  var o: VOut;
  o.world = world;
  o.nrm = n;
  o.uv = v.uv;
  o.variant = B.e1.w;
  o.across = ax;
  o.clip = G.viewProj * vec4f(world, 1.0);
  o.viewZ = -(G.view * vec4f(world, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  // The keel. uv.x runs across the strap, so this tilts the shading normal
  // away from the midrib toward each margin -- a V-fold's whole visible
  // effect at a blade's real width, and one specular line down the middle of
  // every blade rather than a centimetre of folded geometry (see KEEL). It is
  // applied in the FRONT-facing frame and flipped afterwards, so the two
  // sides of a blade agree about which way the fold goes.
  var N = normalize(i.nrm);
  let acrossN = normalize(i.across - N * dot(i.across, N) + vec3f(1e-6, 0.0, 0.0));
  N = normalize(N + acrossN * KEEL * (i.uv.x - 0.5) * 2.0);
  if (!facing) { N = -N; }

  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);
  let H = normalize(L + V);
  let ndl = dot(N, L);
  let ndv = max(1e-4, dot(N, V));
  let sun = G.sunColor.rgb * G.sunColor.w;

  // Per-blade colour variation, and a darker, yellower base where light does
  // not reach into the sward. The wet end of the habitat runs bluer and the
  // grazed end runs strawy, so the blades agree with the ground under them.
  let hab = habitatAt(i.world.xz);
  let tint = fract(i.variant * 7.31);
  var albedo = mix(vec3f(0.055, 0.115, 0.028), vec3f(0.105, 0.165, 0.042), tint);
  albedo = mix(albedo * vec3f(1.25, 0.95, 0.60), albedo, smoothstep(0.2, 0.7, hab.r));
  albedo = mix(albedo * vec3f(0.72, 0.78, 0.55), albedo, smoothstep(0.0, 0.45, i.uv.y));
  // Tips dry out and pale off. Kept close to the living colour: at 2.5x the
  // lamina's own albedo the last third of every blade read as a white streak,
  // and a sward of those looks frosted rather than dry.
  albedo = mix(albedo, vec3f(0.125, 0.118, 0.058), smoothstep(0.78, 1.0, i.uv.y) * 0.45);

  let shade = shadowFactor(i.world, ndl);

  let wrap = 0.25;
  let diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  var color = albedo * sun * diff * shade / PI;

  // A blade is a thin membrane like any other lamina: backlit grass glows,
  // and at low sun that glow is most of what you see of a field.
  let thickness = 0.85 - 0.35 * smoothstep(0.0, 0.5, i.uv.y);
  let trans = translucency(L, V, N, thickness, 3.0, 0.30);
  color += sun * trans * vec3f(0.42, 0.68, 0.20) * albedo * 3.2 * mix(0.4, 1.0, shade);

  // The keel gives each blade one specular line down its length. Not a hard
  // one: the shading normal now sweeps a wide arc across the strap, so a
  // tight lobe put a blown highlight on every blade in the field at once.
  let rough = 0.40;
  let D = distributionGGX(max(0.0, dot(N, H)), rough);
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  let F = fresnelSchlick(vec3f(0.045), max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Ambient, with a crude vertical occlusion: the base of the sward is buried.
  let occlusion = mix(0.35, 1.0, smoothstep(0.0, 0.55, i.uv.y));
  color += albedo * skyAmbient(N) * occlusion;

  return vec4f(aerial(landingMark(color, i.world), i.viewZ, -V, L), 1.0);
}
