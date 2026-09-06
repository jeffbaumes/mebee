// Shared uniforms, lighting and utility code. Included by every other shader.

struct Globals {
  viewProj    : mat4x4f,
  invViewProj : mat4x4f,
  view        : mat4x4f,
  sunViewProj : mat4x4f,
  cameraPos   : vec4f,   // xyz, w = tan(fovY/2)
  sunDir      : vec4f,   // xyz toward the sun, w = sun angular radius (rad)
  sunColor    : vec4f,   // rgb, w = intensity
  shL0        : vec4f,   // sky irradiance SH, band 0
  shL1y       : vec4f,
  shL1z       : vec4f,
  shL1x       : vec4f,
  lens        : vec4f,   // focusDistance, fNumber, focalLength, sensorHeight
  windParams  : vec4f,   // strength, time, dirX, dirZ
  state       : vec4f,   // bloom, floretFront, exposure, dt
  screen      : vec4f,   // w, h, 1/w, 1/h
  shadowParam : vec4f,   // orthoHalfWidth, depthRange, unused, bias
  plant       : vec4f,   // stemLength, stemSegmentLength, flutterScale, unused
  proj        : vec4f,   // near, far, A, B  (ndcZ = A + B/viewDist)
  post        : vec4f,   // bloomStrength, grainAmount, chromatic, vignette
}

@group(0) @binding(0) var<uniform> G : Globals;
@group(0) @binding(1) var shadowMap  : texture_depth_2d;
@group(0) @binding(2) var shadowCmp  : sampler_comparison;
@group(0) @binding(3) var linearSamp : sampler;

const PI       = 3.14159265359;
const GOLDEN   = 2.39996323;   // golden angle in radians
const MAX_COC  = 48.0;         // full-res pixels

// ---------------------------------------------------------------------------
// Hashing and noise
// ---------------------------------------------------------------------------

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x = x * (x + 33.33);
  return fract(x * (x + x));
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash33(p: vec3f) -> vec3f {
  var p3 = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  p3 = p3 + dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

fn valueNoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var acc = 0.0;
  for (var dz = 0; dz < 2; dz++) {
    for (var dy = 0; dy < 2; dy++) {
      for (var dx = 0; dx < 2; dx++) {
        let o = vec3f(f32(dx), f32(dy), f32(dz));
        let w = mix(1.0 - u, u, o);
        acc += hash33(i + o).x * w.x * w.y * w.z;
      }
    }
  }
  return acc;
}

fn fbm3(p: vec3f, octaves: i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var freq = 1.0; var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(p * freq);
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

/**
 * Vogel disc: the same golden-angle spiral the flower's florets use. Gives an
 * evenly spread, rotation-jitterable sample set for any tap count without a
 * baked Poisson table.
 */
fn vogelDisk(i: u32, n: u32, phi: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(n));
  let theta = f32(i) * GOLDEN + phi;
  return vec2f(cos(theta), sin(theta)) * r;
}

// ---------------------------------------------------------------------------
// Atmosphere -- GPU twin of src/render/sky.js
// ---------------------------------------------------------------------------

const EARTH_R    = 6360e3;
const ATMOS_R    = 6420e3;
const BETA_R     = vec3f(5.8e-6, 13.5e-6, 33.1e-6);
const BETA_M     = 21e-6;
const H_RAYLEIGH = 8000.0;
const H_MIE      = 1200.0;
const MIE_G      = 0.76;

fn raySphereFar(origin: vec3f, dir: vec3f, radius: f32) -> f32 {
  let b = 2.0 * dot(origin, dir);
  let c = dot(origin, origin) - radius * radius;
  let disc = b * b - 4.0 * c;
  if (disc < 0.0) { return -1.0; }
  return (-b + sqrt(disc)) * 0.5;
}

fn skyRadiance(dir: vec3f, sunDir: vec3f) -> vec3f {
  let STEPS = 12;
  let LIGHT_STEPS = 5;
  let origin = vec3f(0.0, EARTH_R + 2.0, 0.0);
  let far = raySphereFar(origin, dir, ATMOS_R);
  if (far <= 0.0) { return vec3f(0.0); }

  let segLen = far / f32(STEPS);
  var odR = 0.0; var odM = 0.0;
  var sumR = vec3f(0.0); var sumM = vec3f(0.0);

  for (var i = 0; i < STEPS; i++) {
    let p = origin + dir * ((f32(i) + 0.5) * segLen);
    let h = length(p) - EARTH_R;
    let hr = exp(-h / H_RAYLEIGH) * segLen;
    let hm = exp(-h / H_MIE) * segLen;
    odR += hr; odM += hm;

    let lFar = raySphereFar(p, sunDir, ATMOS_R);
    var lOdR = 0.0; var lOdM = 0.0; var blocked = false;
    if (lFar > 0.0) {
      let lSeg = lFar / f32(LIGHT_STEPS);
      for (var j = 0; j < LIGHT_STEPS; j++) {
        let lp = p + sunDir * ((f32(j) + 0.5) * lSeg);
        let lh = length(lp) - EARTH_R;
        if (lh < 0.0) { blocked = true; break; }
        lOdR += exp(-lh / H_RAYLEIGH) * lSeg;
        lOdM += exp(-lh / H_MIE) * lSeg;
      }
    }
    if (blocked) { continue; }

    let tau = BETA_R * (odR + lOdR) + vec3f(BETA_M * 1.1 * (odM + lOdM));
    let att = exp(-tau);
    sumR += att * hr;
    sumM += att * hm;
  }

  let mu = dot(dir, sunDir);
  let phaseR = (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
  let g = MIE_G;
  let phaseM = (3.0 / (8.0 * PI)) * ((1.0 - g * g) * (1.0 + mu * mu)) /
               ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  return (sumR * BETA_R * phaseR + sumM * BETA_M * phaseM) * G.sunColor.w;
}

/**
 * Ambient irradiance from the sky, reconstructed from band-0/1 SH.
 *
 * The stored coefficients are cosine-convolved radiance projections; turning
 * them back into irradiance needs the SH basis constants (Y00 and Y1m), which
 * were missing here -- without them the DC term came out about 3.5x too strong
 * and the linear terms twice too weak, so ambient was both too bright and
 * flat. Divided by pi to give the outgoing radiance of a Lambertian surface,
 * which is what the shading below actually wants.
 */
fn skyAmbient(n: vec3f) -> vec3f {
  const Y00 = 0.282095;
  const Y1  = 0.488603;
  let c = G.shL0.rgb * Y00
        + (G.shL1y.rgb * n.y + G.shL1z.rgb * n.z + G.shL1x.rgb * n.x) * Y1;
  return max(c, vec3f(0.0)) / PI;
}

/**
 * One coherent wind field sampled by everything in the scene.
 *
 * Gusts are travelling wavefronts, not per-object noise: `dot(p, dir)` puts a
 * moving phase front across the world, so a gust visibly crosses the meadow
 * and every plant it passes leans in turn. Per-object sine waves never sell
 * wind, because the coherence between neighbours is the cue.
 */
fn windAt(p: vec3f, t: f32) -> vec3f {
  let dir = normalize(vec3f(G.windParams.z, 0.0, G.windParams.w) + vec3f(1e-5, 0.0, 0.0));
  let strength = G.windParams.x;

  let phase = dot(p, dir) * 1.35 - t * 2.1;
  let front = pow(0.5 + 0.5 * sin(phase), 3.0);
  let breadth = fbm3(p * 0.7 + vec3f(0.0, 0.0, t * 0.3), 3);
  let gust = front * (0.45 + 0.9 * breadth);

  // Small-scale turbulence so nothing moves perfectly in lockstep.
  let n = vec3f(
    fbm3(p * 7.0 + vec3f(t * 1.7, 0.0, 0.0), 3),
    fbm3(p * 7.0 + vec3f(0.0, t * 1.3, 11.0), 3),
    fbm3(p * 7.0 + vec3f(0.0, 0.0, t * 1.9 + 23.0), 3),
  ) - vec3f(0.5);

  return dir * strength * (0.30 + 1.70 * gust) + n * strength * 0.55;
}

// ---------------------------------------------------------------------------
// Shadows
//
// Contact-hardening PCF. The sun subtends about half a degree, so its penumbra
// widens with occluder distance -- a fixed-radius PCF makes every shadow the
// same softness, which is one of the strongest "this is a game" tells.
// ---------------------------------------------------------------------------

fn shadowFactor(worldPos: vec3f, ndl: f32) -> f32 {
  let lp = G.sunViewProj * vec4f(worldPos, 1.0);
  var uv = lp.xy / lp.w;
  uv = vec2f(uv.x * 0.5 + 0.5, -uv.y * 0.5 + 0.5);
  let depth = lp.z / lp.w;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || depth > 1.0) {
    return 1.0;
  }

  // Slope-scaled bias: grazing light needs more, or the surface self-shadows.
  let slope = clamp(1.0 - ndl, 0.0, 1.0);
  let bias = G.shadowParam.w * (0.35 + 2.4 * slope * slope);

  let dims = vec2f(textureDimensions(shadowMap));
  let texel = 1.0 / dims;
  let phi = hash21(worldPos.xz * 811.0) * 2.0 * PI;

  // --- blocker search ---
  // textureLoad, not textureSampleLevel: sampling a depth texture needs a
  // non-filtering sampler, and the only one bound here filters. Point sampling
  // is what a blocker search wants anyway.
  let searchRadius = 7.0 * texel.x;
  var blockerDepth = 0.0;
  var blockers = 0.0;
  for (var i = 0u; i < 12u; i++) {
    let o = vogelDisk(i, 12u, phi) * searchRadius;
    let c = vec2i((uv + o) * dims);
    let cc = clamp(c, vec2i(0), vec2i(dims) - vec2i(1));
    let d = textureLoad(shadowMap, cc, 0);
    if (d < depth - bias) { blockerDepth += d; blockers += 1.0; }
  }
  if (blockers < 0.5) { return 1.0; }
  blockerDepth /= blockers;

  // Penumbra from the sun's angular radius: an occluder `d` metres away casts
  // a penumbra about 2*d*tan(theta) wide.
  let occluderDist = (depth - blockerDepth) * G.shadowParam.y;
  let penumbraWorld = 2.0 * occluderDist * tan(G.sunDir.w);
  let radius = clamp(penumbraWorld / (G.shadowParam.x * 2.0), texel.x, 24.0 * texel.x);

  var sum = 0.0;
  for (var i = 0u; i < 20u; i++) {
    let o = vogelDisk(i, 20u, phi) * radius;
    // Compare*Level*: the plain form demands uniform control flow, which the
    // early-out above already broke.
    sum += textureSampleCompareLevel(shadowMap, shadowCmp, uv + o, depth - bias);
  }
  return sum / 20.0;
}

// ---------------------------------------------------------------------------
// BRDF
// ---------------------------------------------------------------------------

fn distributionGGX(ndh: f32, rough: f32) -> f32 {
  let a = rough * rough;
  let a2 = a * a;
  let d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(1e-7, PI * d * d);
}

/** Anisotropic GGX; `tangent` should follow the surface's grain direction. */
fn distributionGGXAniso(h: vec3f, n: vec3f, t: vec3f, b: vec3f, ax: f32, ay: f32) -> f32 {
  let ht = dot(h, t) / max(1e-4, ax);
  let hb = dot(h, b) / max(1e-4, ay);
  let hn = dot(h, n);
  let d = ht * ht + hb * hb + hn * hn;
  return 1.0 / max(1e-7, PI * ax * ay * d * d);
}

fn smithGGX(ndv: f32, ndl: f32, rough: f32) -> f32 {
  let k = (rough + 1.0) * (rough + 1.0) / 8.0;
  let gv = ndv / (ndv * (1.0 - k) + k);
  let gl = ndl / (ndl * (1.0 - k) + k);
  return gv * gl;
}

fn fresnelSchlick(f0: vec3f, vdh: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
}

/**
 * Fast translucency (Barre-Brisebois & Bouchard, GDC 2011). `thickness` is the
 * fraction of light that survives the crossing -- for a leaf this comes from
 * the venation bake, so veins read as dark ribs against a glowing lamina,
 * which is the single strongest cue that a plant is real and backlit.
 */
fn translucency(L: vec3f, V: vec3f, N: vec3f, thickness: f32, power: f32, distortion: f32) -> f32 {
  let H = normalize(L + N * distortion);
  let back = pow(clamp(dot(V, -H), 0.0, 1.0), power);
  return back * thickness;
}

// ---------------------------------------------------------------------------
// Tonemap / transfer
// ---------------------------------------------------------------------------

/** ACES filmic approximation (Narkowicz). */
fn tonemapACES(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linearToSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(1e-5)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

/**
 * View-space distance from a depth-buffer value.
 * ndcZ = A + B/dist, so dist = B / (ndcZ - A).
 */
fn linearDepth(ndcZ: f32) -> f32 {
  return G.proj.w / (ndcZ - G.proj.z);
}

/** Signed circle-of-confusion in pixels; negative in front of the focal plane. */
fn signedCoC(viewDepth: f32) -> f32 {
  let focus = G.lens.x;
  let fNumber = G.lens.y;
  let focal = G.lens.z;
  let sensorH = G.lens.w;
  let aperture = focal / max(0.5, fNumber);
  // Thin-lens CoC on the sensor, converted to pixels.
  let cocSensor = aperture * focal * (viewDepth - focus) /
                  max(1e-6, viewDepth * (focus - focal));
  // Clamp: a genuine macro CoC runs to hundreds of pixels a few centimetres
  // behind the subject, which no finite-tap gather can cover. Past this the
  // disc is already featureless, so the clamp costs nothing visible.
  return clamp(cocSensor / sensorH * G.screen.y, -MAX_COC, MAX_COC);
}
