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
  'shadow.wgsl':      ['bgl0', 'bglStemOnly'],
  'sky.wgsl':         ['bgl0'],
  'plant.wgsl':       ['bgl0', 'bglPlant', 'bglMaterial'],
  'floret.wgsl':      ['bgl0', 'bglFloret'],
  'dof.wgsl':         ['bgl0', 'bglDof'],
  'bloom.wgsl':       ['bgl0', 'bglBloom'],
  'post.wgsl':        ['bgl0', 'bglPost'],
};

// Parse the layouts straight out of renderer.js so the two cannot drift.
const js = fs.readFileSync('src/render/renderer.js', 'utf8');
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
console.log(problems ? `\n${problems} binding problem(s)` : '\nall shader bindings match their pipeline layouts');
process.exit(problems ? 1 : 0);
