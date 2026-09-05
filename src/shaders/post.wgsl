//!include common.wgsl

// Final grade: composite, lens artefacts, tonemap.
//
// Everything here is a property of the camera rather than the scene. That is
// deliberate: the reference for this look is a macro photograph, so matching
// the instrument does more for believability than adding geometry would.

@group(1) @binding(0) var sharpTex : texture_2d<f32>;
@group(1) @binding(1) var blurTex  : texture_2d<f32>;
@group(1) @binding(2) var bloomTex : texture_2d<f32>;
@group(1) @binding(3) var depthTex : texture_depth_2d;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vsFullscreen(@builtin(vertex_index) vi: u32) -> VOut {
  let p = array(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, -p[vi].y * 0.5 + 0.5);
  return o;
}

/** Composite sharp against defocused, at a UV displaced for one channel. */
fn resolve(uv: vec2f, blend: f32) -> vec3f {
  let sharp = textureSampleLevel(sharpTex, linearSamp, uv, 0.0).rgb;
  let blur  = textureSampleLevel(blurTex,  linearSamp, uv, 0.0).rgb;
  return mix(sharp, blur, blend);
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let uv = i.uv;
  let centred = uv - vec2f(0.5);
  let r2 = dot(centred, centred);

  // Clamp: at uv == 1 the scaled coordinate lands one texel past the edge, and
  // an out-of-bounds textureLoad returns zero -- which reads as "at the near
  // plane" and would put a sharp seam along the last row and column.
  let dc = clamp(vec2i(uv * G.screen.xy), vec2i(0), vec2i(G.screen.xy) - vec2i(1));
  let d = textureLoad(depthTex, dc, 0);
  let cocSigned = signedCoC(linearDepth(d));
  let coc = abs(cocSigned);
  let blend = smoothstep(0.5, 2.2, coc);

  // Debug views. Each isolates one stage so a black frame can be attributed
  // rather than guessed at: whether the main pass drew anything at all, what
  // depth it wrote, what the defocus and bloom chains made of it.
  let dbg = i32(G.plant.w + 0.5);
  if (dbg != 0) {
    let sharp = textureSampleLevel(sharpTex, linearSamp, uv, 0.0).rgb;
    if (dbg == 1) {                       // HDR straight out of the main pass
      return vec4f(linearToSrgb(tonemapACES(sharp * G.state.z)), 1.0);
    }
    if (dbg == 2) {                       // HDR, no tonemap, heavily lifted
      return vec4f(linearToSrgb(sharp * 40.0), 1.0);
    }
    if (dbg == 3) {                       // linear depth as bands
      let z = linearDepth(d);
      return vec4f(vec3f(fract(z * 8.0) * step(z, 11.0)), 1.0);
    }
    if (dbg == 4) {                       // circle of confusion: red near, green far
      let m = clamp(coc / 48.0, 0.0, 1.0);
      return vec4f(select(vec3f(0.0, m, 0.0), vec3f(m, 0.0, 0.0), cocSigned < 0.0), 1.0);
    }
    if (dbg == 5) {                       // defocused half-res buffer
      return vec4f(linearToSrgb(tonemapACES(
        textureSampleLevel(blurTex, linearSamp, uv, 0.0).rgb * G.state.z)), 1.0);
    }
    if (dbg == 6) {                       // bloom chain
      return vec4f(linearToSrgb(tonemapACES(
        textureSampleLevel(bloomTex, linearSamp, uv, 0.0).rgb * 8.0)), 1.0);
    }
  }

  // Lateral chromatic aberration: the lens focuses short wavelengths closer,
  // so channels land at slightly different scales. Zero on axis, growing with
  // the square of field height, which is how real transverse CA behaves.
  let ca = G.post.z * r2;
  let uvR = vec2f(0.5) + centred * (1.0 + ca);
  let uvB = vec2f(0.5) + centred * (1.0 - ca);

  var color = vec3f(
    resolve(uvR, blend).r,
    resolve(uv,  blend).g,
    resolve(uvB, blend).b,
  );

  color += textureSampleLevel(bloomTex, linearSamp, uv, 0.0).rgb * G.post.x;

  // Natural vignetting. cos^4 is the physical falloff of an ideal lens; the
  // extra term stands in for mechanical vignetting from the barrel.
  let cosTheta = 1.0 / sqrt(1.0 + r2 * 4.0);
  let natural = pow(cosTheta, 4.0);
  color *= mix(1.0, natural, G.post.w);

  color *= G.state.z;                      // exposure
  color = tonemapACES(color);

  // Grain, weighted toward the shadows the way film and sensor noise both are.
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  let n = hash21(uv * G.screen.xy + vec2f(G.windParams.y * 91.7, G.windParams.y * 47.3)) - 0.5;
  color += n * G.post.y * (1.0 - luma) * (1.0 - luma);

  color = linearToSrgb(max(color, vec3f(0.0)));

  // Ordered dither before the 8-bit write: without it, the smooth sky gradient
  // bands visibly, and banding is the one artefact that instantly reads digital.
  let dither = (hash21(uv * G.screen.xy + vec2f(3.7, 9.1)) - 0.5) / 255.0;
  return vec4f(color + dither, 1.0);
}
