// Every module parses, and every module that can run without a GPU does.
//
// `renderer.js` and `main.js` are the two largest files in the project and
// neither can be imported here -- one builds GPU resources in its constructor,
// the other boots against the DOM on import. A syntax pass is a low bar, but
// it is the difference between a typo shipping and a typo failing the check,
// and it is the only mechanical check those two files get at all.
//
// Everything else is imported for real, which is a much higher bar: a bad
// import path, a missing export, or anything that throws at module scope
// fails here rather than as a blank page.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`); failures++; }
};

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.m?js$/.test(e.name) ? [p] : [];
  });
}

const files = [...walk('src'), ...walk('tools')].sort();
console.log(`syntax (${files.length} modules):`);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  check(f, r.status === 0, (r.stderr || '').split('\n').slice(0, 3).join(' ').trim());
}
console.log(failures ? `  ${failures} did not parse` : '  all parse');

// Everything with no DOM or WebGPU dependency, imported for real.
const HEADLESS = [
  '../src/geom/mesh.js', '../src/geom/rand.js', '../src/geom/species.js',
  '../src/geom/field.js', '../src/geom/flower.js', '../src/geom/grass.js',
  '../src/geom/venation.js', '../src/render/math.js', '../src/render/sky.js',
  '../src/render/camera.js', '../src/render/lod.js',
  '../src/sim/sites.js', '../src/sim/flight.js',
];
console.log(`\nimport (${HEADLESS.length} modules):`);
const before = failures;
for (const m of HEADLESS) {
  try { await import(m); } catch (e) { check(m, false, e.message); }
}
console.log(failures === before ? '  all import cleanly' : '  see above');

// The two the app cannot start without, and their include graph. A shader
// listed in renderer.js but missing from disk, or an //!include that does not
// resolve, is a blank page with a 404 in the console and nothing else.
console.log('\nshader loader:');
const rjs = fs.readFileSync('src/render/renderer.js', 'utf8');
const names = /const names = \[([\s\S]*?)\];/.exec(rjs);
check('renderer.js declares its shader list', !!names);
if (names) {
  const list = [...names[1].matchAll(/'([\w.]+\.wgsl)'/g)].map((m) => m[1]);
  check('the list is not empty', list.length > 0);
  for (const n of list) {
    check(`${n} exists`, fs.existsSync(path.join('src/shaders', n)));
  }
  // Includes are resolved by fetch at runtime, so a bad path is a 404.
  const seen = new Set();
  const resolve = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    const p = path.join('src/shaders', n);
    if (!fs.existsSync(p)) { check(`include ${n} resolves`, false); return; }
    for (const m of fs.readFileSync(p, 'utf8').matchAll(/^\/\/!include\s+(\S+)\s*$/gm)) {
      resolve(m[1]);
    }
  };
  list.forEach(resolve);
  // Anything on disk that nothing reaches is either dead or a forgotten wiring.
  const onDisk = fs.readdirSync('src/shaders').filter((f) => f.endsWith('.wgsl'));
  const orphans = onDisk.filter((f) => !seen.has(f));
  check('no shader is orphaned', orphans.length === 0, orphans.join(', '));
  console.log(`  ${list.length} modules loaded, ${seen.size} of ${onDisk.length} ` +
              `files reached through their includes`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall module checks passed');
process.exit(failures ? 1 : 0);
