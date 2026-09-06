//!include scene.wgsl

// The far field: every flower the lens can no longer resolve, as two
// triangles.
//
// This is where the blur pays for itself. render/lod.js hands a plant here
// once the projected diameter divided by the circle of confusion drops below
// about four -- meaning the image cannot distinguish four features across the
// whole head, however many pixels it happens to cover. A head in that state is
// a coloured smudge with a darker middle and a hint of a star, and that is
// exactly what this draws: an oriented ellipse (a flat capitulum foreshortens,
// so a billboard would read as a sphere), tinted from the plant's own pigments,
// with the ray-star modulation faded out by the same `sharp` number.
//
// Two things keep it honest rather than cheap:
//
//   * It writes depth. A blob that did not would inherit whatever is behind it
//     for the defocus pass and be blurred by the wrong amount. Writing the
//     head's real depth means dof.wgsl gives it precisely the bokeh the lens
//     would give the geometry it replaced.
//   * It conserves energy. Below about a pixel across, the quad is widened to
//     stay rasterisable and the radiance is scaled down by the area it gained,
//     so a distant flower dims as it shrinks instead of flickering at whatever
//     brightness one pixel happened to sample. That is what a defocused point
//     source actually does, and it is why the far field does not crawl.

struct VOut {
  @builtin(position) clip : vec4f,
  @location(0) local   : vec2f,   // -1..1 across the quad
  @location(1) world   : vec3f,
  @location(2) axis    : vec3f,   // the head's own normal
  @location(3) @interpolate(flat) vid : u32,
  @location(4) coverage : f32,    // energy scale after the minimum-size widen
  @location(5) viewZ   : f32,
  @location(6) outward : vec3f,   // world direction from the head's centre
}

// Vertices per blob. A normal head is one billboard, six vertices; a species
// with no ray whorl at all -- clover, whose real flower is a bud smaller than
// a pixel at any distance that matters -- gets three, fanned the way its
// trefoil is (see the leaflet fan-out below).
const BLOB_VERTS = 6u;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let vis = visible[ii];
  let P = plants[vis.plant];
  let top = stemNodes[vis.plant * STEM_NODES + STEM_NODES - 1u];
  let axis = normalize(top.axis.xyz + vec3f(0.0, 1e-5, 0.0));
  let fullRadius = max(1e-5, P.orient.z * P.base.w);

  // headRadius (species.js) reports the LEAF's reach for a species with no ray
  // whorl, not the bud's -- so the radius this file already gets for clover is
  // the trefoil's own footprint. Three leaf-tinted blobs fanned around the hub
  // read as the leaf they stand in for; one flower-tinted ellipse across the
  // whole footprint (what this used to draw) reads as a pale smear, because it
  // is coloured and sized as if the bud were the thing worth seeing.
  let leafletSpecies = P.phase.w < 0.5;
  let leaflet = vi / BLOB_VERTS;

  let corner = array(vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0),
                     vec2f(-1.0, 1.0), vec2f(1.0,-1.0), vec2f( 1.0,1.0));
  var c = corner[vi % BLOB_VERTS];

  var centre = top.pos.xyz;
  var radius = fullRadius;
  if (leafletSpecies) {
    // Three leaflets, evenly fanned with a little per-plant jitter so a patch
    // does not look stamped from one mould -- the same idea clover.js uses for
    // the real mesh's own leaflet jitter.
    let jitter = (hash11(P.phase.z * 7.0 + f32(leaflet) * 3.1) - 0.5) * 0.6;
    let az = f32(leaflet) * 2.0943951 + jitter;
    let cs = P.orient.x;
    let sn = P.orient.y;
    let lx = cos(az);
    let lz = sin(az);
    let dir = vec3f(lx * cs - lz * sn, 0.0, lx * sn + lz * cs);
    centre = top.pos.xyz + dir * (fullRadius * 0.42);
    radius = fullRadius * 0.60;
  } else if (leaflet != 0u) {
    // A real flower head is one blob; collapse the spare two to nothing.
    c = vec2f(0.0, 0.0);
  }

  let toCam = G.cameraPos.xyz - centre;
  let dist = max(1e-4, length(toCam));
  let view = toCam / dist;

  // A capitulum is a flat disc. Seen off-axis it projects to an ellipse whose
  // major axis lies in the disc's plane square to the view and whose minor
  // axis shortens with the cosine -- so a head seen edge-on is a line, not a
  // ball. A plain camera-facing billboard gets this wrong in the one way that
  // is visible at any distance: every flower in the meadow faces you.
  var major = cross(axis, view);
  let ml = length(major);
  var minorAxis: vec3f;
  var squash: f32;
  if (ml > 1e-4) {
    major = major / ml;
    minorAxis = cross(view, major);
    squash = abs(dot(axis, view));
  } else {
    // Looking straight down the head's axis: it is a full circle, and any
    // in-plane pair of axes will do.
    major = normalize(cross(view, vec3f(0.0, 0.0, 1.0)) + vec3f(1e-4, 0.0, 0.0));
    minorAxis = cross(view, major);
    squash = 1.0;
  }

  // Half a world-space pixel at this distance, from the vertical field of view.
  let pxWorld = 2.0 * G.cameraPos.w * dist / G.screen.y;
  // Never smaller than a couple of pixels: a sub-pixel quad does not resolve,
  // it aliases, and the defocus pass has nothing coherent to spread.
  let wantA = radius;
  let wantB = radius * max(0.06, squash);
  let a = max(wantA, pxWorld * 1.2);
  let b = max(wantB, pxWorld * 1.2);

  var o: VOut;
  o.outward = major * c.x + minorAxis * c.y;
  o.world = centre + major * (c.x * a) + minorAxis * (c.y * b);
  o.local = c;
  o.axis = axis;
  o.vid = ii;
  // Radiance scales by the area the widen invented, so total flux is preserved.
  o.coverage = clamp((wantA * wantB) / (a * b), 0.0, 1.0);
  o.clip = G.viewProj * vec4f(o.world, 1.0);
  o.viewZ = -(G.view * vec4f(o.world, 1.0)).z;
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  let vis = visible[i.vid];
  let P = plants[vis.plant];
  let r = length(i.local);
  if (r > 1.0) { discard; }

  // Edge softness. The defocus pass does the real blurring, so this only has
  // to cover the sub-pixel band -- but it is scaled by a fraction of the
  // circle of confusion so that the blob still reads as soft when the aperture
  // is stopped right down and dof.wgsl has almost nothing to do.
  let leafletSpecies = P.phase.w < 0.5;
  let soft = clamp(0.10 + 0.010 * vis.coc, 0.10, select(0.65, 0.55, leafletSpecies));
  var alpha = 1.0 - smoothstep(1.0 - soft, 1.0, r);

  // The star. A head is not a uniform disc: the rays reach out past the disc
  // and leave gaps between them, and just enough of that survives to be worth
  // drawing while anything at all is resolvable. `sharp` takes it out on
  // exactly the schedule the lens does. A leaflet blob has no rays to speak
  // of, so it skips the star entirely rather than drawing gaps in a leaf.
  if (!leafletSpecies) {
    let theta = atan2(i.local.y, i.local.x);
    let lobes = max(5.0, P.phase.w);
    let star = 0.5 + 0.5 * cos(lobes * theta);
    let starAmp = clamp(vis.sharp * 3.0, 0.0, 0.55);
    alpha *= 1.0 - starAmp * smoothstep(0.45, 1.0, r) * (1.0 - star);
  }
  if (alpha < 0.004) { discard; }

  var albedo: vec3f;
  var bloom = 0.0;
  if (leafletSpecies) {
    // The leaf, not the bud, is what a clover patch reads as at any distance
    // -- so the blob is just foliage albedo, the same colour the real leaf
    // mesh carries, with none of the disc/ray/bloom blend a real head needs.
    albedo = P.leafCol.rgb;
  } else {
    // Colour: disc in the middle, rays outside, blending over the band where a
    // real head's rays overlap the disc rim.
    let discFrac = clamp(P.orient.w / max(1e-5, P.orient.z), 0.05, 0.9);
    bloom = clamp(P.phase.x * G.state.x, 0.0, 1.0);
    let rayCol = mix(P.leafCol.rgb, mix(P.rayCol.rgb, P.tipCol.rgb, 0.35 * r), bloom);
    albedo = mix(P.discCol.rgb, rayCol, smoothstep(discFrac * 0.75, discFrac * 1.5, r));
  }

  // A shallow dome, so the blob is not a sticker. The normal starts as the
  // head's own axis at the centre and tilts outward toward the rim, which is
  // what a capitulum's crown does -- and it is the only shape information that
  // survives at this size, but it is enough to say which side the sun is on.
  let V = normalize(G.cameraPos.xyz - i.world);
  let CROWN = 0.75;
  let N = normalize(i.axis + i.outward * CROWN * r);
  let L = normalize(G.sunDir.xyz);
  let sun = G.sunColor.rgb * G.sunColor.w;
  let ndl = dot(N, L);

  var color = albedo * sun * max(0.0, ndl + 0.25) / (1.25 * PI);
  // Ray florets are thin membranes, so a head between the eye and the sun
  // glows. At this size that glow is most of what picks a flower out of a
  // meadow, so it survives the impostor when nothing else does. A leaflet
  // blob has no ray florets and no bloom state, so it skips the glow.
  if (!leafletSpecies) {
    let back = pow(clamp(-dot(V, L), 0.0, 1.0), 2.2);
    color += sun * back * P.transmit.rgb * albedo * 1.5 * bloom;
  }
  color += albedo * skyAmbient(i.axis);

  if (i32(G.plant.w + 0.5) == 7) { color = vec3f(0.20, 0.40, 0.95) * 0.7; }

  color = aerial(color, i.viewZ, -V, L);
  // Premultiplied: the pipeline blends src + dst*(1-a), so the colour has to
  // carry its own coverage.
  let a = alpha * i.coverage;
  return vec4f(color * a, a);
}
