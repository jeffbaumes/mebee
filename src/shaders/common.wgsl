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
  windParams  : vec4f,   // strength, simTime, dirX, dirZ
  state       : vec4f,   // bloom, unused, exposure, solveStep
  screen      : vec4f,   // w, h, 1/w, 1/h
  shadowParam : vec4f,   // orthoHalfWidth, depthRange, unused, bias
  plant       : vec4f,   // plantCount, fieldHalfExtent, lodSharpBias, debugView
  field       : vec4f,   // grass cell size, height scale, cells across, fade radius
  hazeSun     : vec4f,   // horizon radiance toward the sun, w = extinction /m
  hazeAway    : vec4f,   // horizon radiance away from it
  proj        : vec4f,   // near, far, A, B  (ndcZ = A + B/viewDist)
  post        : vec4f,   // bloomStrength, grainAmount, chromatic, vignette
  mark        : vec4f,   // bee world position, w = landing ring radius (0 = off)
}

@group(0) @binding(0) var<uniform> G : Globals;
@group(0) @binding(1) var shadowMap  : texture_depth_2d;
@group(0) @binding(2) var shadowCmp  : sampler_comparison;
@group(0) @binding(3) var linearSamp : sampler;
// The habitat, baked once from the same fields geom/field.js sampled to decide
// where each species establishes. Sharing it rather than re-inventing a noise
// here is what makes the ground agree with the flowers standing on it: the
// damp hollow is greener AND has the mayweed in it, the grazed patch is
// browner AND has the daisies, and neither had to be placed by hand.
@group(0) @binding(4) var habitatMap : texture_2d<f32>;

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

/**
 * The same lattice noise in two dimensions.
 *
 * Every noise the ground shades itself with is sampled on a horizontal plane,
 * i.e. with a CONSTANT second coordinate. Fed to valueNoise3 that is eight
 * corners of which four carry zero weight, and eight hash33 calls where four
 * would do -- and the ground evaluates six of these per fragment, so it is the
 * single most-executed block in the frame after the shadow taps.
 */
fn valueNoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm2(p: vec2f, octaves: i32) -> f32 {
  var sum = 0.0; var amp = 0.5; var freq = 1.0; var norm = 0.0;
  for (var i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(p * freq);
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
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
 * Lat-long parameterisation of the sky, and its inverse.
 *
 * Elevation is stored as the SIGNED SQUARE ROOT of dir.y rather than as the
 * angle, which puts most of the rows within a few degrees of the horizon --
 * where the whole colour gradient of a sky lives, and where a linear or
 * equal-angle map bands visibly. Azimuth is plain, and the u seam is left to
 * the sampler's repeat mode.
 *
 * The pair has to be exact inverses: sky.wgsl looks a direction up in a table
 * that sky_lut.wgsl filled by walking the same texels the other way.
 */
fn skyUv(dir: vec3f) -> vec2f {
  let u = atan2(dir.z, dir.x) / (2.0 * PI) + 0.5;
  let y = clamp(dir.y, -1.0, 1.0);
  return vec2f(u, 0.5 - 0.5 * sign(y) * sqrt(abs(y)));
}

fn skyDirOf(uv: vec2f) -> vec3f {
  let a = (uv.x - 0.5) * 2.0 * PI;
  let t = 1.0 - 2.0 * uv.y;
  let y = sign(t) * t * t;
  let r = sqrt(max(0.0, 1.0 - y * y));
  return vec3f(cos(a) * r, y, sin(a) * r);
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
 * Bend a texture coordinate so hardware bilinear behaves like a quintic.
 *
 * Bilinear interpolation is C0: its derivative jumps at every texel boundary,
 * and over a broad, slowly-varying field sampled at close range that shows up
 * as a quilt of texel-sized diamonds. The habitat map is 3.5 metres across at
 * 256 texels, so a texel is 27mm -- which is enormous from four centimetres
 * up, and was drawing a lattice of soft squares across the ground wherever the
 * sward thinned enough to see it. Warping the fractional part by the same
 * quintic value noise uses makes the hardware's own lerp land on a curve whose
 * first and second derivatives are continuous, for five instructions and no
 * extra taps.
 */
fn smoothTexel(uv: vec2f, size: vec2f) -> vec2f {
  let p = uv * size - 0.5;
  let i = floor(p);
  let f = p - i;
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return (i + 0.5 + w) / size;
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

/**
 * The same field, at a fraction of the cost, for callers that sample it once
 * per vertex across tens of thousands of instances.
 *
 * Grass is the case that matters: the full windAt() runs four fbm3 sums, which
 * is fine for sixteen stem nodes and ruinous for three hundred thousand blade
 * vertices. What a blade actually needs is the travelling gust front -- the
 * coherence between neighbours is the whole cue -- and one octave of
 * turbulence to keep them from beating in lockstep. The fine structure is
 * below a blade's width anyway.
 */
fn habitatAt(xz: vec2f) -> vec3f {
  // r = moisture, g = exposure, b = grazing pressure.
  let uv = xz / (2.0 * max(1e-3, G.plant.y)) + vec2f(0.5);
  let smoothed = smoothTexel(clamp(uv, vec2f(0.001), vec2f(0.999)),
                             vec2f(textureDimensions(habitatMap)));
  return textureSampleLevel(habitatMap, linearSamp, smoothed, 0.0).rgb;
}

fn windAtCheap(p: vec3f, t: f32) -> vec3f {
  let dir = normalize(vec3f(G.windParams.z, 0.0, G.windParams.w) + vec3f(1e-5, 0.0, 0.0));
  let strength = G.windParams.x;
  let phase = dot(p, dir) * 1.35 - t * 2.1;
  let front = pow(0.5 + 0.5 * sin(phase), 3.0);
  let breadth = valueNoise3(p * 0.7 + vec3f(0.0, 0.0, t * 0.3));
  let gust = front * (0.45 + 0.9 * breadth);
  let turb = valueNoise3(p * 7.0 + vec3f(t * 1.7, 0.0, 11.0)) - 0.5;
  return dir * strength * (0.30 + 1.70 * gust) + vec3f(turb, turb * 0.4, -turb) * strength * 0.45;
}

/**
 * Aerial perspective.
 *
 * Over the seven metres of the meadow, real extinction is negligible -- this
 * is a deliberate and modest exaggeration, there to stop the far side of the
 * field competing with the subject for contrast. The horizon colour is a
 * PRECOMPUTED pair, one looking into the sun and one away from it, blended by
 * the forward-scattering lobe. Evaluating the atmosphere itself here would be
 * a sixty-step raymarch per fragment of every surface in the scene, which is
 * roughly the cost of the entire rest of the frame.
 */
fn aerial(color: vec3f, dist: f32, dir: vec3f, sun: vec3f) -> vec3f {
  let forward = pow(0.5 + 0.5 * dot(normalize(dir + vec3f(1e-6)), sun), 3.0);
  let haze = mix(G.hazeAway.rgb, G.hazeSun.rgb, forward);
  return mix(color, haze, 1.0 - exp(-dist * G.hazeSun.w));
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
  //
  // Eight taps, not twelve. This estimate feeds one number -- the mean
  // occluder distance -- which then goes through a tan() of a quarter of a
  // degree; four extra samples move the penumbra width by well under a texel,
  // and this kernel runs on every lit fragment of the ground, the sward, every
  // petal and the bee, so it is the most-executed loop in the frame.
  let searchRadius = 7.0 * texel.x;
  var blockerDepth = 0.0;
  var blockers = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let o = vogelDisk(i, 8u, phi) * searchRadius;
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

  // Taps scale with the penumbra, because that is the only thing they are
  // there to resolve. A contact shadow a texel or two wide is a hard edge and
  // the hardware's own 2x2 comparison filter already softens it; twenty taps
  // spread over three texels is nineteen samples of the same answer. The wide,
  // soft end -- a leaf's shadow cast a hand's breadth onto the turf -- is
  // where the count actually buys smoothness, and it still gets twenty.
  let wide = radius > 5.0 * texel.x;
  let taps = select(8u, 20u, wide);
  var sum = 0.0;
  for (var i = 0u; i < taps; i++) {
    let o = vogelDisk(i, taps, phi) * radius;
    // Compare*Level*: the plain form demands uniform control flow, which the
    // early-out above already broke.
    sum += textureSampleCompareLevel(shadowMap, shadowCmp, uv + o, depth - bias);
  }
  return sum / f32(taps);
}

// ---------------------------------------------------------------------------
// Landing mark
//
// The one thing a bee cannot do by eye in this scene is judge where it is
// ABOUT to be. The sun's own shadow is no help -- it lies wherever the sun
// puts it, which at nine in the morning is most of a metre downwind of the
// bee, and it falls on whatever the sun can see rather than on what is
// underneath. So this is a second, fictitious shadow cast straight DOWN, and
// it is the altimeter: a soft blot that spreads and fades as the drop grows,
// and a hard ring at a fixed world radius that says exactly where the bee's
// own axis meets the first thing under it.
//
// Analytic, and evaluated by every surface that shades itself, which is why it
// lands correctly on the turf, on a grass blade and on the flower head the bee
// is descending onto without any of them knowing about it. A projected decal
// would have had to pick one of those surfaces.
// ---------------------------------------------------------------------------

/** Fold the down-shadow into a surface's colour. `world` is the fragment. */
fn landingMark(color: vec3f, world: vec3f) -> vec3f {
  let R = G.mark.w;
  if (R <= 0.0) { return color; }
  // Only what is UNDER the bee. Without this the mark also paints itself onto
  // the leaf the bee is flying beneath, which reads as a hole in the canopy.
  let drop = G.mark.y - world.y;
  if (drop <= 0.001) { return color; }

  let d = length(world.xz - G.mark.xz);
  if (d > R * 1.75) { return color; }

  // How far up the bee is, as a fraction of the height where the mark stops
  // meaning anything. A real contact shadow would fade to nothing here; this
  // one keeps a floor, because "there is ground somewhere below me" is worth
  // more than physical honesty at the moment you are looking for it.
  let high = clamp(drop / 0.30, 0.0, 1.0);

  // The blot spreads and softens with the drop -- that spread IS the height
  // readout, the same way a real penumbra widens with occluder distance. It is
  // multiplicative, because it is standing in for light that did not arrive.
  let spread = R * (0.55 + 0.85 * high);
  let soft = mix(0.18, 0.85, high);
  let blot = 1.0 - smoothstep(spread * (1.0 - soft), spread, d);
  var out = color * (1.0 - 0.45 * blot * mix(1.0, 0.5, high));

  // The ring does not move: fixed world radius, so it is a ruler laid on the
  // surface. Two millimetres up it sits tight around the bee's feet; twenty
  // centimetres up it is the same circle seen from further away, and closing
  // the gap between the bee and the middle of it is the landing.
  //
  // It also barely dims with height, unlike the blot: a contact shadow that
  // faded out as the bee climbed would be brightest exactly when the answer is
  // already obvious and gone by the time the question is worth asking. Height
  // takes it from the middle of the frame to the bottom edge and shrinks it to
  // a few pixels, which is quite enough attenuation on its own -- which is
  // also why the band is nearly a third of the radius wide rather than the
  // hairline it wants to be up close. A hairline is still a hairline at the
  // bottom of the frame, and by then it is nothing at all.
  let t = abs(d - R) / (R * 0.30);
  let ring = (1.0 - smoothstep(0.35, 1.0, t)) * mix(1.0, 0.85, high);

  // And it REPLACES the radiance rather than tinting it. The two surfaces it
  // has to read on are the turf, which at this exposure is nearly black, and a
  // backlit white petal, which is several stops over and clips. Anything added
  // disappeared into the petal; anything subtracted disappeared into the turf;
  // and anything that left even a tenth of the petal's own radiance in place
  // disappeared too, because that tenth is still above the knee of the
  // tonemap. Setting the ring to a fixed mid-grey takes whichever direction of
  // contrast the surface underneath has left to give -- it comes up bright on
  // the sward and dark on the daisy, and is legible on both. 0.52 is roughly
  // the scene radiance that lands on mid-grey once the exposure and the
  // tonemap have had it.
  //
  // It does cost the ring its shading, which is the honest price of a mark
  // that is not in the scene in the first place. Everything after this still
  // applies to it: it hazes with distance and it defocuses with the lens, so
  // it stays a thing lying on the ground rather than a decal on the glass.
  let MID = vec3f(0.52, 0.47, 0.31);
  out = mix(out, MID, ring);
  return out;
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
