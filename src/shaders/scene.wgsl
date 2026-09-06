//!include common.wgsl
//!include stem.wgsl
//!include instance.wgsl

// Read-only view of the field: every plant's solved stem, every plant's
// parameters, and this frame's draw list. Every pass that draws a plant binds
// exactly this group, which is why the shadow pass cannot fall out of step
// with the main pass -- they are reading the same three buffers.

@group(1) @binding(0) var<storage, read> stemNodes : array<StemNode>;
@group(1) @binding(1) var<storage, read> plants    : array<PlantInstance>;
@group(1) @binding(2) var<storage, read> visible   : array<Visible>;

struct Frame { origin: vec3f, x: vec3f, y: vec3f, z: vec3f }

/**
 * Interpolated stem frame of plant `pid` at normalised height h.
 *
 * Chains are packed back to back, STEM_NODES apart, so a plant index is a
 * stride rather than a separate buffer. That is what lets one dispatch solve
 * the whole meadow and one draw skin any subset of it.
 */
fn stemFrame(pid: u32, h: f32) -> Frame {
  let t = clamp(h, 0.0, 1.0) * f32(STEM_NODES - 1u);
  let i = min(u32(floor(t)), STEM_NODES - 2u);
  let f = t - f32(i);
  let o = pid * STEM_NODES;
  let a = stemNodes[o + i];
  let b = stemNodes[o + i + 1u];

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
 * Secondary motion for a lamina -- a petal or a leaf blade -- hinged at its
 * attachment.
 *
 * This used to be a private oscillator per element: a random phase AND a random
 * frequency, displacing along a fixed Lissajous curve in world space. Every
 * petal therefore drifted in and out of step with its neighbours forever and
 * swirled in a little ellipse, which reads as amoeboid rather than windblown.
 *
 * Now it samples the same wind field the stem integrates, so a gust that bends
 * the stem also lifts the petals it carries. Three things make it read as one
 * flower rather than N independent objects:
 *   - a single oscillator shared by every lamina, so they beat together;
 *   - a phase delay by azimuth, so the gust sweeps around the head instead of
 *     striking all of it at once;
 *   - displacement along the head's own up axis, so petals flap about their
 *     attachment rather than orbiting.
 * The per-element variant survives only as a small phase nudge, which keeps it
 * from looking mechanical without decoupling anything. Across the field the
 * gust front is shared too, so neighbouring plants flex in sequence.
 */
fn laminaFlex(fr: Frame, local: vec3f, axis: f32, variant: f32, scale: f32) -> vec3f {
  if (axis <= 0.0) { return vec3f(0.0); }
  // The simulation clock, not wall time. Nothing here is integrated -- the
  // offset is read straight off `t` -- so the petal goes exactly where the
  // clock says, instantly and at full amplitude. Driven by wall time a 50ms
  // frame moved every petal at once by 4.6x its usual step, which is the jump
  // you could see in a gust; on the solver's own step there is no such frame.
  let t = G.windParams.y;
  let wind = windAt(fr.origin, t);
  let speed = length(wind);
  if (speed < 1e-5) { return vec3f(0.0); }
  let wdir = wind / speed;

  // Radial direction of this point within the lamina's own plane.
  let radial = local - fr.y * dot(local, fr.y);
  let rl = length(radial);
  var outward = fr.x;
  if (rl > 1e-6) { outward = radial / rl; }

  // How square-on this lamina sits to the gust. The windward side presses
  // down and the leeward side lifts, which is why a flag flies rather than
  // flapping symmetrically about its pole.
  let facing = dot(outward, wdir);

  let phase = t * 6.5 - facing * 2.2 + variant * 1.1;
  // Steady lean plus flutter, both riding the same gust.
  let bend = (facing * 0.6 + sin(phase) * 0.4) * speed;
  // Measured 8.5mm of tip travel at 0.0075, which is a third of a petal's
  // length; 0.0055 lands near 6mm -- still clearly alive, no longer flailing.
  return fr.y * bend * axis * axis * 0.0055 * scale;
}

/**
 * Place a plant vertex in the world.
 *
 * The mesh stores an OFFSET from the point on the stem the part hangs off,
 * plus that point's normalised height, so this is: look the frame up on the
 * plant's own solved chain, turn the offset by the plant's yaw, scale it by
 * the plant's vigour, and rotate it into the frame. Nothing about the plant's
 * height, lean or position is in the mesh, which is why six meshes serve
 * several hundred plants.
 */
fn skinToPlant(P: PlantInstance, pid: u32, offset: vec3f, nrm: vec3f, tan: vec3f,
               stemH: f32, axis: f32, variant: f32) -> Skinned {
  let fr = stemFrame(pid, stemH);
  let scale = P.base.w;
  let local = plantYaw(P, offset) * scale;

  var out: Skinned;
  out.pos = fr.origin + frameApply(fr, local);
  out.nrm = normalize(frameApply(fr, plantYaw(P, nrm)));
  out.tan = normalize(frameApply(fr, plantYaw(P, tan)));
  out.pos += laminaFlex(fr, local, axis, variant, scale);
  return out;
}
