//!include common.wgsl

// Where the sward is, decided once per blade.
//
// grass.wgsl used to work out everything about a blade -- which cell of the
// world grid it belongs to, which tuft, whether that tuft exists, how vigorous
// the habitat is there, how long and how wide and which way it leans, and how
// far the wind has laid it over -- inside the VERTEX shader. A blade has
// twenty-seven vertices, so every one of those answers was computed
// twenty-seven times and thrown away twenty-six. With thirty-six thousand
// candidate blades that is a million vertex invocations a frame, each doing
// ten hashes, a habitat fetch and two lattice noises, to draw a sward of which
// the lens throws most away.
//
// So the decision moved here: one thread per candidate blade, and the ones
// that survive are appended to a packed buffer that the draw reads through an
// indirect instance count. The vertex shader is left with a matrix and a
// scale. What this buys is not only the frame it saves now -- it is that the
// blade count and the vertex cost have come apart, so a denser sward, or a
// second storey of taller grasses, costs a compute thread each rather than
// twenty-seven vertex invocations each.

/**
 * One surviving blade. Must match struct Blade in grass.wgsl.
 *
 * Two columns of the blade's frame, not three: it is a rotation, so the third
 * is their cross product and costs less to recompute than to fetch. The wind
 * cannot go into the frame at all -- a blade bends with the SQUARE of the
 * distance along it, which is a different rotation at every vertex -- so what
 * is stored is the axis it bends about and the angle at the tip.
 */
struct Blade {
  base : vec4f,   // xyz world position of the crown, w = arc length
  e0   : vec4f,   // frame column 0 (lean then yaw), w = half-width
  e1   : vec4f,   // frame column 1, w = variant hash
  wind : vec4f,   // xyz bend axis, w = bend angle at the tip
}

/**
 * Indirect draw arguments, in WebGPU's drawIndexedIndirect order. Only the
 * instance count is written here; the renderer fills the rest once.
 */
struct DrawArgs {
  indexCount    : u32,
  instanceCount : atomic<u32>,
  firstIndex    : u32,
  baseVertex    : i32,
  firstInstance : u32,
}

struct CullParams {
  /** Candidate blades to consider: cells across squared, times the layers. */
  candidates : u32,
  // Three scalars, not a vec3u: a vec3 aligns to sixteen bytes, which would
  // push the struct to thirty-two and make the sixteen-byte buffer too small.
  pad0 : u32,
  pad1 : u32,
  pad2 : u32,
}

@group(1) @binding(0) var<storage, read_write> blades : array<Blade>;
@group(1) @binding(1) var<storage, read_write> draw   : DrawArgs;
@group(1) @binding(2) var<uniform> C : CullParams;

const BLADE_WIDTH = 0.0018;

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) gid: vec3u) {
  let ii = gid.x;
  if (ii >= C.candidates) { return; }

  let cellSize = G.field.x;
  let heightScale = G.field.y;
  let across = max(1u, u32(G.field.z));
  let fade = max(0.05, G.field.w);
  let cells = across * across;

  // Blade-major, not cell-major: the candidate index walks every cell once
  // before it lays a second blade in any of them. Lowering the count therefore
  // thins the whole sward evenly, instead of shearing the window in half.
  let c = ii % cells;
  let b = ii / cells;
  // Window of cells centred on whichever cell the camera is standing in.
  let home = floor(G.cameraPos.xz / cellSize);
  let cellXZ = home + vec2f(f32(c % across), f32(c / across)) - vec2f(f32(across / 2u));

  // Grass grows in tufts, not scattered evenly over the ground: a block of
  // cells shares one anchor point and a chance of carrying no tuft at all, so
  // the sward reads as clumps with soil showing between them rather than a
  // lawn. Blades within a tuft land in a small disc around the anchor -- a
  // real bunchgrass crown is a point, not a patch.
  let tuftCells = 1.6;
  let tuftCell = floor(cellXZ / tuftCells);
  let tc1 = hash21(tuftCell * 0.913 + vec2f(5.31, 17.07));
  let tc2 = hash21(tuftCell * 1.531 + vec2f(29.71, 3.19));
  let tuftExists = hash21(tuftCell * 2.117 + vec2f(41.03, 61.87)) > 0.14;
  let tuftRadius = cellSize * tuftCells *
    mix(0.12, 0.34, hash21(tuftCell * 3.301 + vec2f(9.41, 71.23)));
  let tuftCentre = (tuftCell * tuftCells + vec2f(tc1, tc2) * tuftCells) * cellSize;

  let h1 = hash21(cellXZ * 1.37 + vec2f(f32(b) * 7.13, f32(b) * 3.71));
  let h2 = hash21(cellXZ * 2.71 + vec2f(f32(b) * 1.93 + 11.0, f32(b) * 5.17));
  let h3 = hash21(cellXZ * 0.83 + vec2f(f32(b) * 9.41 + 31.0, f32(b) * 2.29));
  let h4 = hash21(cellXZ * 1.93 + vec2f(f32(b) * 3.47 + 53.0, f32(b) * 6.61));
  let h5 = hash21(cellXZ * 4.19 + vec2f(f32(b) * 8.03 + 23.0, f32(b) * 1.27));
  let h6 = hash21(cellXZ * 5.77 + vec2f(f32(b) * 2.11 + 67.0, f32(b) * 4.83));
  let h7 = hash21(cellXZ * 3.11 + vec2f(f32(b) * 6.29 + 89.0, f32(b) * 7.41));
  // Uniform over the tuft's disc: sqrt(h) so the sample density stays even
  // per unit area instead of piling up at the centre.
  let tuftAng = h4 * 6.28318;
  let tuftRad = tuftRadius * sqrt(h5);
  let base = vec3f(tuftCentre.x + cos(tuftAng) * tuftRad, 0.0,
                   tuftCentre.y + sin(tuftAng) * tuftRad);

  let dist = max(1e-3, length(base - G.cameraPos.xyz));

  // --- the two reasons a blade is not drawn -----------------------------
  // Out of the window, and past the point where a blade is finer than the
  // blur. Both used to collapse the blade to a degenerate point, because a
  // vertex shader has nowhere to put "no". A compute thread does: it simply
  // does not append, and the blade costs no vertices and no triangles at all.
  let coc = abs(signedCoC(dist));
  // The blade's width in pixels, divided by the smallest feature the lens can
  // still separate.
  let widthPx = BLADE_WIDTH * G.screen.y / (2.0 * G.cameraPos.w * dist);
  let resolvable = widthPx / (1.0 + coc);
  let keep = clamp(resolvable * 2.2, 0.0, 1.0) * (1.0 - smoothstep(fade * 0.7, fade, dist));
  // h6, not h3. h3 is this blade's yaw, and drawing the survival lottery
  // against it meant the survivors were exactly the blades whose yaw was
  // small: as the sward thinned with distance it also swung round to face one
  // way, so a thinning tuft combed itself flat instead of just losing blades.
  if (!(h6 < keep && tuftExists)) { return; }

  // Turf grows where the habitat says it does: rank in the damp shelter,
  // short and sparse on the hard-grazed ground.
  let hab = habitatAt(base.xz);
  let vigour = (0.45 + 0.95 * hab.r) * (1.0 - 0.55 * clamp(hab.b, 0.0, 1.0));
  // ARC LENGTH along the blade, not height: the blade arches over (see
  // geom/grass.js), so it stands up about half of this and reaches about
  // two-thirds of it out across the ground. 45mm of blade is therefore a
  // sward a couple of centimetres deep, which is what short turf is.
  let bladeLen = max(1e-5, 0.045 * heightScale * vigour * (0.45 + 1.3 * h1));
  let width = BLADE_WIDTH * (0.7 + 0.65 * h2);
  let yaw = h3 * 6.28318;
  let cs = cos(yaw);
  let sn = sin(yaw);
  // How far from vertical the blade leaves the crown. The mesh's own arc
  // already carries it over past horizontal by the tip; this is what makes it
  // set off sideways in the first place, which is the difference between turf
  // that lies along the ground and a tuft of upright spikes with curled ends.
  // h7, not h4: h4 is where in the tuft this blade sits, and leaning on it
  // would have every blade on one side of a crown lean by the same amount.
  let tilt = mix(0.45, 1.05, h7);
  let tc = cos(tilt);
  let ts = sin(tilt);

  // The blade's frame: the standard axes carried through the two rotations the
  // vertex shader used to apply to every vertex -- lean about the blade's own
  // across axis (z, the plane its arc already bends in, so the lean deepens
  // the arc rather than twisting it), then yaw about the vertical. The third
  // column is z, which the lean leaves alone because the lean is ABOUT z.
  var e0 = vec3f(tc, -ts, 0.0);
  var e1 = vec3f(ts, tc, 0.0);
  var e2 = vec3f(0.0, 0.0, 1.0);
  e0 = vec3f(e0.x * cs - e0.z * sn, e0.y, e0.x * sn + e0.z * cs);
  e1 = vec3f(e1.x * cs - e1.z * sn, e1.y, e1.x * sn + e1.z * cs);
  e2 = vec3f(e2.x * cs - e2.z * sn, e2.y, e2.x * sn + e2.z * cs);
  // e2 is recomputed in the vertex shader as cross(e0, e1), which is exact
  // here because all three came from a rotation of a right-handed basis.

  let t = G.windParams.y;
  // The cheap wind: the fine octaves of the full field are finer than a blade.
  let wind = windAtCheap(base, t);
  let speed = length(wind);
  var bendAxis = vec3f(0.0, 1.0, 0.0);
  var bendAngle = 0.0;
  if (speed > 1e-5) {
    let flat = vec3f(wind.x, 0.0, wind.z);
    let wdir = normalize(flat + vec3f(1e-6, 0.0, 0.0));
    // Bend about the horizontal axis square to the wind, so the blade lies
    // over downwind rather than twisting.
    bendAxis = normalize(cross(vec3f(0.0, 1.0, 0.0), wdir));
    // Subtracting the projection of the base position onto the wind gives the
    // travelling phase, so gusts visibly cross the field instead of every
    // blade beating together.
    let phase = t * 7.0 - dot(base, wdir) * 9.0 + h1 * 6.283;
    // Ground turf barely moves. It is short, it is already lying down, and
    // every blade around it shelters it -- a lawn in a gust ripples, it does
    // not thrash. This is the angle at the TIP; the cantilever that takes it
    // to zero at the root is per-vertex and stays in grass.wgsl.
    bendAngle = clamp(speed * 0.16 + sin(phase) * speed * 0.07, -0.40, 0.40);
  }

  // The append. The bound check is not paranoia: the buffer is sized for every
  // candidate, so it can only trip if the two sizes drift apart -- and an
  // out-of-bounds store would be a silently corrupted frame rather than a
  // missing blade.
  let slot = atomicAdd(&draw.instanceCount, 1u);
  if (slot >= arrayLength(&blades)) { return; }
  blades[slot] = Blade(
    vec4f(base, bladeLen),
    vec4f(e0, width),
    vec4f(e1, h1),
    vec4f(bendAxis, bendAngle),
  );
}
