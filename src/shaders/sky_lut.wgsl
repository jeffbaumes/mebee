//!include common.wgsl

// The sky, baked.
//
// skyRadiance() is a twelve-step raymarch with a five-step light march inside
// it -- around sixty exponentials for one direction. Run per fragment over a
// full-screen background that is then almost entirely painted over by the
// ground disc, it was the single most expensive thing in the frame: twelve
// milliseconds of a forty-millisecond frame, to draw something that is a
// function of two angles and does not change unless the sun moves.
//
// So it is a table now. Every direction the camera can look, once, into a
// 512x256 lat-long map (see skyUv/skyDirOf in common.wgsl), rebuilt only when
// the sun's position or intensity changes -- which on a still afternoon is
// never. The whole bake is about a sixth of the work one frame used to do.
//
// The sun's own disc is NOT in here. It subtends half a degree, the table's
// texels are most of one, and a bilinear fetch would smear it into a lozenge.
// sky.wgsl adds it analytically instead.

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = array(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VOut;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, -p[vi].y * 0.5 + 0.5);
  return o;
}

@fragment
fn fs(i: VOut) -> @location(0) vec4f {
  return vec4f(skyRadiance(skyDirOf(i.uv), normalize(G.sunDir.xyz)), 1.0);
}
