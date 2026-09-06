//!include common.wgsl

// Grass, placed procedurally around the camera rather than from an instance
// buffer.
//
// The field is now several metres across, and a buffer dense enough to carry
// turf over all of it would be tens of millions of blades -- almost all of
// them behind the camera or inside the bokeh. So there is no buffer: the
// instance index is decoded into a cell of a fixed world grid inside a window
// that follows the camera, and the blade's position, height and lean are
// hashed from the cell. Blades therefore stay nailed to the world (they do not
// swim as the bee moves), the cost is constant wherever it flies, and the
// field could be a hundred metres across for the same price.
//
// Thinning is by the lens, not by distance. A blade is about a millimetre wide;
// once the circle of confusion at its distance is several times that, it cannot
// contribute anything an average colour would not, so it is dropped and the
// ground shader's sward texture carries it. Open the aperture and the sward
// thins out early; stop down and it reaches further, which is the correct
// behaviour and falls out of the same rule the flowers use.

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) world   : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) uv      : vec2f,
  @location(3) variant : f32,
  @location(4) viewZ   : f32,
}

struct VIn {
  @location(0) pos    : vec3f,
  @location(1) nrm    : vec3f,
  @location(2) budPos : vec3f,
  @location(3) budNrm : vec3f,
  @location(4) tan    : vec3f,
  @location(5) uv     : vec2f,
  @location(6) params : vec3f,   // axis (0 at root, 1 at tip), stemHeight, variant
}

/** Rodrigues rotation of `p` about a unit `axis`. */
fn rotateAxis(p: vec3f, axis: vec3f, ang: f32) -> vec3f {
  let c = cos(ang);
  let s = sin(ang);
  return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VOut {
  let cellSize = G.field.x;
  let heightScale = G.field.y;
  let across = max(1u, u32(G.field.z));
  let fade = max(0.05, G.field.w);
  let cells = across * across;

  // Blade-major, not cell-major: the instance index walks every cell once
  // before it lays a second blade in any of them. Lowering the draw's instance
  // count therefore thins the whole sward evenly, instead of shearing the
  // window in half.
  let c = ii % cells;
  let b = ii / cells;
  // Window of cells centred on whichever cell the camera is standing in.
  let home = floor(G.cameraPos.xz / cellSize);
  let cellXZ = home + vec2f(f32(c % across), f32(c / across)) - vec2f(f32(across / 2u));

  // Grass grows in tufts, not scattered evenly over the ground: a block of
  // cells shares one anchor point and a chance of carrying no tuft at all, so
  // the sward reads as clumps with soil showing between them rather than a
  // lawn. Blades within a tuft land in a small disc around the anchor -- a
  // real bunchgrass crown is a point, not a patch -- rather than spread
  // across their own cell, which is what turns the per-cell window into a
  // tight bunch instead of a loose scatter.
  let tuftCells = 1.6;
  let tuftCell = floor(cellXZ / tuftCells);
  let tc1 = hash21(tuftCell * 0.913 + vec2f(5.31, 17.07));
  let tc2 = hash21(tuftCell * 1.531 + vec2f(29.71, 3.19));
  let tuftExists = hash21(tuftCell * 2.117 + vec2f(41.03, 61.87)) > 0.32;
  let tuftRadius = cellSize * tuftCells *
    mix(0.06, 0.18, hash21(tuftCell * 3.301 + vec2f(9.41, 71.23)));
  let tuftCentre = (tuftCell * tuftCells + vec2f(tc1, tc2) * tuftCells) * cellSize;

  let h1 = hash21(cellXZ * 1.37 + vec2f(f32(b) * 7.13, f32(b) * 3.71));
  let h2 = hash21(cellXZ * 2.71 + vec2f(f32(b) * 1.93 + 11.0, f32(b) * 5.17));
  let h3 = hash21(cellXZ * 0.83 + vec2f(f32(b) * 9.41 + 31.0, f32(b) * 2.29));
  let h4 = hash21(cellXZ * 1.93 + vec2f(f32(b) * 3.47 + 53.0, f32(b) * 6.61));
  let h5 = hash21(cellXZ * 4.19 + vec2f(f32(b) * 8.03 + 23.0, f32(b) * 1.27));
  // Uniform over the tuft's disc: sqrt(h) so the sample density stays even
  // per unit area instead of piling up at the centre.
  let tuftAng = h4 * 6.28318;
  let tuftRad = tuftRadius * sqrt(h5);
  let base = vec3f(tuftCentre.x + cos(tuftAng) * tuftRad, 0.0,
                    tuftCentre.y + sin(tuftAng) * tuftRad);

  let toCam = base - G.cameraPos.xyz;
  let dist = max(1e-3, length(toCam));

  // --- the two reasons a blade is not drawn -----------------------------
  // Out of the window, and past the point where a blade is finer than the
  // blur. Both collapse the blade to a point rather than branching, so the
  // vertex shader stays uniform and the triangles are culled as degenerate.
  let coc = abs(signedCoC(dist));
  // A blade is well under a millimetre wide. This is its width in pixels,
  // divided by the smallest feature the lens can still separate.
  let widthPx = 0.00035 * G.screen.y / (2.0 * G.cameraPos.w * dist);
  let resolvable = widthPx / (1.0 + coc);
  let keep = clamp(resolvable * 2.2, 0.0, 1.0) * (1.0 - smoothstep(fade * 0.7, fade, dist));
  let alive = select(0.0, 1.0, h3 < keep && tuftExists);

  // Turf grows where the habitat says it does: rank and tall in the damp
  // shelter, short and sparse on the hard-grazed ground.
  let hab = habitatAt(base.xz);
  let vigour = (0.45 + 0.95 * hab.r) * (1.0 - 0.55 * clamp(hab.b, 0.0, 1.0));
  let height = 0.055 * heightScale * vigour * (0.45 + 1.5 * h1) * alive;
  let width = 0.00035 * (0.7 + 0.65 * h2);
  let yaw = h3 * 6.28318;
  let cs = cos(yaw);
  let sn = sin(yaw);

  // Non-uniform scale, so the normal takes the inverse scale before it is
  // renormalised -- scaling a blade thin and tall otherwise tips its normals
  // toward the long axis and the whole field lights wrongly.
  let hh = max(1e-5, height);
  var p = vec3f(v.pos.x * hh, v.pos.y * hh, v.pos.z * width);
  var n = normalize(vec3f(v.nrm.x / hh, v.nrm.y / hh, v.nrm.z / width));

  // Yaw about the vertical.
  p = vec3f(p.x * cs - p.z * sn, p.y, p.x * sn + p.z * cs);
  n = vec3f(n.x * cs - n.z * sn, n.y, n.x * sn + n.z * cs);

  let t = G.windParams.y;
  // The cheap wind: one blade is sampled hundreds of thousands of times a
  // frame, and the fine octaves of the full field are finer than a blade.
  let wind = windAtCheap(base, t);
  let speed = length(wind);

  if (speed > 1e-5) {
    let flat = vec3f(wind.x, 0.0, wind.z);
    let wdir = normalize(flat + vec3f(1e-6, 0.0, 0.0));
    // Bend about the horizontal axis square to the wind, so the blade lies
    // over downwind rather than twisting.
    let axis = normalize(cross(vec3f(0.0, 1.0, 0.0), wdir));
    // Cantilever: a blade clamped at the root bends with the square of the
    // distance along it, which is why grass curls over at the tip and stays
    // stiff at the base.
    let u = v.params.x;
    // Subtracting the projection of the base position onto the wind gives the
    // travelling phase, so gusts visibly cross the field instead of every
    // blade beating together.
    let phase = t * 7.0 - dot(base, wdir) * 9.0 + h1 * 6.283;
    // Clamped: at the top of the wind slider the raw bend reaches about a
    // hundred degrees and lays the sward flat through itself.
    let ang = clamp(speed * 0.55 + sin(phase) * speed * 0.22, -1.1, 1.1) * u * u;
    p = rotateAxis(p, axis, ang);
    n = rotateAxis(n, axis, ang);
  }

  let world = base + p;
  var o: VOut;
  o.world = world;
  o.nrm = n;
  o.uv = v.uv;
  o.variant = h1;
  o.clip = G.viewProj * vec4f(world, 1.0);
  o.viewZ = -(G.view * vec4f(world, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  var N = normalize(i.nrm);
  if (!facing) { N = -N; }

  let V = normalize(G.cameraPos.xyz - i.world);
  let L = normalize(G.sunDir.xyz);
  let H = normalize(L + V);
  let ndl = dot(N, L);
  let ndv = max(1e-4, dot(N, V));
  let sun = G.sunColor.rgb * G.sunColor.w;

  // Per-blade colour variation, and a darker, yellower base where light does
  // not reach into the sward. The wet end of the habitat runs bluer and the
  // grazed end runs strawy, so the blades agree with the ground under them.
  let hab = habitatAt(i.world.xz);
  let tint = fract(i.variant * 7.31);
  var albedo = mix(vec3f(0.055, 0.115, 0.028), vec3f(0.105, 0.165, 0.042), tint);
  albedo = mix(albedo * vec3f(1.25, 0.95, 0.60), albedo, smoothstep(0.2, 0.7, hab.r));
  albedo = mix(albedo * vec3f(0.72, 0.78, 0.55), albedo, smoothstep(0.0, 0.45, i.uv.y));
  // Tips dry out and pale off.
  albedo = mix(albedo, vec3f(0.20, 0.19, 0.085), smoothstep(0.80, 1.0, i.uv.y) * 0.5);

  let shade = shadowFactor(i.world, ndl);

  let wrap = 0.25;
  let diff = max(0.0, (ndl + wrap) / (1.0 + wrap));
  var color = albedo * sun * diff * shade / PI;

  // A blade is a thin membrane like any other lamina: backlit grass glows,
  // and at low sun that glow is most of what you see of a field.
  let thickness = 0.85 - 0.35 * smoothstep(0.0, 0.5, i.uv.y);
  let trans = translucency(L, V, N, thickness, 3.0, 0.30);
  color += sun * trans * vec3f(0.42, 0.68, 0.20) * albedo * 3.2 * mix(0.4, 1.0, shade);

  // The keel gives each blade one hard specular line down its length.
  let rough = 0.30;
  let D = distributionGGX(max(0.0, dot(N, H)), rough);
  let Gv = smithGGX(ndv, max(0.0, ndl), rough);
  let F = fresnelSchlick(vec3f(0.045), max(0.0, dot(V, H)));
  color += sun * shade * max(0.0, ndl) * D * Gv * F / max(1e-4, 4.0 * ndv * max(1e-4, ndl));

  // Ambient, with a crude vertical occlusion: the base of the sward is buried.
  let occlusion = mix(0.35, 1.0, smoothstep(0.0, 0.55, i.uv.y));
  color += albedo * skyAmbient(N) * occlusion;

  return vec4f(aerial(color, i.viewZ, -V, L), 1.0);
}
