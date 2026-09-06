// Per-plant and per-visible-instance data. Struct-only, like stem.wgsl: the
// solver binds the plant table read-only alongside a writable stem chain, and
// the draw passes bind it beside a read-only one, so the bindings themselves
// cannot be shared.

/**
 * One plant in the field. Everything that makes this individual this
 * individual -- where it stands, how tall it grew, how far through flowering
 * it is, what pigments its rays carry -- lives here, so the meshes are shared
 * by species and nothing is baked per plant.
 */
struct PlantInstance {
  base     : vec4f,   // xyz base position on the ground, w = uniform scale
  axis     : vec4f,   // xyz rest axis of the stem (unit; leaning), w = stem height (m)
  orient   : vec4f,   // x = cos(yaw), y = sin(yaw), z = head radius, w = disc radius
  phase    : vec4f,   // x = bloom, y = floret front, z = variant, w = ray count
  florets  : vec4f,   // x = floret base index, y = floret count, z = species, w = wind gain
  rayCol   : vec4f,   // rgb ray floret albedo, w = nectar-guide strength
  tipCol   : vec4f,   // rgb ray tip / margin albedo, w = how far the tip tint reaches
  discCol  : vec4f,   // rgb mature disc albedo, w = pollen load 0..1
  leafCol  : vec4f,   // rgb foliage albedo, w = senescence
  transmit : vec4f,   // rgb ray transmission, w = leaf transmission scale
}

/**
 * One entry of the per-frame draw list, written by render/lod.js.
 *
 * `sharp` is the whole LOD idea handed to the fragment stage: it is the
 * resolvable-feature count normalised to 0..1, so multiplying any procedural
 * micro-detail by it makes that detail fade out on exactly the schedule the
 * geometry coarsens on -- and, because the count is divided by the circle of
 * confusion, on exactly the schedule the lens is erasing it anyway.
 */
struct Visible {
  plant : u32,
  tier  : u32,   // 0 finest mesh, 1 mid, 2 coarse, 3 impostor
  sharp : f32,   // 0..1 resolvable detail, after the blur
  coc   : f32,   // circle of confusion at this plant, in pixels
}

/** Rotate a plant-local offset about the plant's own vertical axis. */
fn plantYaw(p: PlantInstance, v: vec3f) -> vec3f {
  let c = p.orient.x;
  let s = p.orient.y;
  return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}
