//!include skin.wgsl

// Instanced disc florets. One unit-scale mesh, 400-odd instances placed on the
// Vogel spiral, each opening on its own schedule.

struct FloretInstance {
  posScale : vec4f,   // xyz relative to the head, w = scale
  nrmRad   : vec4f,   // xyz dome normal, w = normalised radius 0..1
}

@group(1) @binding(1) var<storage, read> florets : array<FloretInstance>;

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world   : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) uv      : vec2f,
  @location(3) open    : f32,
  @location(4) seed    : f32,
  @location(5) viewZ   : f32,
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
  let inst = florets[ii];
  let radial = inst.nrmRad.w;

  // Capitula open from the rim inward: a front sweeps toward the centre and
  // every floret it passes anthesises. G.state.y is where that front sits.
  let front = G.state.y;
  let openness = smoothstep(front, front + 0.20, radial) * G.state.x;

  let localRest = mix(v.budPos, v.pos, openness);
  let localNrm  = normalize(mix(v.budNrm, v.nrm, openness));

  // Frame with +Y along the dome normal.
  let up = normalize(inst.nrmRad.xyz);
  var refDir = vec3f(0.0, 0.0, 1.0);
  if (abs(up.z) > 0.9) { refDir = vec3f(1.0, 0.0, 0.0); }
  let xa = normalize(cross(refDir, up));
  let za = cross(up, xa);

  let scaled = localRest * inst.posScale.w;
  let headLocal = inst.posScale.xyz + xa * scaled.x + up * scaled.y + za * scaled.z;
  let nrmLocal  = xa * localNrm.x + up * localNrm.y + za * localNrm.z;

  // Florets sit on the head, so they ride the very top of the stem.
  let restPos = vec3f(headLocal.x, G.plant.x + headLocal.y, headLocal.z);
  let s = skinToStem(restPos, nrmLocal, xa, 1.0, 0.0, G.plant.x, radial);

  var o: VOut;
  o.world = s.pos;
  o.nrm = s.nrm;
  o.uv = v.uv;
  o.open = openness;
  o.seed = f32(ii);
  o.clip = G.viewProj * vec4f(s.pos, 1.0);
  o.viewZ = -(G.view * vec4f(s.pos, 1.0)).z;
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
  let sun = G.sunColor.rgb * G.sunColor.w;

  // Immature florets are green and tight; mature ones flush orange and carry
  // pollen. The gradient across the disc is the flower's clock, made visible.
  let unopened = vec3f(0.085, 0.105, 0.042);
  let mature   = vec3f(0.52, 0.30, 0.045);
  var albedo = mix(unopened, mature, smoothstep(0.05, 0.65, i.open));

  // Pollen: bright, slightly warm grains clustered on the anthers of open
  // florets. Sub-pixel at this scale, so they mostly survive as sparkle that
  // the bloom and defocus passes turn into highlights.
  let grain = hash21(vec2f(i.seed, floor(i.uv.x * 9.0) + floor(i.uv.y * 9.0) * 13.0));
  let onAnther = smoothstep(0.55, 0.95, i.uv.y) * i.open;
  let pollen = step(0.62, grain) * onAnther;
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
  return vec4f(color, 1.0);
}
