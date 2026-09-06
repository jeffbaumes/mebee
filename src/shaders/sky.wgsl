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

  // Ground beyond the disc ground.wgsl actually tessellates. That disc reaches
  // sixty metres, by which point the aerial perspective has taken it almost
  // entirely to the horizon colour, so this only has to agree with it in the
  // last few per cent -- which it does by mixing the same three tones over the
  // same habitat map. Single-scattering returns near zero below the horizon,
  // so without something here the lower half of the frame is black.
  if (dir.y < -0.0015) {
    let dist = max(0.0, G.cameraPos.y) / max(1e-4, -dir.y);
    let hit = G.cameraPos.xyz + dir * dist;
    let hab = habitatAt(hit.xz);
    let coarse = fbm3(vec3f(hit.x * 3.5, 5.0, hit.z * 3.5), 2);
    var albedo = mix(vec3f(0.098, 0.104, 0.042), vec3f(0.052, 0.108, 0.030),
                     smoothstep(0.25, 0.75, hab.r));
    albedo = mix(albedo, vec3f(0.085, 0.062, 0.040), clamp(hab.b * 0.55, 0.0, 0.5));
    albedo *= 0.72 + 0.56 * coarse;
    let up = vec3f(0.0, 1.0, 0.0);
    let lit = albedo * (max(0.0, dot(up, sun)) * G.sunColor.rgb * G.sunColor.w / PI
                        + skyAmbient(up));
    // The same aerial term the ground disc uses, so the two meet without a
    // seam where one hands over to the other.
    col = aerial(lit, dist, dir, sun);
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
