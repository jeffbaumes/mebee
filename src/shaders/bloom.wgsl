//!include common.wgsl

// Progressive down/up bloom (Jimenez, SIGGRAPH 2014 "Next Generation Post
// Processing in Call of Duty"). Bloom here is not a glow effect -- it is the
// veiling flare a real lens throws around a blown highlight, and it is what
// makes a specular hit on a wet petal read as genuinely bright rather than
// merely white.

struct BlurParams { texel: vec2f, radius: f32, karis: f32 }

@group(1) @binding(0) var srcTex : texture_2d<f32>;
@group(1) @binding(1) var<uniform> BP : BlurParams;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vsFullscreen(@builtin(vertex_index) vi: u32) -> VOut {
  let p = array(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, -p[vi].y * 0.5 + 0.5);
  return o;
}

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(srcTex, linearSamp, uv, 0.0).rgb;
}

/** Weight by inverse luminance so one firefly pixel cannot dominate a mip. */
fn karisAverage(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  let wa = 1.0 / (1.0 + dot(a, vec3f(0.2126, 0.7152, 0.0722)));
  let wb = 1.0 / (1.0 + dot(b, vec3f(0.2126, 0.7152, 0.0722)));
  let wc = 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)));
  let wd = 1.0 / (1.0 + dot(d, vec3f(0.2126, 0.7152, 0.0722)));
  return (a * wa + b * wb + c * wc + d * wd) / max(1e-5, wa + wb + wc + wd);
}

@fragment
fn downsample(i: VOut) -> @location(0) vec4f {
  let t = BP.texel;
  let a = tap(i.uv + vec2f(-2.0, 2.0) * t);
  let b = tap(i.uv + vec2f( 0.0, 2.0) * t);
  let c = tap(i.uv + vec2f( 2.0, 2.0) * t);
  let d = tap(i.uv + vec2f(-2.0, 0.0) * t);
  let e = tap(i.uv);
  let f = tap(i.uv + vec2f( 2.0, 0.0) * t);
  let g = tap(i.uv + vec2f(-2.0,-2.0) * t);
  let h = tap(i.uv + vec2f( 0.0,-2.0) * t);
  let j = tap(i.uv + vec2f( 2.0,-2.0) * t);
  let k = tap(i.uv + vec2f(-1.0, 1.0) * t);
  let l = tap(i.uv + vec2f( 1.0, 1.0) * t);
  let m = tap(i.uv + vec2f(-1.0,-1.0) * t);
  let n = tap(i.uv + vec2f( 1.0,-1.0) * t);

  var result: vec3f;
  if (BP.karis > 0.5) {
    result = karisAverage(k, l, m, n) * 0.5
           + karisAverage(a, b, d, e) * 0.125
           + karisAverage(b, c, e, f) * 0.125
           + karisAverage(d, e, g, h) * 0.125
           + karisAverage(e, f, h, j) * 0.125;
  } else {
    result = e * 0.125
           + (a + c + g + j) * 0.03125
           + (b + d + f + h) * 0.0625
           + (k + l + m + n) * 0.125;
  }
  return vec4f(result, 1.0);
}

@fragment
fn upsample(i: VOut) -> @location(0) vec4f {
  // 3x3 tent, radius in texels of the *target*.
  let t = BP.texel * BP.radius;
  var s = tap(i.uv + vec2f(-1.0, 1.0) * t) * 1.0;
  s += tap(i.uv + vec2f( 0.0, 1.0) * t) * 2.0;
  s += tap(i.uv + vec2f( 1.0, 1.0) * t) * 1.0;
  s += tap(i.uv + vec2f(-1.0, 0.0) * t) * 2.0;
  s += tap(i.uv) * 4.0;
  s += tap(i.uv + vec2f( 1.0, 0.0) * t) * 2.0;
  s += tap(i.uv + vec2f(-1.0,-1.0) * t) * 1.0;
  s += tap(i.uv + vec2f( 0.0,-1.0) * t) * 2.0;
  s += tap(i.uv + vec2f( 1.0,-1.0) * t) * 1.0;
  return vec4f(s / 16.0, 1.0);
}
