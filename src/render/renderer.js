// Pass graph and GPU resources.
//
// Frame order:
//   cull     choose what to draw and at what detail (render/lod.js, on the CPU)
//   compute  stem solve for every plant (publishes landing sites) -> pollen
//   raster   shadow depth -> sky + ground + grass + plants + florets
//            + impostors (HDR)
//   post     DoF prepare/gather -> bloom down/up -> composite to the canvas
//
// The field is several hundred plants and six species. What keeps that a fixed
// cost is that nothing about a plant is baked: one set of meshes per species,
// one instance buffer for the whole meadow, one compute dispatch for every
// stem, and a per-frame draw list that says which plants to draw at which of
// three index buffers. See render/lod.js for how that list is chosen.

import { createBuffer, makeMipGenerator, mipCount, makeShaderLoader } from '../gpu/device.js';
import { VERTEX_STRIDE } from '../geom/mesh.js';
import * as F from '../geom/flower.js';
import { SPECIES, headRadius as speciesHeadRadius, rayCount, silhouetteRays }
  from '../geom/species.js';
import { growField, packPlantInstances, bakeHabitatMap } from '../geom/field.js';
import { growVenation, bakeLeafMaps } from '../geom/venation.js';
import { buildGrassBladeMesh } from '../geom/grass.js';
import { BOUNDS } from '../sim/flight.js';
import { HeadSites, SITE_FLOATS } from '../sim/sites.js';
import { LodSelector, TIER, VISIBLE_WORDS } from './lod.js';
import { SENSOR_HEIGHT } from './camera.js';
import { projectSkySH, shToIrradiance, skyRadiance, ATMOSPHERE } from './sky.js';
import { mat4, lookAt, ortho, multiply, normalize } from './math.js';

// Refresh intervals real displays run at, never longer than the 1/60 the stem
// solver's wind constants were tuned against. tools/sim-stem.mjs measures what
// happens off this ladder: stepping at 1/48 grew the tip's sway by half.
const REFRESH_LADDER = [1 / 144, 1 / 120, 1 / 90, 1 / 75, 1 / 60];

const HDR_FORMAT = 'rgba16float';
const DEPTH_FORMAT = 'depth32float';
const SHADOW_SIZE = 2048;
const POLLEN_COUNT = 6000;
const BLOOM_LEVELS = 6;
const STEM_NODES = 16;

/** The meadow. Its extent is the flight volume's, so there is one answer. */
const FIELD_HALF = Math.max(BOUNDS.max[0], BOUNDS.max[2]);
const PLANT_TARGET = 700;
const HABITAT_SIZE = 256;

/** Instance stride the floret draw multiplexes on; must match floret.wgsl. */
const FLORETS_PER_PLANT = 1024;

/**
 * Grass window. The blades are hashed out of a world grid inside a square of
 * cells that follows the camera (see grass.wgsl), so this is the whole cost of
 * ground cover however big the field is: `perCell * across^2` instances, of
 * which the lens-driven thinning in the vertex shader collapses most.
 */
const GRASS = { cell: 0.055, perCell: 8, across: 45, fade: 1.30 };
const GRASS_CELLS = GRASS.across * GRASS.across;

/**
 * Extinction per metre for the aerial term.
 *
 * Real air over seven metres does essentially nothing, so this is a small
 * deliberate exaggeration: enough that the far side of the meadow sits behind
 * the near side, not so much that it looks foggy. See aerial() in common.wgsl.
 */
const AERIAL = 0.03;

/** Ground disc tessellation; must match RINGS/SECTORS in ground.wgsl. */
const GROUND_VERTS = 44 * 72 * 6;

// Globals uniform layout, in floats. Must match struct Globals in common.wgsl.
const G = {
  viewProj: 0, invViewProj: 16, view: 32, sunViewProj: 48,
  cameraPos: 64, sunDir: 68, sunColor: 72,
  shL0: 76, shL1y: 80, shL1z: 84, shL1x: 88,
  lens: 92, windParams: 96, state: 100, screen: 104,
  shadowParam: 108, plant: 112, field: 116, hazeSun: 120, hazeAway: 124,
  proj: 128, post: 132,
  SIZE_FLOATS: 136,
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

/** Plant parts, in the order they are drawn, with the material each wears. */
const PARTS = [
  { key: 'stem', material: 'stem' },
  { key: 'leafA', material: 'leaf' },
  { key: 'leafB', material: 'leaf' },
  { key: 'receptacle', material: 'receptacle' },
  { key: 'ray', material: 'ray' },
];

/**
 * Material uniform: what is true of a KIND of tissue, not of one flower.
 * Pigment comes off the plant instance -- see plant.wgsl.
 */
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
    this.lodBias = 1.0;
    this.grassDensity = 1.0;
  }

  static async create(device, context, format, canvas) {
    const r = new Renderer(device, context, format, canvas);
    await r.init();
    return r;
  }

  async init() {
    const { device } = this;
    const load = await makeShaderLoader();
    const names = ['wind.wgsl', 'sky.wgsl', 'shadow.wgsl', 'plant.wgsl', 'floret.wgsl',
                   'pollen_sim.wgsl', 'pollen_draw.wgsl', 'dof.wgsl', 'bloom.wgsl',
                   'post.wgsl', 'grass.wgsl', 'ground.wgsl', 'impostor.wgsl'];
    const sources = await Promise.all(names.map((n) => load(n)));
    const mod = (code, label) => device.createShaderModule({ code, label });
    const M = Object.fromEntries(names.map((n, i) =>
      [n.replace('.wgsl', ''), mod(sources[i], n)]));

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

    /** Upload one mesh: shared vertices, one index buffer per level of detail. */
    const upload = (mesh, label) => ({
      vertex: createBuffer(device, mesh.vertices, usage, `${label}.v`),
      lods: mesh.lods.map((l, i) => ({
        index: createBuffer(device, l.indices, iusage, `${label}.i${i}`),
        indexFormat: l.indexFormat,
        count: l.indexCount,
      })),
    });

    // --- the six species -------------------------------------------------
    // One set of meshes each, shared by every individual of that species. All
    // the variation -- size, height, pigment, phenology -- is in the instance.
    const floretBlocks = [];
    let floretBase = 0;
    this.species = SPECIES.map((s) => {
      const meshes = F.buildSpeciesMeshes(s);
      const parts = {};
      for (const { key } of PARTS) {
        if (meshes[key]) parts[key] = upload(meshes[key], `${s.key}.${key}`);
      }
      floretBlocks.push(meshes.florets.data);
      const info = {
        key: s.key,
        parts,
        floretBase,
        floretCount: meshes.florets.count,
        headRadius: speciesHeadRadius(s),
        rayCount: rayCount(s),
        silhouetteRays: silhouetteRays(s),
      };
      // The floret draw multiplexes plant and floret onto one instance index
      // with a constant stride, so no species may exceed it.
      if (info.floretCount > FLORETS_PER_PLANT) {
        throw new Error(`${s.key}: ${info.floretCount} florets exceeds the ` +
                        `${FLORETS_PER_PLANT} instance stride`);
      }
      floretBase += meshes.florets.count;
      return info;
    });

    // Every species' Vogel table, back to back: the plant instance carries its
    // own block's offset, so one bind group serves the whole field.
    const allFlorets = new Float32Array(floretBlocks.reduce((n, b) => n + b.length, 0));
    {
      let o = 0;
      for (const b of floretBlocks) { allFlorets.set(b, o); o += b.length; }
    }
    this.floretBuffer = createBuffer(device, allFlorets, GPUBufferUsage.STORAGE, 'florets');
    this.parts = { floret: upload(F.buildDiscFloretMesh(), 'floret'),
                   grass: upload(buildGrassBladeMesh(), 'grass') };

    // --- the field ---------------------------------------------------------
    this.field = growField({ min: BOUNDS.min, max: BOUNDS.max }, { target: PLANT_TARGET });
    this.plants = this.field.plants;
    this.plantCount = this.plants.length;
    const packed = packPlantInstances(this.plants, this.species);
    this.plantBuffer = createBuffer(device, packed.data, GPUBufferUsage.STORAGE, 'plants');
    this.lod = new LodSelector(this.plants, SPECIES.length);

    // This frame's draw list. Rewritten every frame from the CPU, and read by
    // the shadow pass, the plant pass, the floret pass and the impostors --
    // one list, so they cannot disagree about what is being drawn.
    this.visibleBuffer = device.createBuffer({
      label: 'visible',
      size: Math.max(16, this.plantCount * VISIBLE_WORDS * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // --- stem chains -------------------------------------------------------
    // One 16-node chain per plant, packed back to back and initialised along
    // that plant's own leaning rest axis.
    const nodes = new Float32Array(this.plantCount * STEM_NODES * 16);
    for (let p = 0; p < this.plantCount; p++) {
      const plant = this.plants[p];
      const sinL = Math.sin(plant.lean), cosL = Math.cos(plant.lean);
      const ax = Math.cos(plant.leanDir) * sinL, ay = cosL, az = Math.sin(plant.leanDir) * sinL;
      const seg = plant.stemHeight / (STEM_NODES - 1);
      for (let i = 0; i < STEM_NODES; i++) {
        const o = (p * STEM_NODES + i) * 16;
        const x = plant.x + ax * seg * i;
        const y = ay * seg * i;
        const z = plant.z + az * seg * i;
        nodes[o] = x; nodes[o + 1] = y; nodes[o + 2] = z;
        nodes[o + 3] = i / (STEM_NODES - 1);
        nodes[o + 4] = x; nodes[o + 5] = y; nodes[o + 6] = z;
        nodes[o + 8] = ax; nodes[o + 9] = ay; nodes[o + 10] = az;
        // Any unit vector square to the axis will do as the initial side; the
        // solver re-derives it by parallel transport on the first frame.
        nodes[o + 12] = 1; nodes[o + 13] = 0; nodes[o + 14] = 0;
      }
    }
    this.stemBuffer = createBuffer(device, nodes,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      'stemNodes');

    // --- landing sites -----------------------------------------------------
    // One per plant. Small enough (a few tens of kilobytes) to read the whole
    // table back every frame, which is what lets the flight model ask "which
    // flower is nearest" against geometry that is actually swaying.
    this.landingBytes = this.plantCount * SITE_FLOATS * 4;
    this.landingBuffer = device.createBuffer({
      label: 'landingSites',
      size: Math.max(64, this.landingBytes),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    // Ring of staging buffers so the table can be read back every frame
    // without ever blocking on a map. Two or three frames of latency is
    // invisible at the speed the flowers sway, and it beats duplicating the
    // solver on the CPU, where float differences would let the crawl surface
    // drift away from the flower actually being drawn.
    this.landingStaging = Array.from({ length: 3 }, () => device.createBuffer({
      size: Math.max(64, this.landingBytes),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    this.landingFree = [0, 1, 2];
    this.sites = new HeadSites(this.plantCount);
    this.sites.count = 0;

    // Stem solver step. Exactly one step runs per frame; this is how long it
    // is. See updateSolveStep, and tools/sim-stem.mjs for the measurements.
    this.frameAvg = 1 / 60;
    this.solveStep = 1 / 60;
    // The simulation's own clock, advanced by the solver's step rather than by
    // wall time. EVERYTHING wind-driven reads this -- the stem solve, the petal
    // and leaf flex, the grass, the pollen -- so they cannot disagree, and a
    // frame that took 50ms cannot jump any of them forward 50ms.
    this.simTime = 0;

    // Pollen motes. Seeded near the origin and recycled around the camera by
    // pollen_sim.wgsl, so the same six thousand follow the bee across the field.
    const motes = new Float32Array(POLLEN_COUNT * 8);
    for (let i = 0; i < POLLEN_COUNT; i++) {
      const o = i * 8;
      motes[o] = (Math.random() - 0.5) * 1.0;
      motes[o + 1] = Math.random() * 0.5;
      motes[o + 2] = (Math.random() - 0.5) * 1.0;
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

    const makeMap = (data, w, label, mips = true) => {
      const n = mips ? mipCount(w, w) : 1;
      const tex = device.createTexture({
        label, size: [w, w], format: 'rgba8unorm', mipLevelCount: n,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
               GPUTextureUsage.RENDER_ATTACHMENT,
      });
      device.queue.writeTexture({ texture: tex }, data,
        { bytesPerRow: w * 4, rowsPerImage: w }, [w, w]);
      if (n > 1) this.generateMips(tex, 'rgba8unorm', n);
      return tex;
    };
    this.veinTexture = makeMap(maps.veinMap, size, 'veinMap');
    this.detailTexture = makeMap(maps.detailMap, size, 'detailMap');

    // The habitat, baked from the same fields geom/field.js sampled to place
    // the plants. The ground shader and the grass read it, so the turf agrees
    // with what is growing in it rather than merely resembling it.
    const hab = bakeHabitatMap(FIELD_HALF, HABITAT_SIZE);
    this.habitatTexture = makeMap(hab.data, hab.size, 'habitat', false);

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

    // Kind-level tissue properties only. The albedo and transmit fields here
    // are fallbacks the instanced path overrides; what actually matters is the
    // roughness, the anisotropy, and how strongly the veins deform the normal.
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
        { binding: 4, visibility: VF, texture: { sampleType: 'float' } },
      ],
    });
    // Everything that draws a plant binds exactly this: the solved chains, the
    // field, and this frame's draw list.
    this.bglScene = device.createBindGroupLayout({
      label: 'scene',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bglPlantTex = device.createBindGroupLayout({
      label: 'plantTex',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    this.bglFloretDisc = device.createBindGroupLayout({
      label: 'floretDisc',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bglWind = device.createBindGroupLayout({
      label: 'wind',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
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
    const opaque = (label, module, layout) => device.createRenderPipeline({
      label, layout,
      vertex: { module, entryPoint: 'vs', buffers: [VERTEX_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depthOn,
    });

    this.pipelines = {
      wind: device.createComputePipeline({
        label: 'wind',
        layout: pl(this.bgl0, this.bglWind),
        compute: { module: M.wind, entryPoint: 'solveStem' },
      }),
      pollenUpdate: device.createComputePipeline({
        label: 'pollenUpdate',
        layout: pl(this.bgl0, this.bglPollenCompute),
        compute: { module: M.pollen_sim, entryPoint: 'update' },
      }),
      shadow: device.createRenderPipeline({
        label: 'shadow',
        layout: pl(this.bgl0, this.bglScene),
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
      ground: device.createRenderPipeline({
        label: 'ground',
        layout: pl(this.bgl0),
        vertex: { module: M.ground, entryPoint: 'vs' },
        fragment: { module: M.ground, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      plant: opaque('plant', M.plant, pl(this.bgl0, this.bglScene, this.bglPlantTex)),
      grass: opaque('grass', M.grass, pl(this.bgl0)),
      floret: opaque('floret', M.floret, pl(this.bgl0, this.bglScene, this.bglFloretDisc)),
      impostor: device.createRenderPipeline({
        label: 'impostor',
        layout: pl(this.bgl0, this.bglScene),
        vertex: { module: M.impostor, entryPoint: 'vs' },
        fragment: {
          module: M.impostor, entryPoint: 'fs',
          targets: [{
            format: HDR_FORMAT,
            // Premultiplied over. The far field is soft-edged by definition,
            // so it has to blend; the draw list is sorted back to front and
            // depth is still written, so the defocus pass reads the head's own
            // distance rather than whatever is behind it.
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: depthOn,
      }),
      pollen: device.createRenderPipeline({
        label: 'pollen',
        layout: pl(this.bgl0, this.bglPollenDraw),
        vertex: { module: M.pollen_draw, entryPoint: 'vs' },
        fragment: {
          module: M.pollen_draw, entryPoint: 'fs',
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
        { binding: 2, resource: { buffer: this.plantBuffer } },
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
    this.bgScene = device.createBindGroup({
      layout: this.bglScene,
      entries: [
        { binding: 0, resource: { buffer: this.stemBuffer } },
        { binding: 1, resource: { buffer: this.plantBuffer } },
        { binding: 2, resource: { buffer: this.visibleBuffer } },
      ],
    });
    this.bgFloretDisc = device.createBindGroup({
      layout: this.bglFloretDisc,
      entries: [{ binding: 0, resource: { buffer: this.floretBuffer } }],
    });
    this.bgMaterials = Object.fromEntries(
      Object.entries(this.materials).map(([k, buf]) => [k, device.createBindGroup({
        layout: this.bglPlantTex,
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: this.veinTexture.createView() },
          { binding: 2, resource: this.detailTexture.createView() },
        ],
      })]));

    const common = (shadowView) => device.createBindGroup({
      layout: this.bgl0,
      entries: [
        { binding: 0, resource: { buffer: this.globalsBuffer } },
        { binding: 1, resource: shadowView },
        { binding: 2, resource: this.shadowSampler },
        { binding: 3, resource: this.linearSampler },
        { binding: 4, resource: this.habitatTexture.createView() },
      ],
    });
    this.bg0Main = common(this.shadowTexture.createView());
    this.bg0Shadow = common(this.dummyDepth.createView());

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
  updateSkySH(sunDir, intensity) {
    const key = `${sunDir.map((v) => v.toFixed(2)).join(',')}|${intensity.toFixed(1)}`;
    if (key === this.lastSunKey) return;
    this.lastSunKey = key;
    this.sunSH = shToIrradiance(projectSkySH(sunDir, 512));
    // Horizon radiance looking into the sun and away from it. Precomputed on
    // the same CPU atmosphere the sky shader mirrors, because evaluating it
    // per fragment for every surface in the scene would cost more than the
    // rest of the frame put together -- see aerial() in common.wgsl.
    const flat = Math.hypot(sunDir[0], sunDir[2]) || 1;
    const toward = [sunDir[0] / flat * 0.998, 0.06, sunDir[2] / flat * 0.998];
    const away = [-toward[0], 0.06, -toward[2]];
    const k = intensity / ATMOSPHERE.sunIntensity;
    this.hazeSun = skyRadiance(normalize([...toward]), sunDir).map((v) => v * k);
    this.hazeAway = skyRadiance(normalize([...away]), sunDir).map((v) => v * k);
  }

  /**
   * Choose the fixed step the stem solver runs at, from the frame time.
   *
   * The solver takes exactly one step per frame -- never a catch-up burst,
   * because spending two or three steps on a hitch is what made the head
   * lurch. So the step LENGTH is the only knob, and it has to hold still: a
   * Verlet chain against stiff constraints buzzes if its step wanders, and
   * gains energy if the step grows. Hence snapping to a standard refresh
   * interval, with hysteresis so a display sitting between two rates cannot
   * flip back and forth, and a 1/60 ceiling because that is what the wind
   * constants were tuned against. A slow machine runs the plants slow, which
   * reads as a calm day; running them with a longer step reads as a broken one.
   */
  updateSolveStep(dt) {
    const clamped = Math.min(1 / 45, Math.max(1 / 240, dt));
    this.frameAvg += (clamped - this.frameAvg) * 0.03;
    for (const rung of REFRESH_LADDER) {
      if (Math.abs(this.frameAvg - rung) < Math.abs(this.frameAvg - this.solveStep) * 0.80) {
        this.solveStep = rung;
      }
    }
    this.simTime += this.solveStep;
  }

  updateGlobals(camera, state) {
    const g = this.globals;
    const el = state.sunElevation, az = state.sunAzimuth;
    const sunDir = normalize([
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ]);
    this.updateSkySH(sunDir, state.sunIntensity);

    // Sun view-projection, fitted around the camera's own neighbourhood rather
    // than around one plant. A field seven metres across cannot have a shadow
    // map fitted to it and still resolve a petal -- at 2048 square this covers
    // a metre with a half-millimetre texel, which is right for the handful of
    // plants near enough to cast a shadow anyone can see.
    const HALF = 0.50, NEAR = 0.02, FAR = 2.6;
    // Camera forward, out of this frame's view matrix rather than last
    // frame's: lookAt puts the backward axis in the third row.
    const V = camera.view;
    const fwd = [-V[2], -V[6], -V[10]];
    const look = Math.min(0.45, Math.max(0.10, camera.focusDistance));
    const centre = [
      camera.position[0] + fwd[0] * look,
      0.10,
      camera.position[2] + fwd[2] * look,
    ];
    const dist = 1.2;
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

    g.set([camera.focusDistance, camera.fNumber, camera.focalLength, SENSOR_HEIGHT], G.lens);
    g.set([state.wind, this.simTime, Math.cos(state.windDir), Math.sin(state.windDir)], G.windParams);
    g.set([state.bloom, state.floretFront, state.exposure, this.solveStep], G.state);
    g.set([this.width, this.height, 1 / this.width, 1 / this.height], G.screen);
    g.set([HALF, FAR - NEAR, 0, 0.0016], G.shadowParam);
    g.set([this.plantCount, FIELD_HALF, this.lodBias, state.debugView ?? 0], G.plant);
    g.set([GRASS.cell, 1.0, GRASS.across, GRASS.fade], G.field);
    g.set([...this.hazeSun, AERIAL], G.hazeSun);
    g.set([...this.hazeAway, 0], G.hazeAway);

    const { A, B } = camera.depthParams;
    g.set([camera.near, camera.far, A, B], G.proj);
    g.set([state.bloomStrength, state.grain, state.chromatic, state.vignette], G.post);

    this.device.queue.writeBuffer(this.globalsBuffer, 0, g);
  }

  /** Draw one run of plants: every part of one species at one tier. */
  drawRun(pass, run, partKey) {
    const part = this.species[run.species].parts[partKey];
    if (!part) return 0;
    const lod = part.lods[Math.min(run.tier, part.lods.length - 1)];
    if (lod.count === 0) return 0;
    pass.setVertexBuffer(0, part.vertex);
    pass.setIndexBuffer(lod.index, lod.indexFormat);
    // firstInstance is the run's base in the visible list. WebGPU's
    // instance_index starts at firstInstance, so the shader reads the right
    // slice with no per-draw uniform and no dynamic offset.
    pass.drawIndexed(lod.count, run.count, 0, 0, run.base);
    return (lod.count / 3) * run.count;
  }

  render(camera, state, dt) {
    const { device } = this;
    this.resize();
    this.updateSolveStep(dt);
    this.updateGlobals(camera, state);

    // --- choose what to draw ----------------------------------------------
    // Before anything is encoded: the same list feeds the shadow pass, the
    // main pass and the impostors.
    const lod = this.lod;
    lod.bias = this.lodBias;
    lod.select(camera, this.height, SENSOR_HEIGHT, state.pinnedPlant ?? -1);
    if (lod.byteLength > 0) {
      device.queue.writeBuffer(this.visibleBuffer, 0, lod.buffer, 0, lod.byteLength);
    }

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const P = this.pipelines;

    // --- simulation -------------------------------------------------------
    {
      const pass = encoder.beginComputePass({ label: 'sim' });
      pass.setBindGroup(0, this.bg0Main);
      pass.setPipeline(P.wind);
      pass.setBindGroup(1, this.bgWind);
      // One workgroup per plant; the workgroup size is the chain length.
      pass.dispatchWorkgroups(this.plantCount);
      pass.setPipeline(P.pollenUpdate);
      pass.setBindGroup(1, this.bgPollenCompute);
      pass.dispatchWorkgroups(Math.ceil(POLLEN_COUNT / 64));
      pass.end();
    }

    // --- shadow -----------------------------------------------------------
    // Only the two finest tiers cast. A plant coarse enough to be a few
    // triangles is also far enough that its shadow is off the map, and the
    // impostors have no geometry to cast with.
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
      pass.setBindGroup(1, this.bgScene);
      for (const { key } of PARTS) {
        for (const run of lod.runs) {
          if (run.tier <= TIER.MID) this.drawRun(pass, run, key);
        }
      }
      pass.end();
    }

    // --- main -------------------------------------------------------------
    let triangles = 0;
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

      // Ground and grass first: they are the backdrop, and drawing the near
      // geometry after them lets early-z reject most of the sward behind it.
      pass.setPipeline(P.ground);
      pass.draw(GROUND_VERTS);

      // Grass is blade-major in the instance index (see grass.wgsl), so
      // trimming the instance count lifts whole layers off the sward evenly
      // rather than cutting the window in half.
      const layers = Math.round(GRASS.perCell * this.grassDensity);
      if (layers > 0) {
        pass.setPipeline(P.grass);
        pass.setVertexBuffer(0, this.parts.grass.vertex);
        const blade = this.parts.grass.lods[0];
        pass.setIndexBuffer(blade.index, blade.indexFormat);
        pass.drawIndexed(blade.count, layers * GRASS_CELLS);
      }

      pass.setPipeline(P.plant);
      pass.setBindGroup(1, this.bgScene);
      for (const { key, material: mat } of PARTS) {
        pass.setBindGroup(2, this.bgMaterials[mat]);
        for (const run of lod.runs) triangles += this.drawRun(pass, run, key);
      }

      // Disc florets, for the handful of plants at the finest tier. One draw
      // per plant, because every species has its own floret count and its own
      // block of the shared Vogel table.
      if (lod.floretSlots.length > 0) {
        pass.setPipeline(P.floret);
        pass.setBindGroup(1, this.bgScene);
        pass.setBindGroup(2, this.bgFloretDisc);
        const mesh = this.parts.floret.lods[0];
        pass.setVertexBuffer(0, this.parts.floret.vertex);
        pass.setIndexBuffer(mesh.index, mesh.indexFormat);
        for (const s of lod.floretSlots) {
          const n = this.species[s.species].floretCount;
          pass.drawIndexed(mesh.count, n, 0, 0, s.slot * FLORETS_PER_PLANT);
          triangles += (mesh.count / 3) * n;
        }
      }

      // The far field, back to front.
      if (lod.impostor.count > 0) {
        pass.setPipeline(P.impostor);
        pass.setBindGroup(1, this.bgScene);
        pass.draw(6, lod.impostor.count, 0, lod.impostor.base);
        triangles += 2 * lod.impostor.count;
      }

      pass.setPipeline(P.pollen);
      pass.setBindGroup(1, this.bgPollenDraw);
      pass.draw(6, POLLEN_COUNT);
      pass.end();
    }
    this.triangles = triangles;

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

    // Stage the landing sites for readback in the same submit.
    const slot = this.landingFree.pop();
    if (slot !== undefined) {
      encoder.copyBufferToBuffer(this.landingBuffer, 0,
        this.landingStaging[slot], 0, this.landingBytes);
    }

    device.queue.submit([encoder.finish()]);

    if (slot !== undefined) {
      const buf = this.landingStaging[slot];
      buf.mapAsync(GPUMapMode.READ).then(() => {
        // Copy out: the mapped range is invalidated by unmap, and the flight
        // model reads this table for the rest of the frame.
        this.sites.data.set(new Float32Array(buf.getMappedRange(),
                                             0, this.plantCount * SITE_FLOATS));
        this.sites.count = this.plantCount;
        buf.unmap();
        this.landingFree.push(slot);
      }).catch(() => { this.landingFree.push(slot); });
    }
  }

  /**
   * The plant the orbit view frames, and the one that is always held at the
   * finest tier: the biggest head near the middle of the field.
   */
  pickHero() {
    let best = 0, bestScore = -Infinity;
    this.plants.forEach((p, i) => {
      const score = p.headRadius * 4 - Math.hypot(p.x, p.z);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /** Live head position of a plant, or its rest position before any readback. */
  headPosition(i, out = [0, 0, 0]) {
    if (i >= 0 && i < this.sites.count) {
      const f = this.sites.frame(i);
      out[0] = f.pos[0]; out[1] = f.pos[1]; out[2] = f.pos[2];
      return out;
    }
    const p = this.plants[Math.max(0, Math.min(this.plants.length - 1, i))];
    out[0] = p.x; out[1] = p.stemHeight; out[2] = p.z;
    return out;
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

  /** Read back one plant's stem chain, as the compute pass solved it. */
  async probeStem(plant = 0) {
    const { device } = this;
    const bytes = STEM_NODES * 16 * 4;
    const dst = device.createBuffer({
      size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder({ label: 'probeStem' });
    enc.copyBufferToBuffer(this.stemBuffer, plant * bytes, dst, 0, bytes);
    device.queue.submit([enc.finish()]);
    await dst.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(dst.getMappedRange()).slice();
    dst.unmap(); dst.destroy();
    const nodes = [];
    for (let i = 0; i < STEM_NODES; i++) {
      const o = i * 16;
      nodes.push({
        pos: [f[o], f[o + 1], f[o + 2]].map((v) => +v.toFixed(4)),
        axis: [f[o + 8], f[o + 9], f[o + 10]].map((v) => +v.toFixed(3)),
      });
    }
    return { finite: f.every(Number.isFinite), first: nodes[0], last: nodes[STEM_NODES - 1] };
  }
}
