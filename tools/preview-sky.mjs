import fs from 'node:fs';
import { encodePNG } from './png.mjs';
import { skyRadiance, projectSkySH, shToIrradiance } from '../src/render/sky.js';

const S = 400;
const elevations = [40, 12, 4, 1];   // degrees above horizon
const cols = elevations.length;
const out = new Uint8Array(S * cols * S * 4);

// ACES-ish tonemap so the preview matches what the shader will do.
const aces = (x) => {
  const a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return Math.min(1, Math.max(0, (x*(a*x+b))/(x*(c*x+d)+e)));
};

elevations.forEach((elev, col) => {
  const th = elev * Math.PI/180;
  const sun = [Math.cos(th), Math.sin(th), 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Hemispherical fisheye: zenith at centre, horizon at the rim.
      const u = (x + 0.5)/S*2 - 1, v = (y + 0.5)/S*2 - 1;
      const r = Math.hypot(u, v);
      const o = (y * S * cols + col * S + x) * 4;
      if (r > 1) { out[o]=out[o+1]=out[o+2]=14; out[o+3]=255; continue; }
      const phi = Math.atan2(v, u), theta = r * Math.PI/2;
      const d = [Math.sin(theta)*Math.cos(phi), Math.cos(theta), Math.sin(theta)*Math.sin(phi)];
      const L = skyRadiance(d, sun);
      for (let c = 0; c < 3; c++) out[o+c] = 255 * Math.pow(aces(L[c]), 1/2.2);
      out[o+3] = 255;
    }
  }
  const irr = shToIrradiance(projectSkySH(sun, 2048));
  console.log(`elev ${String(elev).padStart(2)}deg  ambient(DC) rgb =`,
    irr[0].map(v=>v.toFixed(3)).join(', '));
});
fs.writeFileSync(process.argv[2], encodePNG(out, S*cols, S));
console.log('wrote', process.argv[2]);
