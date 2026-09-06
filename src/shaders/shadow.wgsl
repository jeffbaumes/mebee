//!include scene.wgsl

// Depth-only pass from the sun. Shares the scene bindings and the skinning
// with the main pass, so the shadow can never lag the geometry it is cast by
// -- and, because it reads the same visible list, it can never shadow a plant
// the main pass decided not to draw.

struct VIn {
  @location(0) pos     : vec3f,
  @location(1) nrm     : vec3f,
  @location(2) budPos  : vec3f,
  @location(3) budNrm  : vec3f,
  @location(4) tan     : vec3f,
  @location(5) uv      : vec2f,
  @location(6) params  : vec3f,   // axis, stemHeight, variant
}

@vertex
fn vs(v: VIn, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let vis = visible[ii];
  let P = plants[vis.plant];
  let bloom = clamp(P.phase.x * G.state.x, 0.0, 1.0);
  let rest = mix(v.budPos, v.pos, bloom);
  let s = skinToPlant(P, vis.plant, rest, v.nrm, v.tan,
                      v.params.y, v.params.x, v.params.z);
  return G.sunViewProj * vec4f(s.pos, 1.0);
}
