//!include skin.wgsl

// Depth-only pass from the sun. Shares skinning with the main pass so the
// shadow never lags the geometry it is cast by.

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
fn vs(v: VIn) -> @builtin(position) vec4f {
  let bloom = G.state.x;
  let rest = mix(v.budPos, v.pos, bloom);
  let s = skinToStem(rest, v.nrm, v.tan, v.params.y, v.params.x,
                     G.plant.x, v.params.z);
  return G.sunViewProj * vec4f(s.pos, 1.0);
}
