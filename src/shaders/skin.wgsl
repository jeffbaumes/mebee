//!include common.wgsl
//!include stem.wgsl

// Read-only view of the solved stem, plus the skinning every plant part uses.

@group(1) @binding(0) var<storage, read> stemNodes : array<StemNode>;

struct Frame { origin: vec3f, x: vec3f, y: vec3f, z: vec3f }

/** Interpolated stem frame at normalised height h (0 = ground, 1 = head). */
fn stemFrame(h: f32, stemHeight: f32) -> Frame {
  let t = clamp(h, 0.0, 1.0) * f32(STEM_NODES - 1u);
  let i = min(u32(floor(t)), STEM_NODES - 2u);
  let f = t - f32(i);
  let a = stemNodes[i];
  let b = stemNodes[i + 1u];

  var fr: Frame;
  fr.origin = mix(a.pos.xyz, b.pos.xyz, f);
  fr.y = normalize(mix(a.axis.xyz, b.axis.xyz, f));
  var x = mix(a.side.xyz, b.side.xyz, f);
  // Re-orthogonalise: the lerp of two frames is not itself orthonormal, and
  // letting the error through shears every normal skinned by it.
  x = normalize(x - fr.y * dot(x, fr.y));
  fr.x = x;
  fr.z = cross(fr.x, fr.y);
  return fr;
}

/** Rotate a rest-space offset into the bent stem's frame. */
fn frameApply(fr: Frame, v: vec3f) -> vec3f {
  return fr.x * v.x + fr.y * v.y + fr.z * v.z;
}

struct Skinned { pos: vec3f, nrm: vec3f, tan: vec3f }

/**
 * Bend a plant vertex with the stem.
 *
 * The mesh is authored against a straight canonical stem, so the offset from
 * that rest axis is what gets rotated into the solved frame. `flutter` adds
 * the part's own secondary motion -- a leaf blade twists in a gust well before
 * the stem it hangs off does.
 */
fn skinToStem(restPos: vec3f, nrm: vec3f, tan: vec3f,
              stemH: f32, axis: f32, stemHeight: f32, variant: f32) -> Skinned {
  let fr = stemFrame(stemH, stemHeight);
  let restAxis = vec3f(0.0, stemH * stemHeight, 0.0);
  let local = restPos - restAxis;

  var out: Skinned;
  out.pos = fr.origin + frameApply(fr, local);
  out.nrm = normalize(frameApply(fr, nrm));
  out.tan = normalize(frameApply(fr, tan));

  // Secondary flutter, scaled by how far the point is from its attachment.
  let t = G.windParams.y;
  let strength = G.windParams.x;
  let phase = variant * 43.0 + t * (2.7 + variant * 1.4);
  let amp = strength * 0.010 * axis * axis;
  let wobble = vec3f(sin(phase), sin(phase * 1.37 + 1.1) * 0.45, cos(phase * 0.91));
  out.pos += wobble * amp;
  return out;
}
