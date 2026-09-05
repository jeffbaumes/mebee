//!include common.wgsl

// Macro depth of field.
//
// At a bee's working distance a 100mm-equivalent lens at f/2.8 has a depth of
// field a few millimetres deep, so almost the entire frame is out of focus.
// That is not a cost -- it is the budget. Everything past ~30cm dissolves into
// bokeh, which both matches the photographic reference the eye is calibrated
// on and means detail only ever has to exist in the near field.

@group(1) @binding(0) var srcColor : texture_2d<f32>;
@group(1) @binding(1) var srcDepth : texture_depth_2d;
@group(1) @binding(2) var halfRes  : texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vsFullscreen(@builtin(vertex_index) vi: u32) -> VOut {
  let p = array(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, -p[vi].y * 0.5 + 0.5);
  return o;
}

/**
 * Half-resolution prepass: colour in rgb, signed CoC in alpha.
 *
 * The four full-res taps are averaged by CoC rather than uniformly, so a sharp
 * in-focus sliver cannot leak into a neighbouring blurred region and leave a
 * hard edge where there should be a smooth falloff.
 */
@fragment
fn prepare(i: VOut) -> @location(0) vec4f {
  let full = vec2i(i.uv * G.screen.xy);
  var color = vec3f(0.0);
  var coc = 0.0;
  var wsum = 0.0;
  for (var dy = 0; dy < 2; dy++) {
    for (var dx = 0; dx < 2; dx++) {
      let c = clamp(full + vec2i(dx, dy), vec2i(0), vec2i(G.screen.xy) - vec2i(1));
      let d = textureLoad(srcDepth, c, 0);
      let z = linearDepth(d);
      let k = signedCoC(z);
      // Weight by blur: a blurred sample should dominate the merged texel.
      let w = 1.0 / (1.0 + max(0.0, -k) * 0.4);
      color += textureLoad(srcColor, c, 0).rgb * w;
      coc += k * w;
      wsum += w;
    }
  }
  // Half-res, so a pixel here is two full-res pixels wide.
  return vec4f(color / wsum, coc / wsum * 0.5);
}

const TAPS : u32 = 32u;

/**
 * Scatter-as-gather bokeh.
 *
 * A tap contributes if its own circle of confusion is wide enough to reach
 * this pixel -- that is the gather form of "each pixel scatters energy over
 * its blur circle", and it is what stops backgrounds smearing over sharp
 * foreground edges.
 */
@fragment
fn gather(i: VOut) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(halfRes));
  let centre = textureSampleLevel(halfRes, linearSamp, i.uv, 0.0);
  let radius = abs(centre.a);
  if (radius < 0.75) { return centre; }

  // Optical vignetting: off-axis, the aperture is occluded by the barrel and
  // bokeh discs clip into cat's-eye slivers. Real, and unmistakably lens-like.
  let offAxis = (i.uv - vec2f(0.5)) * 2.0;
  let catEye = clamp(length(offAxis), 0.0, 1.0) * 0.55;
  let radial = normalize(offAxis + vec2f(1e-5));

  let jitter = hash21(i.uv * G.screen.xy) * 2.0 * PI;
  var acc = vec3f(0.0);
  var wsum = 0.0;

  for (var t = 0u; t < TAPS; t++) {
    var o = vogelDisk(t, TAPS, jitter);
    // Squash the kernel along the radial direction to make the cat's eye.
    let along = dot(o, radial);
    o -= radial * along * catEye;

    let dist = length(o);
    let uv = i.uv + o * radius * texel;
    let s = textureSampleLevel(halfRes, linearSamp, uv, 0.0);
    let sr = abs(s.a);

    // Does this tap's blur circle reach us?
    var w = clamp(sr - dist * radius + 1.0, 0.0, 1.0);
    // Foreground protection: a sharp sample nearer than the centre must not
    // bleed outward, or in-focus edges grow halos.
    if (s.a < 0.0 && sr < radius * 0.5) { w *= 0.15; }

    // Spherical aberration brightens the rim of the disc. Fast lenses do this
    // and it is most of what makes bokeh look like glass rather than blur.
    w *= 1.0 + 0.85 * smoothstep(0.72, 1.0, dist);

    acc += s.rgb * w;
    wsum += w;
  }
  if (wsum < 1e-4) { return centre; }
  return vec4f(acc / wsum, centre.a);
}
