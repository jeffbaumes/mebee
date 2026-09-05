// Full WGSL validation via naga, the compiler wgpu itself uses.
//
// This exists because tools/check-shaders.mjs only *parses*: it accepts
// reserved words used as identifiers, type errors, and uniformity violations,
// all of which a real driver rejects. Run this before pushing anything that
// touches a shader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolveIncludes } from './check-shaders.mjs';

const require = createRequire(import.meta.url);
let naga;
try {
  naga = path.join(path.dirname(require.resolve('naga-wasi-cli/package.json')), 'bin', 'naga.mjs');
} catch {
  console.error('naga-wasi-cli is not installed. Run: npm install');
  process.exit(2);
}

// naga runs under WASI and can only see its own working directory, so the
// resolved sources have to be written somewhere it is launched from.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wgsl-'));
try {
  const files = fs.readdirSync('src/shaders').filter((f) => f.endsWith('.wgsl')).sort();
  for (const f of files) fs.writeFileSync(path.join(work, f), resolveIncludes(f));

  let failed = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, [naga, f], { cwd: work, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`
      .split('\n')
      .filter((l) => !/ExperimentalWarning|trace-warnings/.test(l))
      .join('\n')
      .trim();
    if (/Validation successful/.test(out)) {
      console.log(`  OK  ${f}`);
    } else {
      failed++;
      console.log(`FAIL  ${f}`);
      console.log(out.split('\n').map((l) => `      ${l}`).join('\n'));
    }
  }
  console.log(failed ? `\n${failed} shader(s) failed validation` : `\nall ${files.length} shaders validated`);
  process.exit(failed ? 1 : 0);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
