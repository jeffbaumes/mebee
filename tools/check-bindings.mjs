// Cross-check every shader's @group/@binding declarations against the bind
// group layouts declared in renderer.js. A mismatch here is a pipeline-creation
// failure that only shows up at runtime, so it is worth catching statically.
import fs from 'node:fs';
import { resolveIncludes } from './check-shaders.mjs';

const KIND = (decl) => {
  if (/var<uniform>/.test(decl)) return 'uniform';
  if (/var<storage,\s*read_write>/.test(decl)) return 'storage';
  if (/var<storage,\s*read>/.test(decl)) return 'read-only-storage';
  if (/texture_depth_2d/.test(decl)) return 'depth';
  if (/texture_2d</.test(decl)) return 'texture';
  if (/sampler_comparison/.test(decl)) return 'comparison';
  if (/\bsampler\b/.test(decl)) return 'sampler';
  return '?';
};

const shaders = {};
for (const f of fs.readdirSync('src/shaders').filter(f => f.endsWith('.wgsl'))) {
  const src = resolveIncludes(f);
  const binds = {};
  for (const m of src.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*(var[^;]*);/g)) {
    (binds[m[1]] ??= {})[m[2]] = KIND(m[3]);
  }
  shaders[f] = binds;
}

// Which layout each pipeline uses, transcribed from buildPipelines().
const PIPELINES = {
  'wind.wgsl':        ['bgl0', 'bglWind'],
  'pollen_sim.wgsl':  ['bgl0', 'bglPollenCompute'],
  'pollen_draw.wgsl': ['bgl0', 'bglPollenDraw'],
  'shadow.wgsl':      ['bgl0', 'bglScene'],
  'sky.wgsl':         ['bgl0'],
  'ground.wgsl':      ['bgl0'],
  'grass.wgsl':       ['bgl0'],
  'plant.wgsl':       ['bgl0', 'bglScene', 'bglPlantTex'],
  'floret.wgsl':      ['bgl0', 'bglScene', 'bglFloretDisc'],
  'impostor.wgsl':    ['bgl0', 'bglScene'],
  'dof.wgsl':         ['bgl0', 'bglDof'],
  'bloom.wgsl':       ['bgl0', 'bglBloom'],
  'post.wgsl':        ['bgl0', 'bglPost'],
};

// Parse the layouts straight out of renderer.js so the two cannot drift.
const rendererSrc = fs.readFileSync('src/render/renderer.js', 'utf8');
const js = rendererSrc;
const layouts = {};
for (const m of js.matchAll(/this\.(bgl\w+)\s*=\s*device\.createBindGroupLayout\(\{([\s\S]*?)\n    \}\);/g)) {
  const entries = {};
  for (const e of m[2].matchAll(/binding:\s*(\d+),\s*visibility:[^,]*,\s*(?:buffer:\s*\{\s*type:\s*'([\w-]+)'|texture:\s*\{\s*sampleType:\s*'([\w-]+)'|sampler:\s*\{\s*type:\s*'(\w+)')/g)) {
    let kind = e[2] || e[3] || e[4];
    if (kind === 'float' || kind === 'unfilterable-float') kind = 'texture';
    if (kind === 'filtering' || kind === 'non-filtering') kind = 'sampler';
    entries[e[1]] = kind;
  }
  layouts[m[1]] = entries;
}

let problems = 0;
for (const [shader, groups] of Object.entries(PIPELINES)) {
  const declared = shaders[shader] || {};
  for (const [gi, layoutName] of groups.entries()) {
    const layout = layouts[layoutName];
    if (!layout) { console.log(`MISSING LAYOUT ${layoutName}`); problems++; continue; }
    const used = declared[String(gi)] || {};
    for (const [binding, kind] of Object.entries(used)) {
      const have = layout[binding];
      if (!have) {
        console.log(`${shader}: group ${gi} binding ${binding} (${kind}) not in ${layoutName}`);
        problems++;
      } else if (have !== kind) {
        console.log(`${shader}: group ${gi} binding ${binding} is ${kind} but ${layoutName} declares ${have}`);
        problems++;
      }
    }
  }
  const maxGroup = Math.max(-1, ...Object.keys(declared).map(Number));
  if (maxGroup >= groups.length) {
    console.log(`${shader}: uses group ${maxGroup} but the pipeline layout has ${groups.length}`);
    problems++;
  }
}
// --- storage struct sizes vs the JS packing --------------------------------
// A struct of vec4f is laid out as contiguous floats, so getting the field
// ORDER wrong in JS silently shifts every field. Sizes are all that can be
// checked mechanically; the field order is pinned by named slot constants in
// the packing code itself.
const STRUCT_EXPECT = {
  'FloretInstance': { file: 'floret.wgsl', jsFloats: 8, note: 'buildFloretInstances' },
  'StemNode':       { file: 'stem.wgsl',   jsFloats: 16, note: 'stem chain init' },
  'LandingSite':    { file: 'stem.wgsl',   jsFloats: 16, note: 'SITE_FLOATS in sim/sites.js' },
  'Mote':           { file: 'pollen_sim.wgsl', jsFloats: 8, note: 'pollen seeding' },
  'PlantInstance':  { file: 'instance.wgsl', jsFloats: 40, note: 'packPlantInstances' },
  'Visible':        { file: 'instance.wgsl', jsFloats: 4, note: 'VISIBLE_WORDS in render/lod.js' },
};
const FLOATS = { 'vec4f': 4, 'vec3f': 4, 'vec2f': 2, 'f32': 1, 'u32': 1, 'i32': 1 };
// Anything the JS side sizes with a named constant is cross-checked against
// that constant rather than against a number written twice.
const JS_CONSTANTS = [
  { file: 'src/render/lod.js', name: 'VISIBLE_WORDS', struct: 'Visible' },
  { file: 'src/geom/field.js', name: 'PLANT_INSTANCE_FLOATS', struct: 'PlantInstance' },
  { file: 'src/sim/sites.js',  name: 'SITE_FLOATS', struct: 'LandingSite' },
  { file: 'src/geom/flower.js', name: 'FLORET_INSTANCE_FLOATS', struct: 'FloretInstance' },
];
for (const [name, want] of Object.entries(STRUCT_EXPECT)) {
  const src = resolveIncludes(want.file);
  const m = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) { console.log(`struct ${name} not found in ${want.file}`); problems++; continue; }
  let floats = 0;
  for (const f of m[1].matchAll(/:\s*([A-Za-z0-9_<>]+)\s*,/g)) {
    const n = FLOATS[f[1]];
    if (n === undefined) { console.log(`struct ${name}: unhandled type ${f[1]}`); problems++; }
    else floats += n;
  }
  if (floats !== want.jsFloats) {
    console.log(`struct ${name}: WGSL is ${floats} floats but ${want.note} writes ${want.jsFloats}`);
    problems++;
  }
}

// --- the Globals uniform, field by field -----------------------------------
// This is the one struct where a wrong offset is completely silent: every
// field is a vec4f or a mat4x4f, so a mis-numbered slot does not fail
// validation, it just feeds the shader the wrong numbers -- the sun in the
// lens's slot, the screen size in the wind's. Offsets are recomputed from the
// WGSL declaration order using std140-style alignment and compared to the map
// in renderer.js field by field.
{
  const SIZES = { 'mat4x4f': [16, 16], 'vec4f': [4, 4], 'vec3f': [4, 3],
                  'vec2f': [2, 2], 'f32': [1, 1], 'u32': [1, 1], 'i32': [1, 1] };
  const src = resolveIncludes('common.wgsl');
  const m = /struct\s+Globals\s*\{([\s\S]*?)\n\}/.exec(src);
  const map = /const G = \{([\s\S]*?)\n\};/.exec(rendererSrc);
  if (!m || !map) { console.log('Globals: could not read both sides'); problems++; }
  else {
    const js = {};
    for (const e of map[1].matchAll(/(\w+):\s*(\d+)/g)) js[e[1]] = Number(e[2]);
    let offset = 0;
    const wgsl = {};
    for (const f of m[1].matchAll(/(\w+)\s*:\s*(\w+)\s*,/g)) {
      const [align, size] = SIZES[f[2]] || [];
      if (!align) { console.log(`Globals: unhandled type ${f[2]}`); problems++; continue; }
      offset = Math.ceil(offset / align) * align;
      wgsl[f[1]] = offset;
      offset += size;
    }
    for (const [name, off] of Object.entries(wgsl)) {
      if (js[name] === undefined) {
        console.log(`Globals: renderer.js has no offset for ${name}`); problems++;
      } else if (js[name] !== off) {
        console.log(`Globals.${name}: wgsl at float ${off}, renderer.js says ${js[name]}`);
        problems++;
      }
    }
    const total = Math.ceil(offset / 4) * 4;
    if (js.SIZE_FLOATS !== total) {
      console.log(`Globals: wgsl is ${total} floats, renderer.js SIZE_FLOATS is ${js.SIZE_FLOATS}`);
      problems++;
    }
    for (const name of Object.keys(js)) {
      if (name !== 'SIZE_FLOATS' && wgsl[name] === undefined) {
        console.log(`Globals: renderer.js has ${name}, which the WGSL struct does not`);
        problems++;
      }
    }
  }
}

// --- named JS sizes vs the WGSL structs they describe ----------------------
for (const c of JS_CONSTANTS) {
  const src = fs.readFileSync(c.file, 'utf8');
  const m = new RegExp(`${c.name}\\s*=\\s*(\\d+)`).exec(src);
  if (!m) { console.log(`${c.file}: ${c.name} not found`); problems++; continue; }
  const want = STRUCT_EXPECT[c.struct];
  if (Number(m[1]) !== want.jsFloats) {
    console.log(`${c.file}: ${c.name} is ${m[1]} but struct ${c.struct} is ${want.jsFloats} floats`);
    problems++;
  }
}

// --- constants written into both a shader and the renderer -----------------
// Each of these is a number the two sides have to agree on and that nothing
// else can catch: the instance stride the floret draw multiplexes on, and the
// ground disc's tessellation, which the renderer turns into a vertex count.
const pair = (name, jsRe, wgslFile, wgslRe, transform = (a) => a) => {
  const a = jsRe.exec(rendererSrc);
  const b = wgslRe.exec(resolveIncludes(wgslFile));
  if (!a || !b) { console.log(`${name}: could not read both sides`); problems++; return; }
  const js = transform(a.slice(1).map(Number));
  const wg = transform(b.slice(1).map(Number));
  if (js !== wg) { console.log(`${name}: renderer says ${js}, ${wgslFile} says ${wg}`); problems++; }
};
pair('FLORETS_PER_PLANT', /FLORETS_PER_PLANT = (\d+)/, 'floret.wgsl',
     /FLORETS_PER_PLANT : u32 = (\d+)u/, ([n]) => n);
pair('ground vertex count', /GROUND_VERTS = (\d+) \* (\d+) \* 6/, 'ground.wgsl',
     /RINGS\s+: u32 = (\d+)u;\s*\nconst SECTORS : u32 = (\d+)u/, ([r, s2]) => r * s2);

console.log(problems ? `\n${problems} problem(s)` : '\nall shader bindings and struct sizes match');
process.exit(problems ? 1 : 0);
