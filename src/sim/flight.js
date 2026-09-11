// Bee flight.
//
// The camera says where to go and the keys decide whether to go there. The
// pointer orbits the camera around the bee, A and D swing that orbit from the
// keyboard, and the direction the camera faces is the heading being ASKED for.
// W is what answers: hold it and the bee arcs onto that heading at a bounded
// turn rate and drives along it, so a change of aim is a curve with a real
// radius rather than the bee pivoting on the spot. S is the same thing with
// the sign flipped -- the nose still comes round onto the camera's heading and
// the bee backs away along it, which is how a real bee reverses and what makes
// S a brake in practice without being written as one. Space lifts straight up.
//
// That gating matters and is the whole reason the two halves stay separate:
// the camera never moves the bee. Swing it all the way round with nothing held
// and the bee carries on exactly as it was, seen from a new angle. It is W
// that turns the bee, toward wherever the camera happens to be pointing when
// you press it.
//
// And nothing here ever moves the camera. There was briefly a recentring term
// that eased the orbit round to sit behind the bee while a movement key was
// held; it is gone, because W flying AWAY from the camera does the same job
// from the other end and does it without ever taking the orbit off the player.
// Drive on the keys and the bee lines up under the camera on its own.
//
// It is still an elytra rather than a hovercraft: gravity is always on, and
// the wing only carries its own weight once there is speed over it. Speed in
// either direction, so a reverse cruise holds height exactly as a forward one
// does -- lift goes as the square of the airspeed, and airspeed has no sign.
//
// Which means the descent is simply letting go. Nothing held is no thrust, no
// speed and therefore no lift, and what is left is gravity against plain drag:
// an 85mm/s settle. The landing is line up over a head with W, then release
// and let it come down.
//
// What all of this replaced was a model where thrust ran along the view
// directly. It flew well enough in a straight line, but with no turn rate
// between the two, every glance was a course change: you could not look at
// something without flying at it.

import { FLOWER } from '../geom/flower.js';
import { HeadSites, crawlAxes } from './sites.js';

/**
 * Play volume: a meadow, not a flowerpot.
 *
 * `margin` is the soft cushion inside the wall. The ceiling clears the tallest
 * species (a cornflower runs to 330mm) with room to look down on it.
 *
 * `floorMargin` and `ceilingMargin` replace it above and below. The general
 * margin is sized for the outer walls, where there is nothing to see right at
 * the edge anyway. Applied to the floor it pushed back a third of a metre up,
 * well above every low, ground-hugging species (a clover leaf tops out under
 * 30mm) -- so the one thing "get close to a short plant" needs was exactly the
 * one thing the cushion was built to prevent. Applied to the CEILING it was
 * worse still: the volume is only 880mm tall, so a 350mm cushion braked the
 * bee through the top 40% of everything it could fly in.
 */
export const BOUNDS = {
  min: [-3.5, 0.020, -3.5],
  max: [3.5, 0.900, 3.5],
  margin: 0.35,
  floorMargin: 0.05,
  ceilingMargin: 0.12,
};

// --- looking ---------------------------------------------------------------
// Radians of view per unit of pointer travel. The mouse is captured and moves
// the view by its own DELTA -- there is no rate control on this axis and no
// centre to return to, which is what makes a mouse a mouse. A thumb gets rate
// control instead (see main.js); the two meet here.
const PITCH_LIMIT = 1.35;    // rad. Short of vertical: the flying camera's up
                             // is world up, and a look straight down it has no
                             // defined roll.

// --- the airframe ----------------------------------------------------------
// Speeds are set by how long it should take to cross the field rather than by
// anything about a real bee -- at 5 m/s the seven-metre field would be gone in
// a second and a half. Boosting flat out crosses it in about twenty seconds,
// which leaves time to pick a flower out and go to it.
const THRUST_ACC = 0.72;     // m/s^2 along the heading; W forward, S back
const DRAG = 1.15;           // 1/s. Thrust over drag is the cruising speed
// A hard cap, and one the cruise no longer sits right underneath: forward and
// climb are separate axes now, and a bee doing both at once was being quietly
// governed by a limit meant to catch a runaway dive.
const MAX_SPEED = 0.80;      // m/s
// How fast A and D swing the CAMERA -- they are the keyboard's half of the
// orbit, the same axis the mouse drags, and like the mouse they move the bee
// only by way of what W then does about it.
const KEY_ORBIT_RATE = 2.0;  // rad/s at full deflection
// The bee's own turn rate, at full throttle, easing onto whatever heading the
// camera is asking for. This is the turning radius: the arc a bee at speed v
// comes round on is v / HEADING_RATE, so a cruise at 0.6 m/s sweeps about
// 370mm and a crawl-speed approach turns almost on the spot. Bounded rather
// than eased, so the radius is a radius and not a curve that tightens as it
// converges.
const HEADING_RATE = 1.6;    // rad/s
// Gravity, and the speed at which the wing carries essentially all of it. Lift
// goes as the square of the airspeed, so a cruise on W is very nearly level
// and letting go starts falling again. GRAVITY over DRAG is the terminal sink
// with no speed over the wing: 85mm/s, which is also the landing descent.
const GRAVITY = 0.098;       // m/s^2
const TRIM_SPEED = 0.50;     // m/s
const LIFT_MAX = 0.94;       // fraction of gravity a wing at trim carries
// Straight up while space is held. Comfortably over gravity, so the climb is a
// climb rather than a reduced sink -- 220mm/s from a standstill.
const CLIMB_ACC = 0.35;      // m/s^2
// How fast the drawn body settles onto its lean. The BEARING is not eased at
// all -- it is the heading exactly, because thrust runs along the heading and
// a body that lagged it would be pointing somewhere the bee was not going,
// which is the one thing the third-person view is there to show.
const FACE_RATE = 5.0;       // 1/s
// How far off the horizontal the body leans, and how much climb rate it takes
// to get there. A bee climbs with its wings, not its nose: this is enough that
// a climb and a sink read differently at a glance and nothing like the angle
// the flight path is actually on.
const FACE_PITCH_LIMIT = 0.35;  // rad, about 20 degrees
const FACE_PITCH_GAIN = 0.9;    // rad per m/s of climb

// --- the camera orbit ------------------------------------------------------
// Where the orbit STARTS, and the only number in this file that touches it. A
// shade below the horizontal, because the rig it feeds is already looking down
// (see CHASE_FLY in main.js) and this is where a meadow reads best. Nothing
// eases it anywhere afterwards: once the scene is running the orbit belongs to
// the pointer and to A/D, and to nothing else at all.
const START_PITCH = -0.10;   // rad
// Fraction per second of the wall-ward velocity bled off at the very edge of
// the cushion. A bare clamp reads as hitting glass; ramping the brake over the
// last few centimetres lets the bee round out of a dive on its own.
const WALL_BRAKE = 1.0;

// --- crawl -----------------------------------------------------------------
// The shape of the landable surface, and how far out it captures, both live in
// sim/sites.js now: they are properties of a head, and heads come in six sizes.
// Reference values, for the offline checks and for framing.
export const CRAWL_AXES = crawlAxes(FLOWER.headRadius);
// Only the TOP of that ellipsoid is walkable -- a dome, not a whole shell.
// Carrying on around the rim took the bee through a band where the surface
// stands vertical and then onto the underside, which reads as the bee being
// glued to a cliff rather than standing on a flower. The walk stops short of
// it instead. Because the head is oblate the surface at this elevation is
// already leaning about 46 degrees from the head's axis, which is as far over
// as is worth walking.
const CRAWL_MIN_ELEVATION = 0.30;                       // rad above the rim
const CRAWL_MIN_Y = Math.sin(CRAWL_MIN_ELEVATION);
const CRAWL_RIM_XZ = Math.cos(CRAWL_MIN_ELEVATION);
const EYE_HEIGHT = 0.004;
const CRAWL_FWD = 0.020;       // m/s
const CRAWL_BACK = 0.012;
const CRAWL_TURN = 1.6;        // rad/s
const TAKEOFF_SPEED = 0.13;    // m/s along the surface normal
// Seconds after take-off before landing can retrigger. Longer than it was:
// the launch used to be a dedicated climb rate, so it always went straight up
// and out of the capture shell. Now the boost points wherever the camera does,
// and a launch off a 56mm ox-eye aimed near the horizontal is still inside
// that head's own shell when the old 0.7s ran out -- so the flower grabbed the
// bee straight back, which reads as not being able to leave at all.
const LAND_COOLDOWN = 1.2;

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function norm3(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Orthonormal basis of the flower head, from the frame the GPU published. */
function headBasis(frame) {
  const y = norm3(frame.up);
  let x = frame.side;
  // Re-orthogonalise: the readback is a snapshot of a simulated frame and is
  // only orthonormal to within its own solve.
  x = norm3([x[0] - y[0] * dot3(x, y), x[1] - y[1] * dot3(x, y), x[2] - y[2] * dot3(x, y)]);
  if (!Number.isFinite(x[0])) x = Math.abs(y[1]) < 0.9 ? norm3(cross3([0, 1, 0], y)) : [1, 0, 0];
  return { o: frame.pos, x, y: y, z: cross3(x, y) };
}
const toWorld = (b, l) => [
  b.o[0] + b.x[0] * l[0] + b.y[0] * l[1] + b.z[0] * l[2],
  b.o[1] + b.x[1] * l[0] + b.y[1] * l[1] + b.z[1] * l[2],
  b.o[2] + b.x[2] * l[0] + b.y[2] * l[1] + b.z[2] * l[2],
];
const rotToWorld = (b, l) => [
  b.x[0] * l[0] + b.y[0] * l[1] + b.z[0] * l[2],
  b.x[1] * l[0] + b.y[1] * l[1] + b.z[1] * l[2],
  b.x[2] * l[0] + b.y[2] * l[1] + b.z[2] * l[2],
];
function toLocal(b, w) {
  const d = [w[0] - b.o[0], w[1] - b.o[1], w[2] - b.o[2]];
  return [dot3(d, b.x), dot3(d, b.y), dot3(d, b.z)];
}

/**
 * Push a point back onto the dome if the walk stepped off its rim.
 *
 * Clamping the elevation and renormalising the horizontal part means walking
 * into the rim slides along it rather than stopping dead, so the edge reads as
 * a lip you can follow round rather than a wall you bump into -- and either
 * way there is no way over it.
 */
function clampToDome(n) {
  if (n[1] >= CRAWL_MIN_Y) return n;
  const horiz = Math.hypot(n[0], n[2]);
  // The floor is strictly positive, so the only direction with no horizontal
  // component at all is straight down. Put that back on top of the dome.
  if (horiz < 1e-9) return [0, 1, 0];
  const s = CRAWL_RIM_XZ / horiz;
  return [n[0] * s, CRAWL_MIN_Y, n[2] * s];
}

/** Tangent basis of the unit sphere at `n`. */
function tangentBasis(n) {
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = norm3(cross3(ref, n));
  return { e1, e2: cross3(n, e1) };
}

export class BeeFlight {
  /** @param {number[]} start  where the bee begins, in world metres */
  constructor(start = [0.14, 0.30, 0.20]) {
    this.start = start;
    // Reused by every per-frame site query, so flying allocates nothing.
    this.scratch = HeadSites.scratch();
    this.reset();
  }

  reset() {
    this.mode = 'fly';
    // Where the bee stands on the crawl ellipsoid, as a point on the unit
    // sphere in head-local space, plus a heading in that point's tangent
    // plane. Storing it in the head's own frame is what makes the bee ride the
    // flower as it sways -- there is nothing to keep in sync.
    this.surfaceDir = [0, 1, 0];
    this.surfaceHeading = 0;
    this.landCooldown = 0;
    /** Which head the bee is standing on, or -1 in the air. */
    this.plant = -1;
    this.position = [this.start[0], this.start[1], this.start[2]];
    // The CAMERA's orbit, in world space, in both modes. Written by look(),
    // which the pointer calls, and by A/D, which is the same axis from the
    // keyboard. Nothing else in this file touches it, and it never decides
    // where the bee goes.
    this.yaw = Math.atan2(-this.position[0], -this.position[2]);   // face the middle
    this.pitch = START_PITCH;
    // Where the BEE points, which is a separate thing entirely: A and D turn
    // this and nothing else does, and the thrust runs along it.
    this.heading = this.yaw;
    this.velocity = [0, 0, 0];
    // The drawn body: the heading, plus a lean off the horizontal that follows
    // the climb rate. See faceHeading.
    this.facePitch = 0;
    this.facing = [Math.sin(this.heading), 0, Math.cos(this.heading)];
    // Movement deflection in [-1,1], and ONLY movement, with the same meaning
    // in both modes: x turns, y is the throttle (up is negative, as a screen
    // axis is, so W is -1 and S is +1).
    this.steer = [0, 0];
    // Space, and the on-screen button. Lift while flying, the launch while
    // crawling; never anything to do with going forward.
    this.boost = 0;
  }

  /**
   * Swing the camera orbit. The only place a POINTER can write yaw and pitch,
   * so the mouse, a drag and anything else cannot end up disagreeing about the
   * limit or the sign -- and, because moving the bee never calls this, looking
   * around can never move the bee.
   */
  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dPitch));
    return this;
  }

  /**
   * The orbit direction: from the camera toward the bee. Where the eye ends up
   * is this plus the rig (see MacroCamera.setChase), so swinging it round the
   * yaw circle walks the camera round the bee. Not where the bee is going --
   * that is `heading`, and the two are unrelated by design.
   */
  forward() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

  /** Which way the bee is pointing, on the flat. Thrust runs along this. */
  headingVector() {
    return [Math.sin(this.heading), 0, Math.cos(this.heading)];
  }

  /** Speed through the air, which is now simply the speed. */
  get airspeed() { return Math.hypot(this.velocity[0], this.velocity[1], this.velocity[2]); }

  /**
   * Surface point, normal and heading in world space, given the head's frame.
   * Recomputed from the live frame every tick, so the flower carries the bee.
   */
  surfaceState(frame) {
    const b = headBasis(frame);
    const n = this.surfaceDir;
    const A = crawlAxes(frame.headRadius);
    const local = [n[0] * A[0], n[1] * A[1], n[2] * A[2]];
    // Ellipsoid normal is the gradient of x^2/a^2 + ... , not the radius.
    const nrmLocal = norm3([n[0] / A[0], n[1] / A[1], n[2] / A[2]]);
    const { e1, e2 } = tangentBasis(n);
    const h = this.surfaceHeading;
    const d = [
      e1[0] * Math.cos(h) + e2[0] * Math.sin(h),
      e1[1] * Math.cos(h) + e2[1] * Math.sin(h),
      e1[2] * Math.cos(h) + e2[2] * Math.sin(h),
    ];
    const dLocal = norm3([d[0] * A[0], d[1] * A[1], d[2] * A[2]]);
    return {
      point: toWorld(b, local),
      normal: norm3(rotToWorld(b, nrmLocal)),
      forward: norm3(rotToWorld(b, dLocal)),
      dir: d,
    };
  }

  /** Settle onto the surface at whatever point the approach reached. */
  land(frame) {
    const b = headBasis(frame);
    const A = crawlAxes(frame.headRadius);
    this.plant = frame.index;
    const l = toLocal(b, this.position);
    // An approach from the side or from underneath lands below the rim; seat
    // it on the dome rather than outside the surface the walk can reach.
    this.surfaceDir = clampToDome(norm3([l[0] / A[0], l[1] / A[1], l[2] / A[2]]));
    // Carry the approach direction into the walk so landing does not spin the
    // view; fall back to any tangent if the bee arrived nearly stationary.
    const { e1, e2 } = tangentBasis(this.surfaceDir);
    const vLocal = [dot3(this.velocity, b.x), dot3(this.velocity, b.y), dot3(this.velocity, b.z)];
    const t1 = dot3(vLocal, e1), t2 = dot3(vLocal, e2);
    this.surfaceHeading = Math.hypot(t1, t2) > 1e-5 ? Math.atan2(t2, t1) : 0;
    this.mode = 'crawl';
    this.velocity = [0, 0, 0];
  }

  /**
   * Point the drawn body along the heading, with a lean for the climb rate.
   *
   * The bearing is taken exactly, not eased: A and D already turn at a bounded
   * rate, so there is nothing to smooth, and the thrust runs along the heading
   * -- a body lagging behind it would be visibly pointing somewhere the bee is
   * not going. Only the lean is eased, and only because the climb rate itself
   * can step (a brake, a wall, a take-off).
   *
   * This replaced a version that swung the body onto the FLIGHT PATH. That was
   * right when the path was the only thing the player aimed; now the heading is
   * what they aim, and the path is what the wind and the wing make of it.
   */
  faceHeading(step) {
    const want = Math.max(-FACE_PITCH_LIMIT,
      Math.min(FACE_PITCH_LIMIT, this.velocity[1] * FACE_PITCH_GAIN));
    const k = 1 - Math.exp(-FACE_RATE * step);
    this.facePitch += (want - this.facePitch) * k;
    const f = this.headingVector();
    const c = Math.cos(this.facePitch);
    this.facing = [f[0] * c, Math.sin(this.facePitch), f[2] * c];
  }

  /** Boost while crawling launches straight off the surface. */
  takeOff(frame) {
    const st = this.surfaceState(frame);
    this.position = [
      st.point[0] + st.normal[0] * 0.012,
      st.point[1] + st.normal[1] * 0.012,
      st.point[2] + st.normal[2] * 0.012,
    ];
    // Straight up off the surface, and the flying heading picks up the walk's
    // bearing so the bee leaves pointing the way it was facing on the flower.
    // The camera is left exactly where the player had it -- take-off is the
    // bee's business, and snatching the view back would undo the look they
    // just chose. The first press of W will bring the bee round under it.
    this.velocity = st.normal.map((n) => n * TAKEOFF_SPEED);
    const flat = Math.hypot(st.forward[0], st.forward[2]);
    if (flat > 1e-5) this.heading = Math.atan2(st.forward[0] / flat, st.forward[2] / flat);
    this.facePitch = 0;
    this.facing = this.headingVector();
    this.mode = 'fly';
    this.plant = -1;
    this.landCooldown = LAND_COOLDOWN;
  }

  updateCrawl(step, frame) {
    // Same sign as the flying turn. `surfaceHeading` measures from e1 toward
    // e2, and (e1, e2, normal) is right-handed, so INCREASING it swings the
    // view toward -right -- the opposite of what the identical stick does in
    // the air. It read as the controls inverting the moment the bee landed.
    this.surfaceHeading -= this.steer[0] * CRAWL_TURN * step;
    const throttle = -this.steer[1];
    const speed = throttle >= 0 ? throttle * CRAWL_FWD : throttle * CRAWL_BACK;

    if (Math.abs(speed) > 1e-6) {
      const A = crawlAxes(frame.headRadius);
      const n = this.surfaceDir;
      const { e1, e2 } = tangentBasis(n);
      const h = this.surfaceHeading;
      const d = [
        e1[0] * Math.cos(h) + e2[0] * Math.sin(h),
        e1[1] * Math.cos(h) + e2[1] * Math.sin(h),
        e1[2] * Math.cos(h) + e2[2] * Math.sin(h),
      ];
      // Convert the world-space speed into an angle on the unit sphere. The
      // ellipsoid stretches differently along each axis, so the same angle
      // covers different ground near the rim than near the pole; dividing by
      // the local stretch keeps the walk at a constant speed either way.
      const stretch = Math.hypot(d[0] * A[0], d[1] * A[1], d[2] * A[2]);
      const theta = (speed * step) / Math.max(1e-6, stretch);
      const c = Math.cos(theta), sn = Math.sin(theta);
      const next = norm3([
        n[0] * c + d[0] * sn, n[1] * c + d[1] * sn, n[2] * c + d[2] * sn,
      ]);
      // Parallel transport the heading so walking over the pole does not spin.
      const dNext = norm3([
        -n[0] * sn + d[0] * c, -n[1] * sn + d[1] * c, -n[2] * sn + d[2] * c,
      ]);
      // Collide with the rim instead of walking over it.
      const landed = clampToDome(next);
      this.surfaceDir = landed;
      const nb = tangentBasis(landed);
      // Re-project the transported heading into the tangent plane of wherever
      // the step actually ended up. Into the rim that keeps whatever component
      // still runs along it, which is what turns the stop into a slide.
      const t1 = dot3(dNext, nb.e1), t2 = dot3(dNext, nb.e2);
      if (Math.hypot(t1, t2) > 1e-6) this.surfaceHeading = Math.atan2(t2, t1);
    }

    const st = this.surfaceState(frame);
    this.position = [
      st.point[0] + st.normal[0] * EYE_HEIGHT,
      st.point[1] + st.normal[1] * EYE_HEIGHT,
      st.point[2] + st.normal[2] * EYE_HEIGHT,
    ];
    return this;
  }

  /**
   * The frame of the head the bee is standing on, or null.
   *
   * Held by INDEX rather than by value, so the flower carries the bee: the
   * table is rewritten every frame from the solver, and looking it up again
   * each tick is what makes a swaying head take its passenger with it.
   */
  currentFrame(sites) {
    if (!sites || this.plant < 0 || this.plant >= sites.count) return null;
    return sites.frame(this.plant, this.scratch);
  }

  /** @param {import('./sites.js').HeadSites|null} sites */
  update(dt, sites = null) {
    const step = Math.min(0.05, Math.max(1 / 240, dt));
    this.landCooldown = Math.max(0, this.landCooldown - step);

    if (this.mode === 'crawl') {
      const frame = this.currentFrame(sites);
      if (!frame) return this;                  // no table yet: hold position
      if (this.boost > 0) { this.takeOff(frame); return this; }
      return this.updateCrawl(step, frame);
    }

    // A and D are the keyboard's orbit: they swing the camera, exactly as a
    // mouse drag would, and by themselves that is all they do.
    this.yaw -= this.steer[0] * KEY_ORBIT_RATE * step;

    // Screen axis, so W is -1 and S is +1. One signed axis, and it means the
    // same thing at both ends: a bee reverses perfectly well.
    const throttle = -this.steer[1];

    // The throttle is what turns the bee, and the camera is what it turns
    // TOWARD. Gating the turn on the throttle is what keeps the camera out of
    // the flight model: orbit all the way round with nothing held and the bee
    // does not budge. It also happens to be how a wing works -- you turn by
    // flying. Magnitude, not sign: reversing swings the nose onto the aim in
    // exactly the same way, and the bee backs off along it.
    const turning = Math.abs(throttle);
    if (turning > 0) {
      const d = Math.atan2(Math.sin(this.yaw - this.heading),
                           Math.cos(this.yaw - this.heading));
      const most = HEADING_RATE * turning * step;
      this.heading += Math.max(-most, Math.min(most, d));
    }
    const f = this.headingVector();
    const v = this.velocity;

    // Lift goes as the square of the airspeed, so the wing carries nearly all
    // of its own weight at a cruise and almost none of it at a standstill.
    // That, and not a steering term, is what makes this fly like a glider:
    // speed keeps you up, and W is the only thing that makes speed.
    const speed = Math.hypot(v[0], v[1], v[2]);
    const carried = Math.min(1, (speed / TRIM_SPEED) ** 2) * LIFT_MAX;
    // Signed: S is W with the sign flipped and nothing else about it changed.
    // Horizontal, because `f` is -- forward and up are separate controls, and
    // neither W nor S touches the height.
    const thrust = throttle * THRUST_ACC;
    v[0] += (f[0] * thrust - DRAG * v[0]) * step;
    v[2] += (f[2] * thrust - DRAG * v[2]) * step;
    v[1] += (this.boost * CLIMB_ACC - GRAVITY * (1 - carried) - DRAG * v[1]) * step;

    // A hard cap, not a soft one: whatever a dive builds up, the frame never
    // has to cope with more than this.
    const after = Math.hypot(v[0], v[1], v[2]);
    if (after > MAX_SPEED) {
      const k = MAX_SPEED / after;
      for (let a = 0; a < 3; a++) v[a] *= k;
    }

    this.applyBounds(step);
    for (let a = 0; a < 3; a++) this.position[a] += v[a] * step;
    this.clampToVolume();
    this.faceHeading(step);

    // Touchdown, on whichever head's capture shell the bee is inside. The test
    // lives in sites.js because it is a property of a head, and the heads are
    // now six sizes: it is done in ellipsoid-normalised space, where every
    // one of them is exactly the unit sphere.
    if (sites && this.landCooldown <= 0) {
      const hit = sites.landable(this.position, this.scratch);
      if (hit >= 0) this.land(sites.frame(hit, this.scratch));
    }
    return this;
  }

  /**
   * Soft cushion, applied to this frame's velocity.
   *
   * It is a brake rather than a push-back: inside the margin, whatever part of
   * the velocity is heading into the wall is scaled down, to nothing at the
   * wall itself. A push-back would be the more obvious model and is the wrong
   * one here, because the velocity is rebuilt from the flight path every tick
   * -- an impulse added to it would be thrown away before it could accumulate.
   * Braking is also the better feel: the bee rounds out of a dive at the edge
   * of the meadow rather than bouncing off it.
   */
  applyBounds(dt) {
    const { min, max, margin, floorMargin, ceilingMargin } = BOUNDS;
    const v = this.velocity;
    for (let a = 0; a < 3; a++) {
      const p = this.position[a];
      // Floor and ceiling get their own, much closer cushions (see BOUNDS
      // above); the four side walls keep the general one.
      const lowMargin = a === 1 ? floorMargin : margin;
      const highMargin = a === 1 ? ceilingMargin : margin;
      const under = min[a] + lowMargin - p;
      const over = p - (max[a] - highMargin);
      if (under > 0 && v[a] < 0) {
        v[a] *= Math.max(0, 1 - WALL_BRAKE * Math.min(1, under / lowMargin));
      }
      if (over > 0 && v[a] > 0) {
        v[a] *= Math.max(0, 1 - WALL_BRAKE * Math.min(1, over / highMargin));
      }
    }
  }

  /** Hard stop, after the step. The cushion should mean this never fires. */
  clampToVolume() {
    const { min, max } = BOUNDS;
    for (let a = 0; a < 3; a++) {
      if (this.position[a] < min[a]) {
        this.position[a] = min[a];
        this.velocity[a] = Math.max(0, this.velocity[a]);
      } else if (this.position[a] > max[a]) {
        this.position[a] = max[a];
        this.velocity[a] = Math.min(0, this.velocity[a]);
      }
    }
  }

  /** Camera up: the surface normal while crawling, world up while flying. */
  upVector(sites) {
    const frame = this.mode === 'crawl' ? this.currentFrame(sites) : null;
    if (frame) return this.surfaceState(frame).normal;
    return [0, 1, 0];
  }

  /**
   * Where the CAMERA looks. The pointer's aim, in both modes.
   *
   * It used to be the walk heading while crawling, which meant turning on the
   * spot swung the view and there was no way to look at the flower you were
   * standing on from anywhere but behind your own head. The walk heading is
   * still available -- as bodyForward, which is what it always was.
   */
  viewForward() {
    return this.forward();
  }

  /**
   * Where the BEE points: the walk heading while crawling, the steered heading
   * while flying. Only the model is drawn along this; the camera never is.
   */
  bodyForward(sites) {
    const frame = this.mode === 'crawl' ? this.currentFrame(sites) : null;
    if (frame) return this.surfaceState(frame).forward;
    return this.facing;
  }

  get speed() { return Math.hypot(...this.velocity); }
}
