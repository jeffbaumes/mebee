// Parse every WGSL file (after resolving //!include) and report syntax errors.
import fs from 'node:fs';
import path from 'node:path';
import { WgslReflect } from '/tmp/claude-0/-home-user-mebee/4b8f0ee9-8a7a-5db3-91d9-0b1867ae71e5/scratchpad/val/node_modules/wgsl_reflect/wgsl_reflect.module.js';

const DIR = 'src/shaders';
export function resolveIncludes(file, seen = new Set()) {
  const abs = path.join(DIR, file);
  if (seen.has(abs)) return '';
  seen.add(abs);
  return fs.readFileSync(abs, 'utf8').replace(
    /^\/\/!include\s+(\S+)\s*$/gm,
    (_, inc) => resolveIncludes(inc, seen));
}

function main() {
let fail = 0;
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.wgsl')).sort();
for (const f of files) {
  const src = resolveIncludes(f);
  try {
    const r = new WgslReflect(src);
    const e = r.entry;
    const parts = [];
    if (e.vertex.length) parts.push(`vs:${e.vertex.map(x => x.name).join('/')}`);
    if (e.fragment.length) parts.push(`fs:${e.fragment.map(x => x.name).join('/')}`);
    if (e.compute.length) parts.push(`cs:${e.compute.map(x => x.name).join('/')}`);
    console.log(`  OK  ${f.padEnd(16)} ${String(src.split('\n').length).padStart(4)} lines  ${parts.join(' ') || '(library)'}`);
  } catch (err) {
    fail++;
    console.log(`FAIL  ${f.padEnd(16)} ${String(err.message || err).slice(0, 150)}`);
  }
}
console.log(fail ? `\n${fail} shader(s) failed to parse` : `\nall ${files.length} shaders parsed`);
process.exit(fail ? 1 : 0);
}

// Only run when invoked directly; check-bindings.mjs imports resolveIncludes.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
