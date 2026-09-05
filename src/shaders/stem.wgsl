// Stem chain data shared by the wind solver and everything skinned to it.
// Struct-only: each shader declares its own binding with the access mode it
// needs (the solver writes, the vertex stages read).

struct StemNode {
  pos   : vec4f,   // xyz world position, w = rest height 0..1
  prev  : vec4f,   // xyz previous position (Verlet), w unused
  axis  : vec4f,   // xyz frame Y, along the stem
  side  : vec4f,   // xyz frame X
}

/**
 * A place the bee can land. Written by the same compute pass that solves the
 * stem, so it can never drift out of sync with the geometry that sways -- this
 * is the whole collision system for landing: a small database, not a mesh.
 */
struct LandingSite {
  pos      : vec4f,   // xyz world position, w = radius
  normal   : vec4f,   // xyz surface normal, w = nectar 0..1
  velocity : vec4f,   // xyz world velocity of the pad, w = occupied flag
}

const STEM_NODES : u32 = 16u;
