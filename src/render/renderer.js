// Pass graph and GPU resources.
//
// Frame order:
//   compute  stem solve (publishes landing sites) -> pollen advect
//   raster   shadow depth -> sky + plant + florets + pollen (HDR)
//   post     DoF prepare/gather -> bloom down/up -> composite to the canvas

import { createBuffer, makeMipGenerator, mipCount, makeShaderLoader } from '../gpu/device.js';
import { VERTEX_STRIDE } from '../geom/mesh.js';
import * as F from '../geom/flower.js';
import { growVenation, bakeLeafMaps } from '../geom/venation.js';
import { buildGrassBladeMesh, buildGrassInstances } from '../geom/grass.js';
import { BOUNDS } from '../sim/flight.js';
import { projectSkySH, shToIrradiance } from './sky.js';
import { mat4, lookAt, ortho, multiply, normalize } from './math.js';

const HDR_FORMAT = 'rgba16float';
const DEPTH_FORMAT = 'depth32float';
const SHADOW_SIZE = 2048;
const POLLEN_COUNT = 6000;
const BLOOM_LEVELS = 6;
const STEM_NODES = 16;

// Globals uniform layout, in floats. Must match struct Globals in common.wgsl.
const G = {
  viewProj: 0, invViewProj: 16, view: 32, sunViewProj: 48,
  cameraPos: 64, sunDir: 68, sunColor: 72,
  shL0: 76, shL1y: 80, shL1z: 84, shL1x: 88,
  lens: 92, windParams: 96, state: 100, screen: 104,
  shadowParam: 108, plant: 112, proj: 116, post: 120,
  SIZE_FLOATS: 124,
};

const VERTEX_LAYOUT = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' },  // pos
    { shaderLocation: 1, offset: 12, format: 'float32x3' },  // nrm
    { shaderLocation: 2, offset: 24, format: 'float32x3' },  // budPos
    { shaderLocation: 3, offset: 36, format: 'float32x3' },  // budNrm
    { shaderLocation: 4, offset: 48, format: 'float32x3' },  // tan
    { shaderLocation: 5, offset: 60, format: 'float32x2' },  // uv
    { shaderLocation: 6, offset: 68, format: 'float32x3' },  // axis/stemH/variant
  ],
};

/** Material uniform: albedo(4), transmit(4), surface(4), flags(4). */
function material(device, { albedo, cutoff = 0.5, transmit, thickness = 1,
                            roughness, aniso = 0, spec = 0.04, sheen = 0.5,
                            kind, veinStrength = 1, mottle = 0.2, label }) {
  const data = new Float32Array([
    ...albedo, cutoff,
    ...transmit, thickness,
    roughness, aniso, spec, sheen,
    kind, veinStrength, mottle, 0,
  ]);
  return createBuffer(device, data, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label);
}

export class Renderer {
  constructor(device, context, format, canvas) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.canvas = canvas;
    this.globals = new Float32Array(G.SIZE_FLOATS);
    this.generateMips = makeMipGenerator(device);
    this.sunSH = null;
    this.lastSunKey = '';
  }

  static async create(device, context, format, canvas) {
    const r = new Renderer(device, context, format, canvas);
    await r.init();
    return r;
  }

  async init() {
    const { device } = this;
    const load = await makeShaderLoader();
    const [windSrc, skySrc, shadowSrc, plantSrc, floretSrc, pollenSimSrc,
           pollenDrawSrc, dofSrc, bloomSrc, postSrc] = await Promise.all([
      load('wind.wgsl'), load('sky.wgsl'), load('shadow.wgsl'), load('plant.wgsl'),
      load('floret.wgsl'), load('pollen_sim.wgsl'), load('pollen_draw.wgsl'),
      load('dof.wgsl'), load('bloom.wgsl'), load('post.wgsl'),
    ]);
    const grassSrc = await load('grass.wgsl');
    const mod = (code, label) => device.createShaderModule({ code, label });
    const M = {
      wind: mod(windSrc, 'wind'), sky: mod(skySrc, 'sky'), shadow: mod(shadowSrc, 'shadow'),
      plant: mod(plantSrc, 'plant'), floret: mod(floretSrc, 'floret'),
      pollenSim: mod(pollenSimSrc, 'pollenSim'),
      pollenDraw: mod(pollenDrawSrc, 'pollenDraw'), dof: mod(dofSrc, 'dof'),
      bloom: mod(bloomSrc, 'bloom'), post: mod(postSrc, 'post'),
      grass: mod(grassSrc, 'grass'),
    };

    this.buildGeometry();
    this.buildTextures();
    this.buildLayouts();
    this.buildPipelines(M);
    this.resize();
  }

  // -------------------------------------------------------------------------
  buildGeometry() {
    const { device } = this;
    const usage = GPUBufferUsage.VERTEX;
    const iusage = GPUBufferUsage.INDEX;
    const upload = (mesh, label) => ({
      vertex: createBuffer(device, mesh.vertices, usage, `${label}.v`),
      index: createBuffer(device, mesh.indices, iusage, `${label}.i`),
      indexFormat: mesh.indexFormat,
      count: mesh.indexCount,
    });

    this.parts = {
      ray: upload(F.buildRayMesh(), 'ray'),
      receptacle: upload(F.buildReceptacleMesh(), 'receptacle'),
      stem: upload(F.buildStemMesh(), 'stem'),
      leafA: upload(F.buildLeafMesh(0.082, 0.232, 0.65, 17), 'leafA'),
      leafB: upload(F.buildLeafMesh(0.066, 0.148, -2.05, 29), 'leafB'),
      floret: upload(F.buildDiscFloretMesh(), 'floret'),
    };

    // Grass fills the play volume, so the flight bounds are the source of
    // truth for where it goes -- no second copy of the world's extent.
    this.parts.grass = upload(buildGrassBladeMesh(), 'grass');
    const grass = buildGrassInstances(BOUNDS);
    this.grassCount = grass.count;
    this.grassBuffer = createBuffer(device, grass.data, GPUBufferUsage.STORAGE, 'grass');

    const inst = F.buildFloretInstances();
    this.floretCount = inst.count;
    this.floretBuffer = createBuffer(device, inst.data, GPUBufferUsage.STORAGE, 'florets');

    // Stem chain, initialised straight and at rest.
    const nodes = new Float32Array(STEM_NODES * 16);
    this.stemSegment = F.FLOWER.stemHeight / (STEM_NODES - 1);
    for (let i = 0; i < STEM_NODES; i++) {
      const y = i * this.stemSegment;
      const o = i * 16;
      nodes[o] = 0; nodes[o + 1] = y; nodes[o + 2] = 0; nodes[o + 3] = i / (STEM_NODES - 1);
      nodes[o + 4] = 0; nodes[o + 5] = y; nodes[o + 6] = 0;
      nodes[o + 8] = 0; nodes[o + 9] = 1; nodes[o + 10] = 0;   // axis +Y
      nodes[o + 12] = 1; nodes[o + 13] = 0; nodes[o + 14] = 0; // side +X
    }
    this.stemBuffer = createBuffer(device, nodes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      'stemNodes');
    this.landingBuffer = device.createBuffer({
      label: 'landingSites',
      size: 4 * 4 * 3,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Pollen motes, seeded through the volume around the flower.
    const motes = new Float32Array(POLLEN_COUNT * 8);
    for (let i = 0; i < POLLEN_COUNT; i++) {
      const o = i * 8;
      motes[o] = (Math.random() - 0.5) * 0.44;
      motes[o + 1] = Math.random() * 0.62;
      motes[o + 2] = (Math.random() - 0.5) * 0.44;
      motes[o + 3] = 0.00006 + Math.random() * 0.00016;   // 60-220 micron
      motes[o + 7] = Math.random();
    }
    this.pollenBuffer = createBuffer(device, motes, GPUBufferUsage.STORAGE, 'pollen');
  }

  buildTextures() {
    const { device } = this;
    const ven = growVenation(undefined, { seed: 1 });
    const maps = bakeLeafMaps(ven, 1024, { seed: 3, holes: 2 });
    const size = maps.size;
    const levels = mipCount(size, size);

    const makeMap = (data, label) => {
      const tex = device.createTexture({
        label, size: [size, size], format: 'rgba8unorm', mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.writeTexture({ texture: tex }, data,
        { bytesPerRow: size * 4, rowsPerImage: size }, [size, size]);
      this.generateMips(tex, 'rgba8unorm', levels);
      return tex;
    };
    this.veinTexture = makeMap(maps.veinMap, 'veinMap');
    this.detailTexture = makeMap(maps.detailMap, 'detailMap');

    this.linearSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
      maxAnisotropy: 8,
    });
    this.shadowSampler = device.createSampler({ compare: 'less' });

    this.shadowTexture = device.createTexture({
      label: 'shadowMap', size: [SHADOW_SIZE, SHADOW_SIZE], format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    // Bound in place of the shadow map during the shadow pass itself, which
    // cannot sample the target it is writing.
    this.dummyDepth = device.createTexture({
      label: 'dummyDepth', size: [1, 1], format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dummyColor = device.createTexture({
      label: 'dummyColor', size: [1, 1], format: HDR_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.globalsBuffer = device.createBuffer({
      label: 'globals', size: G.SIZE_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const mat = (o) => material(device, o);
    this.materials = {
      ray: mat({
        label: 'ray', kind: 0,
        albedo: [0.62, 0.24, 0.42], transmit: [0.95, 0.34, 0.52], thickness: 1.0,
        roughness: 0.36, spec: 0.035, sheen: 0.75, veinStrength: 0.9, mottle: 0.18,
      }),
      leaf: mat({
        label: 'leaf', kind: 1, cutoff: 0.5,
        albedo: [0.085, 0.175, 0.045], transmit: [0.42, 0.78, 0.20], thickness: 1.0,
        roughness: 0.27, aniso: 0.55, spec: 0.048, sheen: 0.9, veinStrength: 1.6, mottle: 0.3,
      }),
      stem: mat({
        label: 'stem', kind: 2,
        albedo: [0.105, 0.185, 0.058], transmit: [0.35, 0.62, 0.18], thickness: 0.35,
        roughness: 0.42, spec: 0.042, sheen: 0.55, veinStrength: 0.5, mottle: 0.25,
      }),
      receptacle: mat({
        label: 'receptacle', kind: 3,
        albedo: [0.135, 0.175, 0.062], transmit: [0.30, 0.50, 0.15], thickness: 0.25,
        roughness: 0.52, spec: 0.038, sheen: 0.4, veinStrength: 0.8, mottle: 0.3,
      }),
    };
  }

  // -------------------------------------------------------------------------
  buildLayouts() {
    const { device } = this;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const VFC = VF | GPUShaderStage.COMPUTE;

    this.bgl0 = device.createBindGroupLayout({
      label: 'common',
      entries: [
        { binding: 0, visibility: VFC, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 3, visibility: VF, sampler: { type: 'filtering' } },
      ],
    });
    this.bglPlant = device.createBindGroupLayout({
      label: 'plant',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.bglStemOnly = device.createBindGroupLayout({
      label: 'stemOnly',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
    });
    this.bglFloret = device.createBindGroupLayout({
      label: 'floret',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bglGrass = device.createBindGroupLayout({
      label: 'grass',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
    });
    this.bglMaterial = device.createBindGroupLayout({
      label: 'material',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.bglWind = device.createBindGroupLayout({
      label: 'wind',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.bglPollenCompute = device.createBindGroupLayout({
      label: 'pollenCompute',
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
    });
    this.bglPollenDraw = device.createBindGroupLayout({
      label: 'pollenDraw',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
    });
    this.bglDof = device.createBindGroupLayout({
      label: 'dof',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.bglBloom = device.createBindGroupLayout({
      label: 'bloom',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.bglPost = device.createBindGroupLayout({
      label: 'post',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    });
  }

  buildPipelines(M) {
    const { device } = this;
    const pl = (...layouts) => device.createPipelineLayout({ bindGroupLayouts: layouts });
    const depthOn = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' };

    this.pipelines = {
      wind: device.createComputePipeline({
        label: 'wind',
        layout: pl(this.bgl0, this.bglWind),
        compute: { module: M.wind, entryPoint: 'solveStem' },
      }),
      pollenUpdate: device.createComputePipeline({
        label: 'pollenUpdate',
        layout: pl(this.bgl0, this.bglPollenCompute),
        compute: { module: M.pollenSim, entryPoint: 'update' },
      }),
      shadow: device.createRenderPipeline({
        label: 'shadow',
        layout: pl(this.bgl0, this.bglStemOnly),
        vertex: { module: M.shadow, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      sky: device.createRenderPipeline({
        label: 'sky',
        layout: pl(this.bgl0),
        vertex: { module: M.sky, entryPoint: 'vs' },
        fragment: { module: M.sky, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        // Drawn first, filling the frame; never occludes the geometry over it.
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      }),
      plant: device.createRenderPipeline({
        label: 'plant',
        layout: pl(this.bgl0, this.bglPlant, this.bglMaterial),
        vertex: { module: M.plant, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module: M.plant, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      grass: device.createRenderPipeline({
        label: 'grass',
        layout: pl(this.bgl0, this.bglGrass),
        vertex: { module: M.grass, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module: M.grass, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      floret: device.createRenderPipeline({
        label: 'floret',
        layout: pl(this.bgl0, this.bglFloret),
        vertex: { module: M.floret, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
        fragment: { module: M.floret, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      pollen: device.createRenderPipeline({
        label: 'pollen',
        layout: pl(this.bgl0, this.bglPollenDraw),
        vertex: { module: M.pollenDraw, entryPoint: 'vs' },
        fragment: {
          module: M.pollenDraw, entryPoint: 'fs',
          targets: [{
            format: HDR_FORMAT,
            // Premultiplied additive: motes only ever add light.
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
        // Occluded by the plant, but never occludes it.
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      }),
      dofPrepare: device.createRenderPipeline({
        label: 'dofPrepare',
        layout: pl(this.bgl0, this.bglDof),
        vertex: { module: M.dof, entryPoint: 'vsFullscreen' },
        fragment: { module: M.dof, entryPoint: 'prepare', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      dofGather: device.createRenderPipeline({
        label: 'dofGather',
        layout: pl(this.bgl0, this.bglDof),
        vertex: { module: M.dof, entryPoint: 'vsFullscreen' },
        fragment: { module: M.dof, entryPoint: 'gather', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      bloomDown: device.createRenderPipeline({
        label: 'bloomDown',
        layout: pl(this.bgl0, this.bglBloom),
        vertex: { module: M.bloom, entryPoint: 'vsFullscreen' },
        fragment: { module: M.bloom, entryPoint: 'downsample', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      bloomUp: device.createRenderPipeline({
        label: 'bloomUp',
        layout: pl(this.bgl0, this.bglBloom),
        vertex: { module: M.bloom, entryPoint: 'vsFullscreen' },
        fragment: {
          module: M.bloom, entryPoint: 'upsample',
          targets: [{
            format: HDR_FORMAT,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      }),
      post: device.createRenderPipeline({
        label: 'post',
        layout: pl(this.bgl0, this.bglPost),
        vertex: { module: M.post, entryPoint: 'vsFullscreen' },
        fragment: { module: M.post, entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      }),
    };

    // Bind groups that never change.
    this.bgWind = device.createBindGroup({
      layout: this.bglWind,
      entries: [
        { binding: 0, resource: { buffer: this.stemBuffer } },
        { binding: 1, resource: { buffer: this.landingBuffer } },
      ],
    });
    this.bgPollenCompute = device.createBindGroup({
      layout: this.bglPollenCompute,
      entries: [{ binding: 0, resource: { buffer: this.pollenBuffer } }],
    });
    this.bgPollenDraw = device.createBindGroup({
      layout: this.bglPollenDraw,
      entries: [{ binding: 0, resource: { buffer: this.pollenBuffer } }],
    });
    this.bgPlant = device.createBindGroup({
      layout: this.bglPlant,
      entries: [
        { binding: 0, resource: { buffer: this.stemBuffer } },
        { binding: 1, resource: this.veinTexture.createView() },
        { binding: 2, resource: this.detailTexture.createView() },
      ],
    });
    this.bgStemOnly = device.createBindGroup({
      layout: this.bglStemOnly,
      entries: [{ binding: 0, resource: { buffer: this.stemBuffer } }],
    });
    this.bgGrass = device.createBindGroup({
      layout: this.bglGrass,
      entries: [{ binding: 0, resource: { buffer: this.grassBuffer } }],
    });
    this.bgFloret = device.createBindGroup({
      layout: this.bglFloret,
      entries: [
        { binding: 0, resource: { buffer: this.stemBuffer } },
        { binding: 1, resource: { buffer: this.floretBuffer } },
      ],
    });
    this.bgMaterials = Object.fromEntries(
      Object.entries(this.materials).map(([k, buf]) => [k, device.createBindGroup({
        layout: this.bglMaterial,
        entries: [{ binding: 0, resource: { buffer: buf } }],
      })]));

    this.bg0Main = device.createBindGroup({
      layout: this.bgl0,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: this.shadowTexture.createView() },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: this.linearSampler },
      ],
    });
    this.bg0Shadow = device.createBindGroup({
      layout: this.bgl0,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: this.dummyDepth.createView() },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: this.linearSampler },
      ],
    });

    this.blurParams = [];
    for (let i = 0; i < BLOOM_LEVELS * 2; i++) {
      this.blurParams.push(device.createBuffer({
        size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }));
    }
  }

  // -------------------------------------------------------------------------
  resize() {
    const { device, canvas } = this;
    const w = Math.max(1, canvas.width), h = Math.max(1, canvas.height);
    if (this.width === w && this.height === h) return;
    this.width = w; this.height = h;
    this.halfW = Math.max(1, w >> 1);
    this.halfH = Math.max(1, h >> 1);

    for (const t of [this.hdrTexture, this.depthTexture, this.halfA, this.halfB,
                     this.bloomTexture]) t?.destroy();

    const target = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.hdrTexture = device.createTexture({
      label: 'hdr', size: [w, h], format: HDR_FORMAT,
      usage: target | GPUTextureUsage.COPY_SRC,
    });
    this.depthTexture = device.createTexture({ label: 'depth', size: [w, h], format: DEPTH_FORMAT, usage: target });
    this.halfA = device.createTexture({ label: 'dofA', size: [this.halfW, this.halfH], format: HDR_FORMAT, usage: target });
    this.halfB = device.createTexture({ label: 'dofB', size: [this.halfW, this.halfH], format: HDR_FORMAT, usage: target });

    // Bloom starts a further half-step down: the first downsample reads the
    // defocused half-res image, so out-of-focus highlights are what flares.
    this.bloomW = Math.max(1, this.halfW >> 1);
    this.bloomH = Math.max(1, this.halfH >> 1);
    const levels = Math.max(1, Math.min(BLOOM_LEVELS,
      1 + Math.floor(Math.log2(Math.max(this.bloomW, this.bloomH)))));
    this.bloomLevels = levels;
    this.bloomTexture = device.createTexture({
      label: 'bloom', size: [this.bloomW, this.bloomH], format: HDR_FORMAT,
      mipLevelCount: levels, usage: target,
    });

    const view = (t, level) => t.createView({ baseMipLevel: level, mipLevelCount: 1 });
    this.bloomViews = Array.from({ length: levels }, (_, i) => view(this.bloomTexture, i));

    const dofBind = (color, depth, half) => device.createBindGroup({
      layout: this.bglDof,
      entries: [
        { binding: 0, resource: color.createView() },
        { binding: 1, resource: depth.createView() },
        { binding: 2, resource: half.createView() },
      ],
    });
    this.bgDofPrepare = dofBind(this.hdrTexture, this.depthTexture, this.dummyColor);
    this.bgDofGather = dofBind(this.dummyColor, this.dummyDepth, this.halfA);

    // One bind group per bloom step, each with its own texel-size uniform.
    const bloomBind = (tex, level, paramIndex) => device.createBindGroup({
      layout: this.bglBloom,
      entries: [
        { binding: 0, resource: level === null ? tex.createView() : view(tex, level) },
        { binding: 1, resource: { buffer: this.blurParams[paramIndex] } },
      ],
    });
    this.bgBloomDown = [];
    for (let i = 0; i < levels; i++) {
      this.bgBloomDown.push(i === 0
        ? bloomBind(this.halfB, null, i)
        : bloomBind(this.bloomTexture, i - 1, i));
      const src = i === 0 ? [this.halfW, this.halfH] : [this.bloomW >> (i - 1), this.bloomH >> (i - 1)];
      device.queue.writeBuffer(this.blurParams[i], 0, new Float32Array([
        1 / Math.max(1, src[0]), 1 / Math.max(1, src[1]), 1.0, i === 0 ? 1.0 : 0.0,
      ]));
    }
    this.bgBloomUp = [];
    for (let i = levels - 1; i >= 1; i--) {
      const pi = BLOOM_LEVELS + i;
      this.bgBloomUp.push({ src: i, dst: i - 1, bind: bloomBind(this.bloomTexture, i, pi) });
      device.queue.writeBuffer(this.blurParams[pi], 0, new Float32Array([
        1 / Math.max(1, this.bloomW >> i), 1 / Math.max(1, this.bloomH >> i), 1.35, 0.0,
      ]));
    }

    this.bgPost = device.createBindGroup({
      layout: this.bglPost,
      entries: [
        { binding: 0, resource: this.hdrTexture.createView() },
        { binding: 1, resource: this.halfB.createView() },
        { binding: 2, resource: this.bloomViews[0] },
        { binding: 3, resource: this.depthTexture.createView() },
      ],
    });
  }

  // -------------------------------------------------------------------------
  /** Sky irradiance is expensive to project, so only redo it when the sun moves. */
  updateSkySH(sunDir) {
    const key = sunDir.map((v) => v.toFixed(2)).join(',');
    if (key === this.lastSunKey) return;
    this.lastSunKey = key;
    this.sunSH = shToIrradiance(projectSkySH(sunDir, 512));
  }

  updateGlobals(camera, state, dt) {
    const g = this.globals;
    const el = state.sunElevation, az = state.sunAzimuth;
    const sunDir = normalize([
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ]);
    this.updateSkySH(sunDir);

    // Sun view-projection, fitted around the whole plant.
    //
    // Two bugs lived here: the eye's height was set to sunDir.y * dist with no
    // base offset, putting the "sun" below the point it looked at so the scene
    // was lit and shadowed from underneath; and the ortho half-extent was 0.115
    // for a plant 0.40m tall, so most of the stem fell outside the shadow map.
    const HALF = 0.30, NEAR = 0.02, FAR = 1.6;
    const centre = [camera.target[0], F.FLOWER.stemHeight * 0.55, camera.target[2]];
    const dist = 0.8;
    const eye = [
      centre[0] + sunDir[0] * dist,
      centre[1] + sunDir[1] * dist,
      centre[2] + sunDir[2] * dist,
    ];
    const sunView = lookAt(mat4(), eye, centre, [0, 1, 0]);
    const sunProj = ortho(mat4(), HALF, HALF, NEAR, FAR);
    const sunViewProj = multiply(mat4(), sunProj, sunView);

    g.set(camera.viewProj, G.viewProj);
    g.set(camera.invViewProj, G.invViewProj);
    g.set(camera.view, G.view);
    g.set(sunViewProj, G.sunViewProj);

    g.set([...camera.position, camera.tanHalfFovY], G.cameraPos);
    // 0.00465 rad = the sun's true angular radius, which sets penumbra width.
    g.set([...sunDir, 0.00465], G.sunDir);
    g.set([1.0, 0.94, 0.86, state.sunIntensity], G.sunColor);

    const sh = this.sunSH;
    g.set([...sh[0], 0], G.shL0);
    g.set([...sh[1], 0], G.shL1y);
    g.set([...sh[2], 0], G.shL1z);
    g.set([...sh[3], 0], G.shL1x);

    g.set([camera.focusDistance, camera.fNumber, camera.focalLength, 0.024], G.lens);
    g.set([state.wind, state.time, Math.cos(state.windDir), Math.sin(state.windDir)], G.windParams);
    g.set([state.bloom, state.floretFront, state.exposure, dt], G.state);
    g.set([this.width, this.height, 1 / this.width, 1 / this.height], G.screen);
    g.set([HALF, FAR - NEAR, 0, 0.0016], G.shadowParam);
    g.set([F.FLOWER.stemHeight, this.stemSegment, 1.0, state.debugView ?? 0], G.plant);

    const { A, B } = camera.depthParams;
    g.set([camera.near, camera.far, A, B], G.proj);
    g.set([state.bloomStrength, state.grain, state.chromatic, state.vignette], G.post);

    this.device.queue.writeBuffer(this.globalsBuffer, 0, g);
  }

  /** Draw one plant part with its material. */
  drawPart(pass, part, materialKey) {
    pass.setBindGroup(2, this.bgMaterials[materialKey]);
    pass.setVertexBuffer(0, part.vertex);
    pass.setIndexBuffer(part.index, part.indexFormat);
    pass.drawIndexed(part.count);
  }

  render(camera, state, dt) {
    const { device } = this;
    this.resize();
    this.updateGlobals(camera, state, dt);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const P = this.pipelines;

    // --- simulation -------------------------------------------------------
    {
      const pass = encoder.beginComputePass({ label: 'sim' });
      pass.setBindGroup(0, this.bg0Main);
      pass.setPipeline(P.wind);
      pass.setBindGroup(1, this.bgWind);
      pass.dispatchWorkgroups(1);          // one workgroup owns the whole chain
      pass.setPipeline(P.pollenUpdate);
      pass.setBindGroup(1, this.bgPollenCompute);
      pass.dispatchWorkgroups(Math.ceil(POLLEN_COUNT / 64));
      pass.end();
    }

    // --- shadow -----------------------------------------------------------
    {
      const pass = encoder.beginRenderPass({
        label: 'shadow',
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowTexture.createView(),
          depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
        },
      });
      pass.setPipeline(P.shadow);
      pass.setBindGroup(0, this.bg0Shadow);
      pass.setBindGroup(1, this.bgStemOnly);
      for (const key of ['ray', 'receptacle', 'stem', 'leafA', 'leafB']) {
        const part = this.parts[key];
        pass.setVertexBuffer(0, part.vertex);
        pass.setIndexBuffer(part.index, part.indexFormat);
        pass.drawIndexed(part.count);
      }
      pass.end();
    }

    // --- main -------------------------------------------------------------
    {
      const pass = encoder.beginRenderPass({
        label: 'main',
        colorAttachments: [{
          view: this.hdrTexture.createView(),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: this.depthTexture.createView(),
          depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
        },
      });
      pass.setBindGroup(0, this.bg0Main);

      pass.setPipeline(P.sky);
      pass.draw(3);

      // Grass first: it is the backdrop, and drawing the near geometry after
      // it lets early-z reject most of the sward behind the flower.
      pass.setPipeline(P.grass);
      pass.setBindGroup(1, this.bgGrass);
      pass.setVertexBuffer(0, this.parts.grass.vertex);
      pass.setIndexBuffer(this.parts.grass.index, this.parts.grass.indexFormat);
      pass.drawIndexed(this.parts.grass.count, this.grassCount);

      pass.setPipeline(P.plant);
      pass.setBindGroup(1, this.bgPlant);
      this.drawPart(pass, this.parts.stem, 'stem');
      this.drawPart(pass, this.parts.leafA, 'leaf');
      this.drawPart(pass, this.parts.leafB, 'leaf');
      this.drawPart(pass, this.parts.receptacle, 'receptacle');
      this.drawPart(pass, this.parts.ray, 'ray');

      pass.setPipeline(P.floret);
      pass.setBindGroup(1, this.bgFloret);
      pass.setVertexBuffer(0, this.parts.floret.vertex);
      pass.setIndexBuffer(this.parts.floret.index, this.parts.floret.indexFormat);
      pass.drawIndexed(this.parts.floret.count, this.floretCount);

      pass.setPipeline(P.pollen);
      pass.setBindGroup(1, this.bgPollenDraw);
      pass.draw(6, POLLEN_COUNT);
      pass.end();
    }

    // --- depth of field ---------------------------------------------------
    const fullscreen = (label, pipeline, bind, view, blend = false) => {
      const pass = encoder.beginRenderPass({
        label,
        colorAttachments: [{
          view, loadOp: blend ? 'load' : 'clear', storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.bg0Main);
      pass.setBindGroup(1, bind);
      pass.draw(3);
      pass.end();
    };

    fullscreen('dofPrepare', P.dofPrepare, this.bgDofPrepare, this.halfA.createView());
    fullscreen('dofGather', P.dofGather, this.bgDofGather, this.halfB.createView());

    // --- bloom ------------------------------------------------------------
    for (let i = 0; i < this.bloomLevels; i++) {
      fullscreen(`bloomDown${i}`, P.bloomDown, this.bgBloomDown[i], this.bloomViews[i]);
    }
    for (const step of this.bgBloomUp) {
      fullscreen(`bloomUp${step.src}`, P.bloomUp, step.bind, this.bloomViews[step.dst], true);
    }

    // --- composite --------------------------------------------------------
    fullscreen('post', P.post, this.bgPost, this.context.getCurrentTexture().createView());

    device.queue.submit([encoder.finish()]);
  }

  /**
   * Read a block of the HDR target back to the CPU and summarise it.
   *
   * A black frame is otherwise indistinguishable between "the main pass drew
   * nothing", "it drew something the post chain then discarded" and "it drew
   * something too dark to see". Actual numbers out of the HDR target separate
   * those three in one step, which is worth a stall when the alternative is a
   * round trip per guess.
   */
  async probeHDR(size = 128) {
    const { device } = this;
    const w = Math.min(size, this.width), h = Math.min(size, this.height);
    // copyTextureToBuffer needs bytesPerRow aligned to 256; rgba16float is 8B.
    const rowBytes = Math.ceil((w * 8) / 256) * 256;
    const buffer = device.createBuffer({
      size: rowBytes * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder({ label: 'probe' });
    enc.copyTextureToBuffer(
      { texture: this.hdrTexture,
        origin: { x: (this.width - w) >> 1, y: (this.height - h) >> 1 } },
      { buffer, bytesPerRow: rowBytes, rowsPerImage: h },
      { width: w, height: h },
    );
    device.queue.submit([enc.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const view = new DataView(buffer.getMappedRange());

    const half = (u) => {
      const s = (u & 0x8000) >> 15, e = (u & 0x7c00) >> 10, f = u & 0x03ff;
      if (e === 0) return (s ? -1 : 1) * 2 ** -14 * (f / 1024);
      if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
      return (s ? -1 : 1) * 2 ** (e - 15) * (1 + f / 1024);
    };

    let min = Infinity, max = -Infinity, sum = 0, n = 0, nan = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = y * rowBytes + x * 8;
        for (let c = 0; c < 3; c++) {
          const v = half(view.getUint16(o + c * 2, true));
          if (Number.isNaN(v)) { nan++; continue; }
          min = Math.min(min, v); max = Math.max(max, v); sum += v; n++;
        }
      }
    }
    buffer.unmap();
    buffer.destroy();
    return {
      min: n ? min : 0, max: n ? max : 0, mean: n ? sum / n : 0,
      nanFraction: nan / (w * h * 3), samples: w * h,
    };
  }

  /** Read back the stem chain the compute pass solved. */
  async probeStem() {
    const { device } = this;
    const bytes = 16 * 16 * 4;
    const dst = device.createBuffer({
      size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder({ label: 'probeStem' });
    enc.copyBufferToBuffer(this.stemBuffer, 0, dst, 0, bytes);
    device.queue.submit([enc.finish()]);
    await dst.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(dst.getMappedRange()).slice();
    dst.unmap(); dst.destroy();
    const nodes = [];
    for (let i = 0; i < 16; i++) {
      const o = i * 16;
      nodes.push({
        pos: [f[o], f[o + 1], f[o + 2]].map((v) => +v.toFixed(4)),
        axis: [f[o + 8], f[o + 9], f[o + 10]].map((v) => +v.toFixed(3)),
      });
    }
    return { finite: f.every(Number.isFinite), first: nodes[0], last: nodes[15] };
  }
}
