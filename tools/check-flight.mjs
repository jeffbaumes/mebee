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
 * How far the BEE's own heading swings toward its right for a given stick.
 *
 * Measured on the body, not on the camera. It used to be the camera, because
 * the camera used to BE the walk heading -- turning on the spot swung the
 * view. The two have since come apart (the pointer looks, the keys move), so
 * asking the camera which way the walk went now answers nothing. This is the
 * same question about the thing that still turns.
 */
function swing(stickX, sites, { dir = [0, 1, 0], heading = 0 } = {}) {
  const bee = new BeeFlight();
  bee.mode = 'crawl';
  bee.plant = 0;
  bee.surfaceDir = dir;
  bee.surfaceHeading = heading;
  const f0 = norm(bee.bodyForward(sites));
  const right = norm(cross(f0, norm(bee.upVector(sites))));
  bee.steer = [stickX, 0];
  for (let i = 0; i < 30; i++) bee.update(1 / 60, sites);
  const f1 = norm(bee.bodyForward(sites));
  return dot([f1[0] - f0[0], f1[1] - f0[1], f1[2] - f0[2]], right);
}

const flat = headSites();

console.log('the walk turns the way the stick is pushed:');
for (const stick of [-1, 1]) {
  const want = stick < 0 ? 'left' : 'right';
  // Every posture on the dome, on an upright head and a leaning one. The
  // crawl turn once shipped inverted and nothing static could have caught it.
  for (const frame of [flat, headSites(0.35)]) {
    for (const [where, dir, heading] of [
      ['the crown', [0, 1, 0], 0],
      ['mid-dome', norm([0.5, 0.8, 0.3]), 0.4],
      ['the rim', norm([0.9, 0.35, 0.2]), 2.2],
    ]) {
      const ground = swing(stick, frame, { dir, heading });
      check(`stick ${want} crawls ${want} at ${where}` +
            `${frame === flat ? '' : ' (head tilted)'}`,
        Math.sign(ground) === Math.sign(stick), `swing ${ground.toFixed(3)}`);
    }
  }
}

// The whole control scheme in one property: the pointer moves the camera and
// nothing else. Nothing static can see this -- an earlier model ran the thrust
// straight along the view, which reads as steering with the camera and passed
// every other check in this file.
console.log('\nthe camera alone never moves the bee:');
{
  const bee = new BeeFlight();
  bee.position[1] = 0.45;
  bee.steer = [0, -1];
  for (let i = 0; i < 180; i++) bee.update(1 / 60, flat);   // settle to a cruise
  const h0 = bee.heading;
  const v0 = norm(bee.velocity.slice());
  const p0 = bee.position.slice();

  // Everything released, and the orbit swung right round -- as far as a full
  // half-turn of aim would take the bee if the two were coupled.
  bee.steer = [0, 0];
  for (let i = 0; i < 60; i++) { bee.look(Math.PI / 60, 0.01); bee.update(1 / 60, flat); }
  check('a 180-degree orbit leaves the heading alone',
    Math.abs(bee.heading - h0) < 1e-9, `heading moved ${(bee.heading - h0).toFixed(6)} rad`);
  const bearing = (v) => Math.atan2(v[0], v[2]);
  const v1 = norm(bee.velocity.slice());
  const turned = Math.abs(((bearing(v1) - bearing(v0) + Math.PI * 3) %
                           (Math.PI * 2)) - Math.PI) * 180 / Math.PI;
  check('and the flight path with it', turned < 3,
    `bearing moved ${turned.toFixed(2)} deg over 1s`);
  const drift = Math.hypot(bee.position[0] - p0[0], bee.position[2] - p0[2]);
  check('and the bee keeps going the way it was', drift > 0.10,
    `${(drift * 1000).toFixed(0)}mm travelled`);

  // ...and W is what answers the camera. Same 180, this time with the throttle.
  bee.steer = [0, -1];
  for (let i = 0; i < 180; i++) bee.update(1 / 60, flat);
  const off = Math.abs(Math.atan2(Math.sin(bee.heading - bee.yaw),
                                  Math.cos(bee.heading - bee.yaw)));
  check('but holding W brings it round to face the camera', off < 0.02,
    `${(off * 180 / Math.PI).toFixed(2)} deg off the orbit heading`);
}

// A and D are the keyboard's half of the orbit, not a rudder. Nothing static
// can tell those two apart, and they feel completely different.
console.log('\nA and D swing the aim, not the bee:');
{
  const bee = new BeeFlight();
  bee.position[1] = 0.45;
  bee.heading = 0;
  bee.yaw = 0;
  bee.steer = [1, 0];                       // D alone, no throttle
  for (let i = 0; i < 60; i++) bee.update(1 / 60, flat);
  check('D alone swings the orbit', bee.yaw < -0.5, `yaw ${bee.yaw.toFixed(3)}`);
  check('  and leaves the bee pointing where it was', bee.heading === 0,
    `heading ${bee.heading.toFixed(6)}`);
  // Same sign as the mouse: look(-dx) for a rightward drag, yaw -= for D.
  const mouse = new BeeFlight();
  mouse.look(-0.5, 0);
  check('  the same way a rightward drag does', Math.sign(mouse.yaw - 0) < 0,
    `mouse yaw ${mouse.yaw.toFixed(3)}`);
}

// A turn with a radius, not a pivot. The bounded rate is the whole of what
// makes the aim feel like flying rather than like dragging an icon around.
console.log('\nthe bee arcs onto a new heading rather than snapping to it:');
{
  const bee = new BeeFlight();
  bee.position[1] = 0.45;
  bee.heading = 0;
  bee.yaw = 0;
  bee.steer = [0, -1];
  for (let i = 0; i < 180; i++) bee.update(1 / 60, flat);   // settle to a cruise
  bee.yaw = Math.PI / 2;                                    // a hard right turn
  let worst = 0, ticks = 0;
  let prev = bee.heading;
  while (Math.abs(bee.heading - Math.PI / 2) > 1e-3 && ticks < 600) {
    bee.update(1 / 60, flat);
    worst = Math.max(worst, Math.abs(bee.heading - prev) * 60);
    prev = bee.heading;
    ticks++;
  }
  const secs = ticks / 60;
  check('a 90-degree turn takes about as long as the rate allows',
    ticks < 600 && secs > 0.85 && secs < 1.4, `${secs.toFixed(2)}s`);
  // Radius is speed over turn rate; at this cruise that is a third of a metre,
  // which is a curve you can see across a seven-metre meadow.
  check('and the rate is bounded throughout', worst < 1.75,
    `peak ${worst.toFixed(2)} rad/s, radius about ` +
    `${(bee.airspeed / Math.max(1e-6, worst) * 1000).toFixed(0)}mm`);
}

// The other half of the same property, and since the recentring term came out
// it is absolute: the orbit is written by look() and by A/D, and by nothing
// else anywhere. There is no state of the bee -- climbing, cruising, walking,
// landing, turning hard -- that can reach it.
console.log('\nand nothing the bee does ever moves the camera:');
for (const [name, steer, boost, mode] of [
  ['climbing', [0, 0], 1, 'fly'],
  ['coasting', [0, 0], 0, 'fly'],
  ['cruising on W', [0, -1], 0, 'fly'],
  ['reversing on S', [0, 1], 0, 'fly'],
  ['walking a flower', [0, -1], 0, 'crawl'],
  ['turning on a flower', [1, 0], 0, 'crawl'],
]) {
  const bee = new BeeFlight();
  bee.mode = mode;
  if (mode === 'crawl') { bee.plant = 0; bee.surfaceDir = [0, 1, 0]; }
  bee.velocity = [0.3, 0, 0.2];
  bee.boost = boost;
  const yaw0 = bee.yaw, pitch0 = bee.pitch;
  for (let i = 0; i < 120; i++) {
    // Re-asserted each tick: A/D are a camera input in the air, so the check
    // has to be that the bee's own motion leaves the view alone, not that the
    // steer is never read.
    bee.steer = mode === 'crawl' ? steer : [0, steer[1]];
    bee.update(1 / 60, flat);
  }
  check(`${name} leaves the view exactly where it was`,
    bee.yaw === yaw0 && bee.pitch === pitch0,
    `yaw ${(bee.yaw - yaw0).toFixed(4)}, pitch ${(bee.pitch - pitch0).toFixed(4)}`);
}
{
  // Flying, W must not drag the orbit round: the bee comes to the camera, and
  // the camera coming to the bee as well would meet somewhere neither the
  // player nor the aim asked for.
  const bee = new BeeFlight();
  bee.heading = 0;
  bee.yaw = 1.0;
  bee.pitch = 0.6;
  bee.steer = [0, -1];
  const yaw0 = bee.yaw, pitch0 = bee.pitch;
  for (let i = 0; i < 120; i++) bee.update(1 / 60, flat);
  check('W brings the bee to the aim and leaves the aim alone',
    bee.yaw === yaw0 && bee.pitch === pitch0 && Math.abs(bee.heading - yaw0) < 0.02,
    `yaw held at ${bee.yaw.toFixed(3)}, heading ${bee.heading.toFixed(3)}`);
}

// look() is the only place a pointer writes the orbit, so the sign and the cap
// are its business alone. Getting "up looks down" wrong is the first thing a
// player notices and the last thing anything static would see.
console.log('\nthe look moves the way it is asked and no further:');
{
  const bee = new BeeFlight();
  const rest = bee.pitch;
  bee.look(0, 0.5);
  check('a positive pitch delta looks up', bee.pitch > rest + 0.49,
    `pitch ${bee.pitch.toFixed(3)}`);
  bee.look(0, -1.0);
  check('and a negative one looks down', bee.pitch < rest - 0.49,
    `pitch ${bee.pitch.toFixed(3)}`);
  // The flying camera's up is world up, so a look straight down it has no
  // defined roll: the cap has to hold however hard it is pushed.
  let ok = true;
  for (const d of [1, -1]) {
    for (let i = 0; i < 400; i++) {
      bee.look(0.1 * d, 0.1 * d);
      if (!Number.isFinite(bee.pitch) || Math.abs(bee.pitch) > Math.PI / 2 - 0.05) ok = false;
    }
  }
  check('and stops short of straight up and straight down', ok,
    `|pitch| held under ${(Math.PI / 2 - 0.05).toFixed(2)}`);
}

// Forward and up are separate axes, and each one has to stay out of the
// other's business -- a W that climbed, or a lift that crept forward, would
// put the bee somewhere other than where the two controls said.
console.log('\nthe throttle drives, the lift climbs, and neither does both:');
{
  // Started a metre off the origin, because the origin is where the test
  // flower stands: a sinking bee left over it gets captured by its shell
  // partway through, and the run then measures a landing rather than a sink.
  const at = (setup, frames = 300) => {
    const bee = new BeeFlight();
    bee.position = [1.0, 0.45, 1.0];
    setup(bee);
    const y0 = bee.position[1];
    for (let i = 0; i < frames; i++) bee.update(1 / 60, flat);
    return { bee, climb: bee.position[1] - y0,
             horiz: Math.hypot(bee.velocity[0], bee.velocity[2]) };
  };

  const cruise = at((b) => { b.steer = [0, -1]; });
  check('W builds a cruise', cruise.horiz > 0.55, `${cruise.horiz.toFixed(2)} m/s`);
  check('  and holds height while it does', Math.abs(cruise.climb) < 0.10,
    `${(cruise.climb * 1000).toFixed(0)}mm over 5s`);

  const idle = at(() => {});
  check('nothing held sinks', idle.climb < -0.20,
    `${(idle.climb * 1000).toFixed(0)}mm over 5s`);

  const lift = at((b) => { b.boost = 1; });
  check('space climbs', lift.climb > 0.20, `${(lift.climb * 1000).toFixed(0)}mm over 5s`);
  check('  with nothing forward in it', lift.horiz < 0.01,
    `${(lift.horiz * 1000).toFixed(1)}mm/s`);

  // S is W with the sign flipped, and nothing else about it different: same
  // magnitude, same turn onto the aim, and the wing carries it just the same
  // because airspeed has no sign.
  // Started at the near wall and pointed at the far one, so three seconds each
  // way stays clear of the cushion at both ends -- braked into a wall, the two
  // runs would not be comparable and the check would be measuring the meadow.
  const back = new BeeFlight();
  back.position = [1.0, 0.45, -1.6];
  back.heading = 0;
  back.yaw = 0;
  back.steer = [0, -1];
  for (let i = 0; i < 180; i++) back.update(1 / 60, flat);
  const fwd = back.velocity[2];
  back.steer = [0, 1];
  for (let i = 0; i < 300; i++) back.update(1 / 60, flat);
  check('S reverses the cruise', back.velocity[2] < -0.55,
    `${fwd.toFixed(2)} m/s forward, ${back.velocity[2].toFixed(2)} back`);
  check('  at the same speed W makes going the other way',
    Math.abs(Math.abs(back.velocity[2]) - Math.abs(fwd)) < 0.02,
    `${Math.abs(Math.abs(back.velocity[2]) - fwd).toFixed(3)} m/s apart`);
  check('  and the wing carries it just the same', Math.abs(back.velocity[1]) < 0.02,
    `vy ${back.velocity[1].toFixed(3)} m/s`);

  // Reversing steers, because the turn is gated on the throttle's magnitude:
  // the nose comes onto the aim and the bee backs AWAY from it.
  // Aimed at +x and backing off toward -x, so it starts on the +x side with
  // the whole meadow behind it -- see the note above about the cushion.
  const away = new BeeFlight();
  away.position = [1.6, 0.45, 1.0];
  away.heading = 0;
  away.yaw = Math.PI / 2;
  away.steer = [0, 1];
  for (let i = 0; i < 300; i++) away.update(1 / 60, flat);
  check('S brings the nose onto the aim too', Math.abs(away.heading - Math.PI / 2) < 0.02,
    `heading ${away.heading.toFixed(3)}`);
  check('  and backs the bee away along it', away.velocity[0] < -0.55,
    `vx ${away.velocity[0].toFixed(2)} m/s against an aim of +x`);
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
    if (!p.every(Number.isFinite) || !Number.isFinite(bee.pitch) ||
        !Number.isFinite(bee.yaw) || !Number.isFinite(bee.heading)) { ok = false; break; }
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
