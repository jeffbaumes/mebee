//!include common.wgsl

// Fullscreen background: scattered sky plus the sun's actual disc.

struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  // Oversized triangle; cheaper than a quad and avoids the diagonal seam.
  let p = array(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 1.0, 1.0);
  o.ndc = p[vi];
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  // Unproject to a world ray. Depth 1.0 with a reversed-Z-free projection.
  let far = G.invViewProj * vec4f(i.ndc, 1.0, 1.0);
  let near = G.invViewProj * vec4f(i.ndc, 0.0, 1.0);
  let dir = normalize(far.xyz / far.w - near.xyz / near.w);

  let sun = normalize(G.sunDir.xyz);
  var col = skyRadiance(dir, sun);

  // The solar disc, at its true angular size. Rendering it correctly sized is
  // what gives specular highlights and shadow penumbrae a believable scale.
  let cosAngle = dot(dir, sun);
  let cosRadius = cos(G.sunDir.w);
  if (cosAngle > cosRadius) {
    // Limb darkening: the disc is measurably dimmer toward its edge.
    let r = acos(clamp(cosAngle, -1.0, 1.0)) / G.sunDir.w;
    let limb = pow(max(0.0, 1.0 - r * r), 0.28);
    col += G.sunColor.rgb * G.sunColor.w * 55.0 * limb;
  }
  return vec4f(col, 1.0);
}
