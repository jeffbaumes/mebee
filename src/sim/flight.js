// Bee flight.
//
// The pointer is the only thing that aims: it orbits the camera around the
// bee, and the bee is instantly pointed dead away from the camera, on all
// three axes -- look up and the nose comes up with it, look down and it
// dives. There is no turn rate and no radius to ease onto; the body simply
// matches wherever the camera is looking, every frame.
//
// A and D do nothing here. They used to swing the same orbit from the
// keyboard, but with the bee always facing exactly where the camera points,
// a keyboard swing of the orbit would swing the bee's nose right along with
// it -- indistinguishable from turning on the spot. The mouse is the one and
// only aim.
//
// W and S are thrust along that facing, forward and back, and that is the
// whole flight model: no separate turning axis, because pointing IS the
// facing. W ramps up over a beat rather than snapping to full thrust, so
// going feels like a wind-up; letting go (or S to brake) sheds it fast, so
// stopping reads as immediate. Space lifts straight up, with no facing
// component in it at all, and is also the launch off a flower.
//
// There is no gravity. Nothing held is simply no thrust: drag alone brings
// the bee to a stop wherever it is, in the air or not -- it does not sink.
// That is the one deliberate departure from a real elytra, which this used
// to model with lift-over-speed and a terminal sink rate; it read as the bee
// fighting to stay up, which is not the feel this wants.

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
const THRUST_ACC = 0.72;     // m/s^2 along the facing; W forward, S back
const DRAG = 1.15;           // 1/s. Thrust over drag is the cruising speed
// A hard cap, and one the cruise no longer sits right underneath: forward and
// climb are separate axes now, and a bee doing both at once was being quietly
// governed by a limit meant to catch a runaway dive.
const MAX_SPEED = 0.80;      // m/s
// W/S do not apply THRUST_ACC directly -- they ease a throttle value toward
// -1/0/+1 first, and the two directions ease at different rates. Winding up
// is slow, so a press of W reads as a beat of effort before it takes hold;
// letting go (or braking with S) is fast, so stopping reads as immediate
// rather than a coast. Both are exponential rates, not linear ramps.
const THROTTLE_RISE = 1.4;   // 1/s, easing toward more throttle
const THROTTLE_FALL = 7.0;   // 1/s, easing toward less
// Straight up while space is held, independent of the facing entirely -- the
// one axis that is not "go the way you're looking". Also the launch off a
// flower.
const CLIMB_ACC = 0.35;      // m/s^2

// --- the camera orbit ------------------------------------------------------
// Where the orbit STARTS, and the only number in this file that touches it. A
// shade below the horizontal, because the rig it feeds is already looking down
// (see CHASE_FLY in main.js) and this is where a meadow reads best. Nothing
// eases it anywhere afterwards: once the scene is running the orbit belongs to
// the pointer alone, and to nothing else at all.
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
    // The CAMERA's orbit, in world space, in both modes -- and, while flying,
    // the bee's own facing too: it always points straight away from the
    // camera. Written by look(), which the pointer calls; while crawling, A/D
    // turn the walk instead (see updateCrawl) and never touch this.
    this.yaw = Math.atan2(-this.position[0], -this.position[2]);   // face the middle
    this.pitch = START_PITCH;
    this.velocity = [0, 0, 0];
    // Smoothed throttle from W/S, eased toward -1/0/+1 at different rates
    // going up than coming down. See THROTTLE_RISE/THROTTLE_FALL.
    this.throttle = 0;
    // The drawn body. While flying this is just forward() -- see update();
    // while crawling it comes from the walk (see bodyForward).
    this.facing = this.forward();
    // Movement deflection in [-1,1]. While flying only y (the throttle) does
    // anything; x is read while crawling, to turn the walk. Up is negative,
    // as a screen axis is, so W is -1 and S is +1.
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
   * yaw circle walks the camera round the bee. While flying, this is also
   * where the bee points and where thrust runs -- see update().
   */
  forward() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
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

  /** Boost while crawling launches straight off the surface. */
  takeOff(frame) {
    const st = this.surfaceState(frame);
    this.position = [
      st.point[0] + st.normal[0] * 0.012,
      st.point[1] + st.normal[1] * 0.012,
      st.point[2] + st.normal[2] * 0.012,
    ];
    // Straight up off the surface. The camera, and so the facing, is left
    // exactly where the player had it -- take-off is the bee's business, and
    // snatching the view back would undo the look they just chose.
    this.velocity = st.normal.map((n) => n * TAKEOFF_SPEED);
    this.throttle = 0;
    this.facing = this.forward();
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

    // A/D do nothing while flying -- the mouse is the only aim, and the bee
    // is pointed dead away from the camera, below, on all three axes.
    const f = this.forward();
    this.facing = f;
    const v = this.velocity;

    // Screen axis, so W is -1 and S is +1. One signed axis, and it means the
    // same thing at both ends: a bee reverses perfectly well.
    const targetThrottle = -this.steer[1];
    // Eases toward the target rather than snapping to it, and at a different
    // rate going up than coming down: winding up to speed is a slow beat,
    // letting go (or braking) sheds it fast. See THROTTLE_RISE/FALL.
    const rate = Math.abs(targetThrottle) > Math.abs(this.throttle) ? THROTTLE_RISE : THROTTLE_FALL;
    this.throttle += (targetThrottle - this.throttle) * (1 - Math.exp(-rate * step));

    // Thrust runs along the full 3D facing now, not just the flat -- looking
    // up and pressing W climbs, looking down dives. Space adds a pure vertical
    // component on top of that, independent of where the camera is pointed.
    const thrust = this.throttle * THRUST_ACC;
    for (let a = 0; a < 3; a++) {
      const extra = a === 1 ? this.boost * CLIMB_ACC : 0;
      v[a] += (f[a] * thrust + extra - DRAG * v[a]) * step;
    }

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
   * Where the BEE points: the walk heading while crawling, the camera's own
   * facing while flying (see `facing`, set in update()). Only the model is
   * drawn along this; the camera never is.
   */
  bodyForward(sites) {
    const frame = this.mode === 'crawl' ? this.currentFrame(sites) : null;
    if (frame) return this.surfaceState(frame).forward;
    return this.facing;
  }

  get speed() { return Math.hypot(...this.velocity); }
}
