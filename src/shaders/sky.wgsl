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

  // Ground. Single-scattering returns near zero below the horizon, so without
  // this the lower half of the frame is black -- fine for an orbit view of a
  // flower against sky, useless the moment you can fly down to it.
  if (dir.y < -0.0015) {
    let dist = max(0.0, G.cameraPos.y) / max(1e-4, -dir.y);
    let hit = G.cameraPos.xyz + dir * dist;
    let mottle = fbm3(vec3f(hit.x * 26.0, 0.0, hit.z * 26.0), 3);
    let coarse = fbm3(vec3f(hit.x * 3.5, 5.0, hit.z * 3.5), 2);
    let albedo = mix(vec3f(0.050, 0.072, 0.026), vec3f(0.105, 0.130, 0.048),
                     mottle * 0.65 + coarse * 0.35);
    let up = vec3f(0.0, 1.0, 0.0);
    let lit = albedo * (max(0.0, dot(up, sun)) * G.sunColor.rgb * G.sunColor.w / PI
                        + skyAmbient(up));
    // Aerial perspective: the ground dissolves into the horizon with distance
    // rather than meeting the sky at a hard line.
    let horizon = skyRadiance(normalize(vec3f(dir.x, 0.025, dir.z)), sun);
    col = mix(lit, horizon, 1.0 - exp(-dist * 1.4));
  }

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
