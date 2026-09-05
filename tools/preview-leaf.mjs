import fs from 'node:fs';
import { growVenation, bakeLeafMaps } from '../src/geom/venation.js';
import { encodePNG } from './png.mjs';

const OUT = process.argv[2] || '/tmp/leaf.png';
const S = Number(process.argv[3] || 640);

const t0 = Date.now();
const ven = growVenation(undefined, { seed: Number(process.argv[4] || 1) });
const maps = bakeLeafMaps(ven, S, { seed: 3, holes: 2 });
console.log(`grow+bake ${ven.nodes.length} nodes @${S} in ${Date.now() - t0}ms`);

const out = new Uint8Array(S * S * 4);
for (let i = 0; i < S * S; i++) {
  const o = i * 4;
  const cov = maps.veinMap[o + 3] / 255;
  const ridge = maps.veinMap[o] / 255;
  const mot = maps.detailMap[o + 1] / 255;
  const nec = maps.detailMap[o + 2] / 255;
  const ao = maps.detailMap[o + 3] / 255;
  let r = 0.13 + 0.10 * mot, g = 0.40 + 0.18 * mot, b = 0.09 + 0.05 * mot;
  r = r * (1 - ridge * 0.55) + ridge * 0.60;
  g = g * (1 - ridge * 0.30) + ridge * 0.68;
  b = b * (1 - ridge * 0.55) + ridge * 0.33;
  r *= ao; g *= ao; b *= ao;
  r = r * (1 - nec) + 0.42 * nec; g = g * (1 - nec) + 0.26 * nec; b = b * (1 - nec) + 0.07 * nec;
  const chk = ((((i % S) >> 4) + ((i / S | 0) >> 4)) % 2) ? 0.20 : 0.28;
  out[o] = 255 * (r * cov + chk * (1 - cov));
  out[o + 1] = 255 * (g * cov + chk * (1 - cov));
  out[o + 2] = 255 * (b * cov + chk * (1 - cov));
  out[o + 3] = 255;
}
fs.writeFileSync(OUT, encodePNG(out, S, S));
console.log('wrote', OUT);
