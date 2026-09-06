//!include common.wgsl
//!include stem.wgsl

// Wind field + stem solver + landing-site publication, all on the GPU.
//
// The whole point of solving the plant here is that the CPU never needs the
// geometry back. The only thing that crosses back is the LandingSite buffer,
// which is tiny and is what the flight code queries instead of colliding
// against triangles.

@group(1) @binding(0) var<storage, read_write> stemNodes : array<StemNode>;
@group(1) @binding(1) var<storage, read_write> landing   : array<LandingSite>;

var<workgroup> wsPos : array<vec3f, STEM_NODES>;

@compute @workgroup_size(16)
fn solveStem(@builtin(local_invocation_id) lid: vec3u) {
  // No early return: the workgroup size equals STEM_NODES exactly, and a
  // conditional return here would put every workgroupBarrier below into
  // non-uniform control flow.
  let i = lid.x;
  let restH = f32(i) / f32(STEM_NODES - 1u);
  let segLen = G.plant.y;

  // EXACTLY one step per frame, of the length the host hands us in state.w.
  //
  // Two rules, both learned the hard way and both checked by tools/sim-stem.mjs:
  //
  // Never more than one step. The step COUNT used to come from the
  // instantaneous frame time, rounded -- so a hitch (a GC pause, a texture
  // upload, a tab regaining focus) spent two or three steps in a single frame
  // and the whole head lurched. Measured offline, the tip's frame-to-frame
  // movement went 0.13mm -> 1.03mm on exactly those frames, which is the jump
  // you could see. Falling a few ms behind the wall clock is invisible; the
  // lurch is not.
  //
  // Never a step that moves. Verlet's `pos - prev` is a velocity that assumes
  // the last step was as long as this one, so a step driven by the raw frame
  // time explodes -- 49mm per frame, buzzing at 9.5Hz, even with the standard
  // dt/dtPrev correction, because the constraint projection breaks the
  // invariant that correction relies on. The host therefore snaps the step to
  // a standard refresh interval and holds it there. The same step drives the
  // pollen and advances windParams.y, so nothing in the scene runs on a
  // different clock from the plant it is blowing through.
  let h = G.state.w;

  var node = stemNodes[i];
  var pos = node.pos.xyz;
  var prev = node.prev.xyz;

  // --- integrate -------------------------------------------------------
  if (i > 0u) {
    let drag = windAt(pos, G.windParams.y);
    // Thin stems catch wind roughly with the square of height: more lever
    // arm and more exposed area away from the ground.
    let expose = restH * restH;
    let accel = drag * 12.0 * expose + vec3f(0.0, -9.81, 0.0) * 0.045;
    let vel = (pos - prev) * 0.96;
    let next = pos + vel + accel * h * h;
    prev = pos;
    pos = next;
  }
  wsPos[i] = pos;
  workgroupBarrier();

  // --- constraint solve -------------------------------------------------
  for (var iter = 0; iter < 8; iter++) {
    // Pinning node 1 as well as node 0 anchors the base DIRECTION, not just
    // its position. Without it the chain is a rope hanging from a point:
    // gravity rotates the whole thing about the root and the stem folds flat
    // to the ground, which is exactly what it did.
    if (i == 0u) { wsPos[0] = vec3f(0.0, 0.0, 0.0); }
    if (i == 1u) { wsPos[1] = vec3f(0.0, segLen, 0.0); }
    workgroupBarrier();

    // Distance constraints, red/black split so neighbours never fight over
    // the same node inside one pass.
    for (var parity = 0u; parity < 2u; parity++) {
      if (i >= 2u && (i % 2u) == parity) {
        let a = wsPos[i - 1u];
        let d = wsPos[i] - a;
        let l = max(1e-6, length(d));
        wsPos[i] = a + d * (segLen / l);
      }
      workgroupBarrier();
    }

    // Bending. The target blends the straight continuation of the parent
    // segment with the rest pose, so the stem remembers being upright rather
    // than merely remembering being straight -- a straight stem lying flat
    // satisfies a pure straightness constraint perfectly well.
    if (i >= 2u) {
      let a = wsPos[i - 2u];
      let b = wsPos[i - 1u];
      let d = b - a;
      let cont = d / max(1e-6, length(d));
      let mixed = mix(cont, vec3f(0.0, 1.0, 0.0), 0.10);
      let straight = b + normalize(mixed) * segLen;
      wsPos[i] = mix(wsPos[i], straight, 0.28);
    }
    workgroupBarrier();
  }

  pos = wsPos[i];
  workgroupBarrier();

  node.pos = vec4f(pos, restH);
  node.prev = vec4f(prev, 0.0);
  stemNodes[i] = node;
  // storageBarrier, not workgroupBarrier: the latter orders workgroup memory
  // only, so thread 0's frame writes below could be clobbered by another
  // thread's whole-struct write above, leaving the axis stale or garbage --
  // and a zero axis normalises to NaN, which silently deletes the plant.
  storageBarrier();
  workgroupBarrier();

  // --- frames by parallel transport --------------------------------------
  // Serial on one thread: 16 nodes, and transporting a reference vector along
  // the chain is what stops the frame from spinning about the stem axis.
  if (i == 0u) {
    var refDir = vec3f(1.0, 0.0, 0.0);
    for (var k = 0u; k < STEM_NODES; k++) {
      // Guard the normalise: two coincident nodes give a zero vector, and the
      // resulting NaN propagates through every vertex skinned to this frame,
      // scattering the whole plant. Cheap insurance against a solver hiccup.
      var seg: vec3f;
      if (k + 1u < STEM_NODES) { seg = wsPos[k + 1u] - wsPos[k]; }
      else { seg = wsPos[k] - wsPos[k - 1u]; }
      var axis = vec3f(0.0, 1.0, 0.0);
      if (length(seg) > 1e-7) { axis = normalize(seg); }
      var side = refDir - axis * dot(refDir, axis);
      if (length(side) < 1e-4) { side = vec3f(0.0, 0.0, 1.0) - axis * dot(vec3f(0.0, 0.0, 1.0), axis); }
      side = normalize(side);
      refDir = side;
      stemNodes[k].axis = vec4f(axis, 0.0);
      stemNodes[k].side = vec4f(side, 0.0);
    }

    // Publish the landing pad on the flower head.
    let top = stemNodes[STEM_NODES - 1u];
    var site: LandingSite;
    site.pos = vec4f(top.pos.xyz, 0.011);
    site.normal = vec4f(top.axis.xyz, 1.0 - G.state.y);
    // Pad velocity, for a lander to match: derived from the same step the
    // solve actually used, not the frame time.
    site.velocity = vec4f((top.pos.xyz - top.prev.xyz) / max(1e-6, h), 0.0);
    // The side vector completes the frame: with it the host can reconstruct
    // the head's full orientation and put a crawl surface on it that sways
    // with the flower, without duplicating the solve on the CPU.
    site.side = vec4f(top.side.xyz, 0.0);
    landing[0] = site;
  }
}
