// Device setup and small GPU helpers.

export async function initWebGPU(canvas) {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not available in this browser. ' +
      'It needs Chrome/Edge 113+, Safari 26+, or Firefox with WebGPU enabled.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No suitable GPU adapter was found.');

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize, 64 * 1024 * 1024),
    },
  });
  device.lost.then((info) => {
    console.error('WebGPU device lost:', info.message, info.reason);
  });

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  return { adapter, device, context, format };
}

/**
 * Resolve `//!include` directives at load time; mirrors tools/check-shaders.
 *
 * The default base is resolved against this module's own URL rather than left
 * as a document-relative path: `fetch` resolves relative URLs against the page,
 * so a document-relative default breaks as soon as the site is served from a
 * subpath (GitHub Pages project sites) or the page sets a <base>.
 */
export async function makeShaderLoader(base = new URL('../shaders/', import.meta.url).href) {
  const cache = new Map();
  // Cache-bust with the build stamp: GitHub Pages serves assets with a ten
  // minute max-age, so without this a fresh deploy can be served alongside
  // shaders from the previous one.
  const version = globalThis.__BUILD__ && globalThis.__BUILD__ !== 'dev'
    ? `?v=${globalThis.__BUILD__}` : '';
  const fetchOnce = (name) => {
    if (!cache.has(name)) {
      cache.set(name, fetch(base + name + version).then((r) => {
        if (!r.ok) throw new Error(`shader ${name}: ${r.status}`);
        return r.text();
      }));
    }
    return cache.get(name);
  };
  async function resolve(name, seen = new Set()) {
    if (seen.has(name)) return '';
    seen.add(name);
    const src = await fetchOnce(name);
    const out = [];
    for (const line of src.split('\n')) {
      const m = /^\/\/!include\s+(\S+)\s*$/.exec(line);
      out.push(m ? await resolve(m[1], seen) : line);
    }
    return out.join('\n');
  }
  return resolve;
}

export function createBuffer(device, data, usage, label) {
  const buf = device.createBuffer({
    label,
    size: Math.ceil(data.byteLength / 4) * 4,
    usage,
    mappedAtCreation: true,
  });
  const Ctor = data.constructor;
  new Ctor(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

/**
 * Build a mip chain by successive half-resolution blits.
 *
 * Without mips the leaf's tertiary venation aliases into crawling sparkle as
 * soon as the surface tilts away -- the exact frequency the eye reads as
 * "computer graphics".
 */
export function makeMipGenerator(device) {
  const module = device.createShaderModule({
    label: 'mipmap',
    code: `
      @group(0) @binding(0) var src : texture_2d<f32>;
      @group(0) @binding(1) var samp : sampler;
      struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
      @vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
        let p = array(vec2f(-1.0,-3.0), vec2f(-1.0,1.0), vec2f(3.0,1.0));
        var o: VOut;
        o.pos = vec4f(p[vi], 0.0, 1.0);
        o.uv = vec2f(p[vi].x * 0.5 + 0.5, -p[vi].y * 0.5 + 0.5);
        return o;
      }
      @fragment fn fs(i: VOut) -> @location(0) vec4f {
        return textureSampleLevel(src, samp, i.uv, 0.0);
      }`,
  });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const cache = new Map();

  return function generateMips(texture, format, mipLevelCount) {
    let pipeline = cache.get(format);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      cache.set(format, pipeline);
    }
    const encoder = device.createCommandEncoder({ label: 'mipgen' });
    for (let level = 1; level < mipLevelCount; level++) {
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  };
}

export const mipCount = (w, h) => 1 + Math.floor(Math.log2(Math.max(w, h)));
