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
// The aim is stored as a direction (bee.lookDir, read via forward()), not as
// yaw/pitch angles -- see the gimbal-lock note on BeeFlight.look(). Every bee
// below stays in fly mode, where up is world Y throughout, so recovering an
// equivalent yaw/pitch from the direction is exact.
const pitchOf = (v) => Math.asin(Math.max(-1, Math.min(1, v[1])));
const yawOf = (v) => Math.atan2(v[0], v[2]);

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
 * Measured on the body, not on the camera. On a flower the two are still
 * separate -- the pointer looks, the stick turns the walk -- so asking the
 * camera which way the walk went answers nothing. This is the same question
 * about the thing that still turns.
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

// The whole control scheme in one property, now: the mouse is the only aim,
// and the bee always points exactly away from it, with nothing eased and
// nothing left for a key to do. Nothing static can see this -- an earlier
// model ran a bounded turn rate onto the aim, and a version before that ran
// thrust straight along the view; both passed every other check in this file.
console.log('\nflying, the bee always points dead away from the camera:');
{
  const bee = new BeeFlight();
  bee.steer = [0, -1];
  for (let i = 0; i < 30; i++) bee.update(1 / 60, flat);
  const f0 = bee.forward();
  check('facing matches forward() to start', dot(norm(bee.facing), f0) > 0.999999,
    `dot ${dot(norm(bee.facing), f0).toFixed(6)}`);

  // A hard swing of the aim, and the facing follows in the very same tick --
  // no lag, no arc, because there is no turn rate left to bound it.
  bee.look(Math.PI * 0.7, 0.4);
  const wanted = bee.forward();
  bee.update(1 / 60, flat);
  check('and a hard swing of the aim is matched the same tick, not eased onto',
    dot(norm(bee.facing), wanted) > 0.999,
    `dot ${dot(norm(bee.facing), wanted).toFixed(6)}`);
}

console.log('\nA/D do nothing while flying:');
{
  // From a standing start, and from a cruise: either way, deflecting the
  // stick's x axis for two seconds must not move the aim at all. On a flower
  // the same axis turns the walk (see above) -- only in the air is it dead.
  for (const [name, primeSteer] of [['from rest', [0, 0]], ['from a cruise', [0, -1]]]) {
    const bee = new BeeFlight();
    bee.steer = primeSteer;
    for (let i = 0; i < 90; i++) bee.update(1 / 60, flat);
    const aim0 = bee.forward().slice();
    const facing0 = bee.facing.slice();
    bee.steer = [1, primeSteer[1]];
    for (let i = 0; i < 120; i++) bee.update(1 / 60, flat);
    check(`A/D ${name} leaves the aim exactly where it was`,
      dot(bee.forward(), aim0) > 0.999999999,
      `dot ${dot(bee.forward(), aim0).toFixed(9)}`);
    check(`  and the facing with it`, dot(norm(bee.facing), norm(facing0)) > 0.999999,
      `dot ${dot(norm(bee.facing), norm(facing0)).toFixed(6)}`);
  }
}

// look() is the only place a pointer writes the orbit, so the sign and the cap
// are its business alone. Getting "up looks down" wrong is the first thing a
// player notices and the last thing anything static would see.
console.log('\nthe look moves the way it is asked and no further:');
{
  const bee = new BeeFlight();
  const rest = pitchOf(bee.forward());
  bee.look(0, 0.5);
  check('a positive pitch delta looks up', pitchOf(bee.forward()) > rest + 0.49,
    `pitch ${pitchOf(bee.forward()).toFixed(3)}`);
  bee.look(0, -1.0);
  check('and a negative one looks down', pitchOf(bee.forward()) < rest - 0.49,
    `pitch ${pitchOf(bee.forward()).toFixed(3)}`);
  // The flying camera's up is world up, so a look straight down it has no
  // defined roll: the cap has to hold however hard it is pushed.
  let ok = true;
  for (const d of [1, -1]) {
    for (let i = 0; i < 400; i++) {
      bee.look(0.1 * d, 0.1 * d);
      const p = pitchOf(bee.forward());
      if (!Number.isFinite(p) || Math.abs(p) > Math.PI / 2 - 0.05) ok = false;
    }
  }
  check('and stops short of straight up and straight down', ok,
    `|pitch| held under ${(Math.PI / 2 - 0.05).toFixed(2)}`);
}

// A single look() call carries a whole gesture's delta, not one pixel's --
// a fast trackpad swipe or a big mouse-drag callback hands over a large
// dPitch in one call. Rotating the aim by that much in one step could carry
// it past the pole and out the other side, which the elevation clamp then
// caught -- but on a bearing already flipped, reading as the view facing
// backwards for exactly one frame before the next, smaller input corrected
// it. That is the flip look() itself has to absorb, not just the steady-hand
// case above.
console.log('\na single large look() delta saturates instead of flipping through the pole:');
{
  const bee = new BeeFlight();
  bee.look(0, 0.6);                        // look up a bit, off centre in yaw too
  bee.look(0.3, 0);
  const before = bee.forward().slice();
  bee.look(0, -2.7);                       // one big downward swipe, > pi/2
  const after = bee.forward().slice();
  // Saturating rather than flipping means the bearing (yaw) barely moves even
  // though the delta was huge -- a flip through the pole reverses it instead.
  const bearingShift = Math.acos(Math.max(-1, Math.min(1,
    dot(norm([before[0], 0, before[2]]), norm([after[0], 0, after[2]])))));
  check('one large downward swipe holds the bearing, does not reverse it',
    bearingShift < 0.5, `bearing moved ${bearingShift.toFixed(3)} rad`);
  check('  and lands at the pitch limit, not past it',
    pitchOf(after) < -1.3, `pitch ${pitchOf(after).toFixed(3)}`);
  // And the same swipe split across many small calls -- a steady drag rather
  // than one big callback -- has to land in the same place.
  const bee2 = new BeeFlight();
  bee2.look(0, 0.6);
  bee2.look(0.3, 0);
  for (let i = 0; i < 270; i++) bee2.look(0, -0.01);
  check('  matching what the same total delta does in small steps',
    dot(after, bee2.forward()) > 0.999,
    `dot ${dot(after, bee2.forward()).toFixed(6)}`);
}

// Crawling near the rim, the surface normal leans up to ~46 degrees off
// vertical (see CRAWL_MIN_ELEVATION) -- nothing like world Y. Clamping the
// look against world Y regardless (the old PITCH_LIMIT) left the flower's own
// "straight up" well inside the reachable view, and swinging the aim through
// it read as gimbal lock -- the same yaw-sensitivity spike as any FPS camera
// looking straight up, except the pole a crawl could hit was wherever the
// flower happened to lean rather than one PITCH_LIMIT had already fenced off.
console.log("\ncrawling, the look is capped against the flower's own pole, not world Y's:");
{
  const bee = new BeeFlight();
  bee.mode = 'crawl';
  bee.plant = 0;
  bee.surfaceDir = norm([0.9, 0.35, 0.2]);   // near the rim, well off vertical
  const sites = flat;
  const maxSin = Math.sin(1.35) + 1e-6;      // PITCH_LIMIT, mirrored here
  let ok = true, worst = 0;
  for (const d of [1, -1]) {
    for (let i = 0; i < 400; i++) {
      bee.look(0.1 * d, 0.1 * d, sites);
      const f = bee.forward();
      const up = bee.upVector(sites);
      if (!f.every(Number.isFinite)) { ok = false; break; }
      const s = Math.abs(dot(f, up));
      worst = Math.max(worst, s);
      if (s > maxSin) ok = false;
    }
  }
  check("stays off the flower's pole however hard the look is pushed", ok,
    `|dot(aim, surface up)| held under ${maxSin.toFixed(3)}, worst ${worst.toFixed(3)}`);
}

// There is no gravity any more: nothing held holds still rather than sinking,
// and going is entirely a matter of where the camera is pointed -- looking up
// and holding W climbs, looking down dives, and space lifts straight up
// regardless of the aim.
console.log('\nthere is no gravity, and thrust runs along the full look direction:');
{
  const bee = new BeeFlight();
  bee.position = [1.0, 0.45, 1.0];
  const y0 = bee.position[1];
  for (let i = 0; i < 300; i++) bee.update(1 / 60, flat);   // nothing held
  check('nothing held holds still rather than sinking',
    Math.abs(bee.position[1] - y0) < 0.01,
    `drifted ${((bee.position[1] - y0) * 1000).toFixed(1)}mm over 5s`);
  check('  and comes to rest', bee.airspeed < 0.01, `airspeed ${bee.airspeed.toFixed(4)} m/s`);

  const climbing = new BeeFlight();
  climbing.position = [1.0, 0.45, 1.0];
  climbing.look(0, 0.6);                     // look well up
  climbing.steer = [0, -1];                  // and hold W
  const yc0 = climbing.position[1];
  for (let i = 0; i < 180; i++) climbing.update(1 / 60, flat);
  check('W while looking up climbs', climbing.position[1] - yc0 > 0.15,
    `climbed ${((climbing.position[1] - yc0) * 1000).toFixed(0)}mm over 3s`);

  const diving = new BeeFlight();
  diving.position = [1.0, 0.60, 1.0];
  diving.look(0, -0.6);                      // look well down
  diving.steer = [0, -1];                    // and hold W
  const yd0 = diving.position[1];
  for (let i = 0; i < 180; i++) diving.update(1 / 60, flat);
  check('W while looking down dives', diving.position[1] - yd0 < -0.15,
    `dropped ${((diving.position[1] - yd0) * 1000).toFixed(0)}mm over 3s`);

  const lift = new BeeFlight();
  lift.position = [1.0, 0.45, 1.0];
  lift.look(1.1, 0.3);                       // aim somewhere unrelated
  lift.boost = 1;
  const yl0 = lift.position[1];
  for (let i = 0; i < 180; i++) lift.update(1 / 60, flat);
  check('space climbs regardless of the aim', lift.position[1] - yl0 > 0.15,
    `climbed ${((lift.position[1] - yl0) * 1000).toFixed(0)}mm over 3s`);
  check('  with nothing horizontal in it',
    Math.hypot(lift.velocity[0], lift.velocity[2]) < 0.01,
    `${(Math.hypot(lift.velocity[0], lift.velocity[2]) * 1000).toFixed(1)}mm/s`);
}

// S is W with the sign flipped, and nothing else about it different: same
// magnitude cruise, the other way along the same facing.
console.log('\nS reverses the cruise W makes:');
{
  const fwd = new BeeFlight();
  fwd.position = [1.0, 0.45, -1.6];
  fwd.steer = [0, -1];
  for (let i = 0; i < 180; i++) fwd.update(1 / 60, flat);
  const back = new BeeFlight();
  back.position = [1.0, 0.45, -1.6];
  back.steer = [0, 1];
  for (let i = 0; i < 180; i++) back.update(1 / 60, flat);
  check('S builds a cruise the opposite way', Math.sign(back.velocity[2]) !== Math.sign(fwd.velocity[2]),
    `W: ${fwd.velocity[2].toFixed(2)} m/s, S: ${back.velocity[2].toFixed(2)} m/s`);
  check('  at the same speed', Math.abs(Math.abs(back.velocity[2]) - Math.abs(fwd.velocity[2])) < 0.02,
    `${Math.abs(Math.abs(back.velocity[2]) - Math.abs(fwd.velocity[2])).toFixed(3)} m/s apart`);
}

// The throttle behind W/S is eased, not instant, and the two directions ease
// at different rates: winding up to speed is a slow beat, letting go sheds it
// fast. Nothing static could see the asymmetry -- both a snap and a smooth,
// symmetric ease would pass every other check here.
console.log('\nthe throttle winds up slowly and sheds quickly:');
{
  const rise = new BeeFlight();
  rise.steer = [0, -1];
  for (let i = 0; i < 18; i++) rise.update(1 / 60, flat);   // 0.3s from rest
  check('0.3s of W does not reach full throttle', rise.throttle < 0.6,
    `throttle ${rise.throttle.toFixed(3)}`);

  const settle = new BeeFlight();
  settle.steer = [0, -1];
  for (let i = 0; i < 180; i++) settle.update(1 / 60, flat);   // a full cruise
  check('  but holding it long enough gets there', settle.throttle > 0.95,
    `throttle ${settle.throttle.toFixed(3)}`);
  settle.steer = [0, 0];
  for (let i = 0; i < 18; i++) settle.update(1 / 60, flat);   // let go for 0.3s
  check('and letting go for the same 0.3s sheds most of it', settle.throttle < 0.2,
    `throttle ${settle.throttle.toFixed(3)}`);
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

// A bee diving to land is looking about as far down as flying allows -- aim
// clamped to PITCH_LIMIT off world Y, the up in play right up to the instant
// of touchdown. The flower it lands on can lean up to ~46 degrees off world Y
// of its own accord, so the SAME stored aim can end up much closer to the
// landing site's own pole than it ever was to world Y's -- with no pointer
// motion in between to give look() a chance to re-clamp it. That gap is what
// reclampLook() (called from land()'s caller, update()) exists to close; this
// reproduces it directly against land() to check the invariant, not just the
// feel of it.
console.log("\nlanding while looking down never leaves the aim against the landing site's own pole:");
{
  const pitchVal = -1.35, yawVal = -Math.PI / 2;   // as far down as flying allows
  const cp = Math.cos(pitchVal);
  const diveLook = [Math.sin(yawVal) * cp, Math.sin(pitchVal), Math.cos(yawVal) * cp];
  const maxSin = Math.sin(1.35) + 1e-6;            // PITCH_LIMIT, mirrored here
  // This tilt is chosen adversarially -- see check above: dot(diveLook, up)
  // goes from -0.976 at tilt 0 to -0.997 at tilt 0.3, which is what a bee
  // landing with this exact aim and no reclamp used to end up with.
  const sites = headSites(0.3);
  const bee = new BeeFlight();
  bee.lookDir = diveLook.slice();
  bee.position = [0, FLOWER.stemHeight + 0.020, 0];
  bee.land(sites.frame(0));
  bee.reclampLook(sites);
  const f = bee.forward(), up = bee.upVector(sites);
  check('aim stays off the new up\'s pole', Math.abs(dot(f, up)) <= maxSin,
    `|dot(aim, up)| ${Math.abs(dot(f, up)).toFixed(4)}, limit ${maxSin.toFixed(4)}`);
}

// The same gap, without ever landing: a flower already stood on sways on its
// own (wind.wgsl), so "up" keeps moving every frame with no pointer motion at
// all. update() has to reclamp on every tick it runs, not just the ticks a
// look() happens to land on, or a still mouse over a gusty flower would drift
// the aim onto the pole exactly the same way landing did above.
console.log('\ncrawling, a swaying flower cannot walk the aim onto its own pole either:');
{
  const bee = new BeeFlight();
  bee.mode = 'crawl';
  bee.plant = 0;
  bee.surfaceDir = [0, 1, 0];
  const pitchVal = -1.35, yawVal = -Math.PI / 2;
  const cp = Math.cos(pitchVal);
  bee.lookDir = [Math.sin(yawVal) * cp, Math.sin(pitchVal), Math.cos(yawVal) * cp];
  const maxSin = Math.sin(1.35) + 1e-6;
  let ok = true, worst = 0;
  for (let i = 0; i <= 60; i++) {
    const tilt = 0.3 * Math.sin(i / 10);   // the flower sways back and forth
    const sites = headSites(tilt);
    bee.update(1 / 600, sites);            // a tiny step, to isolate the sway from the walk
    const f = bee.forward(), up = bee.upVector(sites);
    if (!f.every(Number.isFinite)) { ok = false; break; }
    const s = Math.abs(dot(f, up));
    worst = Math.max(worst, s);
    if (s > maxSin) ok = false;
  }
  check('stays off the pole as the head sways, with no pointer input at all', ok,
    `|dot(aim, up)| held under ${maxSin.toFixed(3)}, worst ${worst.toFixed(3)}`);
}

console.log('\nfree flight stays finite and inside the play volume:');
{
  const bee = new BeeFlight();
  let ok = true;
  for (let s = 0; s < 7200; s++) {
    bee.steer = [Math.sin(s * 0.03), Math.cos(s * 0.017)];
    bee.boost = (s % 120) < 40 ? 1 : 0;
    if (s % 200 === 0) bee.look(0.3, 0.15);
    bee.update(1 / 60, flat);
    const p = bee.position;
    if (!p.every(Number.isFinite) || !bee.forward().every(Number.isFinite) ||
        !Number.isFinite(bee.throttle) ||
        !bee.facing.every(Number.isFinite)) { ok = false; break; }
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

// The lean is a damped spring on top of the drawn mesh only -- see
// visualState and SWAY_*. Nothing here may leak into the actual flight
// model: a bank that nudged the aim or the velocity would be a physics bug
// wearing a cosmetic one's name.
console.log('\nthe g-force lean banks into a turn, settles back, and never touches the flight itself:');
{
  const bee = new BeeFlight();
  bee.steer = [0, -1];                       // build a cruise
  for (let i = 0; i < 120; i++) bee.update(1 / 60, flat);
  bee.look(1.3, 0, flat);                    // swing the aim hard -- a turn
  let peak = 0, aimAtPeak = null, visAtPeak = null;
  for (let i = 0; i < 30; i++) {
    bee.update(1 / 60, flat);
    if (Math.abs(bee.swayRoll) > peak) {
      peak = Math.abs(bee.swayRoll);
      aimAtPeak = bee.forward().slice();
      visAtPeak = bee.visualState(flat).forward;
    }
  }
  check('a hard turn banks the model', peak > 0.05, `peak roll ${peak.toFixed(3)} rad`);
  check('  never past the clamp', peak <= 0.30 + 1e-6, `peak roll ${peak.toFixed(3)} rad`);
  check('  while the model banks, the aim itself stays exactly what look() set',
    dot(aimAtPeak, visAtPeak) < 0.9999999,
    `dot(aim, drawn model) ${dot(aimAtPeak, visAtPeak).toFixed(6)}`);

  bee.steer = [0, -1];                       // hold straight again
  for (let i = 0; i < 180; i++) bee.update(1 / 60, flat);
  check('  and settles back near level once the turn is over',
    Math.abs(bee.swayRoll) < 0.01, `roll ${bee.swayRoll.toFixed(4)} rad after 3s straight`);

  // Same look() swing and cruise, run again but ask visualState for the
  // cosmetic basis at every step -- position, velocity, and the aim must land
  // in exactly the same place either way, or the "cosmetic" lean would not be.
  const twin = new BeeFlight();
  twin.steer = [0, -1];
  for (let i = 0; i < 120; i++) twin.update(1 / 60, flat);
  twin.look(1.3, 0, flat);
  for (let i = 0; i < 30; i++) { twin.update(1 / 60, flat); twin.visualState(flat); }
  twin.steer = [0, -1];
  for (let i = 0; i < 180; i++) { twin.update(1 / 60, flat); twin.visualState(flat); }
  check('reading the cosmetic lean changes nothing about the flight',
    bee.position.every((v, i) => v === twin.position[i]) &&
    bee.velocity.every((v, i) => v === twin.velocity[i]) &&
    dot(bee.forward(), twin.forward()) > 0.999999999,
    `pos equal ${JSON.stringify(bee.position) === JSON.stringify(twin.position)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall flight checks passed');
process.exit(failures ? 1 : 0);
