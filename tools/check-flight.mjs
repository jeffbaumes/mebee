// Behavioural checks for the bee: control polarity, and the crawl surface's
// containment. Both are things that look obviously wrong the instant you fly
// the thing and are invisible in any static check -- the crawl turn shipped
// inverted relative to the flying turn, and nothing caught it.

import { BeeFlight, BOUNDS } from '../src/sim/flight.js';
import { HeadSites } from '../src/sim/sites.js';
import { FLOWER } from '../src/geom/flower.js';

const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

/**
 * A site table like the one wind.wgsl publishes; `tilt` leans the head over.
 *
 * One entry, because these checks are about the walk on a single head. The
 * table itself scales to the whole field -- see check-field for the sampler
 * and check-lod for what gets drawn.
 */
const headSites = (tilt = 0, headRadius = FLOWER.headRadius) => HeadSites.fromFrames([{
  pos: [0, FLOWER.stemHeight, 0],
  up: [Math.sin(tilt), Math.cos(tilt), 0],
  side: [Math.cos(tilt), -Math.sin(tilt), 0],
  velocity: [0, 0, 0],
  headRadius,
  discRadius: FLOWER.discRadius,
}]);
const headFrame = (tilt = 0, headRadius = FLOWER.headRadius) =>
  headSites(tilt, headRadius).frame(0);

/**
 * How far the view swings toward the camera's own right for a given stick.
 * lookAt builds screen-right as cross(forward, up), so this is the sign the
 * player actually sees, whatever parameterisation the mode uses underneath.
 */
function swing(mode, stickX, sites, { dir = [0, 1, 0], heading = 0 } = {}) {
  const bee = new BeeFlight();
  if (mode === 'crawl') {
    bee.mode = 'crawl';
    bee.plant = 0;
    bee.surfaceDir = dir;
    bee.surfaceHeading = heading;
  } else {
    bee.yaw = heading;
    bee.pitch = 0;
  }
  const f0 = norm(bee.viewForward(sites));
  const right = norm(cross(f0, norm(bee.upVector(sites))));
  bee.steer = [stickX, 0];
  for (let i = 0; i < 30; i++) bee.update(1 / 60, sites);
  const f1 = norm(bee.viewForward(sites));
  return dot([f1[0] - f0[0], f1[1] - f0[1], f1[2] - f0[2]], right);
}

console.log('turning the same way in both modes:');
const flat = headSites();
for (const stick of [-1, 1]) {
  const air = swing('fly', stick, flat);
  const want = stick < 0 ? 'left' : 'right';
  check(`stick ${want} flies ${want}`, Math.sign(air) === Math.sign(stick),
    `swing ${air.toFixed(3)}`);
  // Every posture on the dome, on an upright head and a leaning one.
  for (const frame of [flat, headSites(0.35)]) {
    for (const [where, dir, heading] of [
      ['the crown', [0, 1, 0], 0],
      ['mid-dome', norm([0.5, 0.8, 0.3]), 0.4],
      ['the rim', norm([0.9, 0.35, 0.2]), 2.2],
    ]) {
      const ground = swing('crawl', stick, frame, { dir, heading });
      check(`  and crawls ${want} at ${where}${frame === flat ? '' : ' (head tilted)'}`,
        Math.sign(ground) === Math.sign(stick), `swing ${ground.toFixed(3)}`);
    }
  }
}

console.log('\nthe walk cannot leave the dome:');
{
  let lowest = 1, ok = true;
  for (const sites of [flat, headSites(0.35)]) {
    for (let k = 0; k < 360; k++) {
      const bee = new BeeFlight();
      bee.mode = 'crawl';
      bee.plant = 0;
      bee.surfaceDir = [0, 1, 0];
      bee.surfaceHeading = (k / 360) * Math.PI * 2;
      bee.steer = [k % 5 === 0 ? 0.6 : 0, -1];
      for (let s = 0; s < 300; s++) {
        bee.update(1 / 60, sites);
        if (!bee.surfaceDir.every(Number.isFinite)) { ok = false; break; }
        lowest = Math.min(lowest, bee.surfaceDir[1]);
      }
    }
  }
  // The floor is CRAWL_MIN_ELEVATION in flight.js; assert it is positive and
  // held, rather than restating the constant and letting the two drift.
  check('stays above the rim, all headings, both postures', ok && lowest > 0.01,
    `lowest elevation sin ${lowest.toFixed(4)}`);
}

console.log('\nlanding seats the bee on the dome:');
for (const [name, p] of [
  ['from underneath', [0, FLOWER.stemHeight - 0.020, 0]],
  ['from the side', [0.045, FLOWER.stemHeight, 0]],
  ['from above', [0, FLOWER.stemHeight + 0.020, 0]],
]) {
  const bee = new BeeFlight();
  bee.position = p.slice();
  bee.land(headFrame());
  check(name, bee.surfaceDir.every(Number.isFinite) && bee.surfaceDir[1] > 0.01,
    `elevation sin ${bee.surfaceDir[1].toFixed(3)}`);
}

console.log('\nfree flight stays finite and inside the play volume:');
{
  const bee = new BeeFlight();
  let ok = true;
  for (let s = 0; s < 7200; s++) {
    bee.steer = [Math.sin(s * 0.03), Math.cos(s * 0.017)];
    bee.boost = (s % 120) < 40 ? 1 : 0;
    bee.update(1 / 60, flat);
    const p = bee.position;
    if (!p.every(Number.isFinite) || !Number.isFinite(bee.pitch)) { ok = false; break; }
    for (let a = 0; a < 3; a++) {
      if (p[a] < BOUNDS.min[a] - 1e-6 || p[a] > BOUNDS.max[a] + 1e-6) { ok = false; }
    }
    if (!ok) break;
  }
  check('120s soak, inside the meadow', ok,
    `ended ${bee.position.map((v) => v.toFixed(3)).join(', ')}, mode ${bee.mode}`);
}

// The field mixes a 78mm daisy with a 330mm cornflower, so the capture shell
// has to work at both sizes: too generous and the bee snags on a flower it
// flew past, too tight and it falls through the one it aimed at.
console.log('\nlanding works at every head size in the field:');
for (const [name, radius] of [['a common daisy', 0.011], ['an ox-eye', 0.028],
                              ['a corn marigold', 0.027]]) {
  const sites = headSites(0, radius);
  const f = sites.frame(0);
  // Straight down onto the crown from just outside the shell.
  const bee = new BeeFlight();
  bee.position = [0, FLOWER.stemHeight + radius * 0.5, 0];
  bee.velocity = [0, -0.05, 0];
  let landed = false;
  for (let i = 0; i < 400 && !landed; i++) {
    bee.update(1 / 60, sites);
    landed = bee.mode === 'crawl';
  }
  const eye = bee.position[1] - f.pos[1];
  check(`lands on ${name}`, landed && bee.plant === 0 && eye > 0,
    `eye ${(eye * 1000).toFixed(1)}mm above the head`);
  // And is not captured from well outside it.
  const far = new BeeFlight();
  far.position = [radius * 4, FLOWER.stemHeight, 0];
  far.velocity = [0, 0, 0];
  far.update(1 / 60, sites);
  check(`  ignores ${name} from ${(radius * 4000).toFixed(0)}mm out`, far.mode === 'fly');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall flight checks passed');
process.exit(failures ? 1 : 0);
