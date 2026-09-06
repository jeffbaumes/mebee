//!include scene.wgsl

// Instanced disc florets, for the handful of plants near enough that the
// capitulum resolves as individual florets rather than as a texture.
//
// Two instance spaces are multiplexed onto one draw. The high bits of
// instance_index pick which visible plant this is (the draw's firstInstance
// carries the slot), the low bits pick the floret within its capitulum. Every
// species has its own floret count and its own block of the Vogel table, so
// the stride has to be a constant that no species can exceed rather than the
// count itself.

const FLORETS_PER_PLANT : u32 = 1024u;

struct FloretInstance {
  posScale : vec4f,   // xyz relative to the head, w = scale
  nrmRad   : vec4f,   // xyz dome normal, w = normalised radius 0..1
}

@group(2) @binding(0) var<storage, read> florets : array<FloretInstance>;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world   : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) uv      : vec2f,
  @location(3) open    : f32,
  @location(4) seed    : f32,
  @location(5) @interpolate(flat) vid : u32,
  @location(6) viewZ   : f32,
}

struct VIn {
  @location(0) pos    : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) budPos : vec3f,
  @location(3) budNrm : vec3f,
  @location(4) tan    : vec3f,
  @location(5) uv     : vec2f,
  @location(6) params : vec3f,
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let slot = ii / FLORETS_PER_PLANT;
  let n = ii % FLORETS_PER_PLANT;
  let vis = visible[slot];
  let P = plants[vis.plant];

  // Past this species' floret count the instance has no floret to be; collapse
  // it to a point rather than branching, so the draw can stay one call with a
  // constant stride.
  let live = f32(n) < P.florets.y;
  let inst = florets[u32(P.florets.x) + min(n, u32(max(0.0, P.florets.y - 1.0)))];
  let radial = inst.nrmRad.w;

  // Capitula open from the rim inward: a front sweeps toward the centre and
  // every floret it passes anthesises. Each plant carries its own position in
  // that sweep, so a drift shows every stage at once the way a real one does.
  let bloom = clamp(P.phase.x * G.state.x, 0.0, 1.0);
  let front = clamp(P.phase.y + G.state.y, 0.0, 1.0);
  let openness = smoothstep(front, front + 0.20, radial) * bloom;

  let localRest = mix(v.budPos, v.pos, openness);
  let localNrm  = normalize(mix(v.budNrm, v.nrm, openness));

  // Frame with +Y along the dome normal.
  let up = normalize(inst.nrmRad.xyz);
  var refDir = vec3f(0.0, 0.0, 1.0);
  if (abs(up.z) > 0.9) { refDir = vec3f(1.0, 0.0, 0.0); }
  let xa = normalize(cross(refDir, up));
  let za = cross(up, xa);

  let scaled = localRest * inst.posScale.w * select(0.0, 1.0, live);
  let headLocal = inst.posScale.xyz + xa * scaled.x + up * scaled.y + za * scaled.z;
  let nrmLocal  = xa * localNrm.x + up * localNrm.y + za * localNrm.z;

  // Florets sit on the head, so they ride the very top of the stem. The mesh
  // stores head-relative offsets, so stemH is 1 and there is nothing to
  // subtract.
  let s = skinToPlant(P, vis.plant, headLocal, nrmLocal, xa, 1.0, 0.0, radial);

  var o: VOut;
  o.world = s.pos;
  o.nrm = s.nrm;
  o.uv = v.uv;
  o.open = openness;
  o.seed = f32(n) + P.phase.z * 97.0;
  o.vid = slot;
  o.clip = G.viewProj * vec4f(s.pos, 1.0);
  o.viewZ = -(G.view * vec4f(s.pos, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  let vis = visible[i.vid];
  let P = plants[vis.plant];
  let sharp = clamp(vis.sharp * G.plant.z, 0.0, 1.0);

  var N = normalize(i.nrm);
  if (!facing) { N = -N; }

  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);
  let H = normalize(L + V);
  let ndl = dot(N, L);
  let sun = G.sunColor.rgb * G.sunColor.w;

  // Immature florets are green and tight; mature ones flush to the species'
  // own disc pigment and carry pollen. The gradient across the disc is the
  // flower's clock, made visible.
  let unopened = P.leafCol.rgb * 0.70;
  var albedo = mix(unopened, P.discCol.rgb, smoothstep(0.05, 0.65, i.open));

  // Pollen: bright, slightly warm grains clustered on the anthers of open
  // florets. Sub-pixel at this scale, so they mostly survive as sparkle that
  // the bloom and defocus passes turn into highlights -- and once the defocus
  // is wide enough to erase them, `sharp` takes them out before they can
  // alias into it.
  let grain = hash21(vec2f(i.seed, floor(i.uv.x * 9.0) + floor(i.uv.y * 9.0) * 13.0));
  let onAnther = smoothstep(0.55, 0.95, i.uv.y) * i.open;
  let pollen = step(0.62, grain) * onAnther * sharp * P.discCol.w;
  albedo = mix(albedo, vec3f(0.96, 0.80, 0.30), pollen * 0.9);

  let shade = shadowFactor(i.world, ndl);
  var color = albedo * sun * max(0.0, ndl) * shade / PI;

  // Pollen grains are rough dielectric powder: broad, dim specular.
  let rough = mix(0.85, 0.55, pollen);
  let D = distributionGGX(max(0.0, dot(N, H)), rough);
  let ndv = max(1e-4, dot(N, V));
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  color += sun * shade * max(0.0, ndl) * D * Gv * 0.04 / max(1e-4, 4.0 * ndv);

  color += albedo * skyAmbient(N);
  if (i32(G.plant.w + 0.5) == 7) { color = vec3f(0.90, 0.20, 0.20) * 0.6; }
  return vec4f(aerial(color, i.viewZ, -V, L), 1.0);
}
