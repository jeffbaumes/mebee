// First-person bee flight.
//
// Two inputs, as designed: drag steers, one button gives lift. Everything else
// -- forward drift, sink, the way altitude lags behind the thumb -- comes from
// the model, so the player is never asked to hold a heading or manage speed.

import { FLOWER } from '../geom/flower.js';
import { HeadSites, crawlAxes } from './sites.js';

/**
 * Play volume: a meadow, not a flowerpot.
 *
 * `margin` is the soft cushion inside the wall. The ceiling clears the tallest
 * species (a cornflower runs to 330mm) with room to look down on it.
 *
 * `floorMargin` replaces it for the ground alone. The general margin is sized
 * for the outer walls, where there is nothing to see right at the edge
 * anyway; applied to the floor too it started pushing back a third of a
 * metre up, well above every low, ground-hugging species (a clover leaf tops
 * out under 65mm) -- so the one thing "get close to a short plant" needs was
 * exactly the one thing the cushion was built to prevent.
 */
export const BOUNDS = {
  min: [-3.5, 0.020, -3.5],
  max: [3.5, 0.900, 3.5],
  margin: 0.35,
  floorMargin: 0.05,
};

// Speeds are set by how long it should take to cross the field, not by
// anything about a real bee -- at 5 m/s the seven-metre field would be gone in
// a second and a half. These cross it in about half a minute at full stick,
// which leaves time to pick a flower out and go to it.
const CRUISE_FWD = 0.26;    // m/s at full forward stick
const CRUISE_BACK = 0.13;   // m/s at full back stick; backing off is slower
const CLIMB = 0.34;         // m/s added while boosting
const SINK = 0.11;          // m/s of gentle settle with no boost
const VERT_LAG = 2.6;       // 1/s. Lower = more floaty; this is ~0.4s to settle
const HORIZ_LAG = 3.6;      // 1/s
const TURN_RATE = 1.2;      // rad/s at full stick; a full circle in ~5s
// The view tilt is feedback, not a control: the camera noses up as the bee
// climbs and down as it settles, which is how you read your own vertical
// motion without an instrument.
const VIEW_TILT = 1.1;      // rad per m/s of vertical velocity
const VIEW_TILT_LIMIT = 0.22;
const VIEW_TILT_LAG = 3.0;  // 1/s
// The view's altitude angle gravitates toward the nearest flower head, so the
// subject stays in frame without ever being steered at. This replaces a plain
// "look further down the higher you are", which aimed at the ground rather
// than at the one thing in the scene worth looking at -- and which pointed
// nowhere useful when the bee was low but far out.
const AIM_PITCH_LIMIT = 1.05;  // rad. Short of vertical on purpose: the flying
                               // camera's up is world up, and a look straight
                               // down the up-vector has no defined roll.
// Below this altitude, the nearest-by-distance flower can still be one
// standing well above the bee -- there is always something close and low to
// look at near the ground (grass, clover, the turf itself) even where
// nothing tall happens to be nearby. Fading the upward half of the aim out
// as the bee settles is what makes low flight read as skimming the sward
// instead of craning up at whatever flower is nearest in three dimensions.
// The downward half is never touched -- looking down at something close and
// low is exactly what flying near the ground should do more of.
const GROUND_AIM_FADE = 0.25;  // m: full upward aim restored above this
// How far the player can nudge the view up or down on top of the auto aim
// (see `look` on BeeFlight), within the same AIM_PITCH_LIMIT ceiling.
const LOOK_PITCH_RANGE = 0.85;  // rad
const WALL_PUSH = 5.0;      // m/s^2 at the very edge of the cushion

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
const LAND_COOLDOWN = 0.7;     // s after take-off before landing can retrigger

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

/** Exponential approach that is correct for any timestep. */
const approach = (current, target, rate, dt) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

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
    // Face the middle of the field.
    this.yaw = Math.atan2(-this.position[0], -this.position[2]);
    this.pitch = 0;                 // derived from climb rate, not steered
    this.velocity = [0, 0, 0];
    // Stick deflection in [-1,1]: x turns, y is throttle (up = forward).
    this.steer = [0, 0];
    this.boost = 0;
    // Second-finger look deflection in [-1,1], up positive. Rate control like
    // `steer`, not delta: held off-centre it keeps nudging the view rather
    // than needing continuous thumb travel. It rides on TOP of the auto aim
    // rather than replacing it -- see LOOK_PITCH_RANGE -- so letting go
    // settles back onto whatever the auto aim was already doing.
    this.lookRate = 0;
  }

  /** Where the camera looks: heading plus pitch. Travel ignores the pitch. */
  forward() {
    const cp = Math.cos(this.pitch);
    return [Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp];
  }

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
    this.velocity = st.normal.map((v) => v * TAKEOFF_SPEED);
    // Face where the walk was heading, so the view does not snap on take-off.
    this.yaw = Math.atan2(st.forward[0], st.forward[2]);
    this.pitch = 0;
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

    this.yaw -= this.steer[0] * TURN_RATE * step;

    const v = this.velocity;

    // The stick is turn and throttle. There is no default drift, so releasing
    // it leaves the bee hovering rather than committing it to a heading it has
    // to be steered out of -- which is the whole reason a constant cruise is
    // hard to fly at this scale.
    const throttle = -this.steer[1];               // stick up is forward
    const speed = throttle >= 0 ? throttle * CRUISE_FWD : throttle * CRUISE_BACK;
    const hx = Math.sin(this.yaw), hz = Math.cos(this.yaw);
    // Enough lag that a hard turn carries the bee wide rather than pivoting it
    // on the spot.
    v[0] = approach(v[0], hx * speed, HORIZ_LAG, step);
    v[2] = approach(v[2], hz * speed, HORIZ_LAG, step);

    // Altitude comes from the boost and gravity, nothing else. It is
    // deliberately the laggiest axis: press and the climb builds over about
    // half a second, release and it bleeds away over the same. That delay is
    // the whole feel of a bee-suit hover.
    const targetVy = this.boost * CLIMB - SINK;
    v[1] = approach(v[1], targetVy, VERT_LAG, step);

    for (let a = 0; a < 3; a++) this.position[a] += v[a] * step;
    this.applyBounds(step);

    // Aim after moving, so the angle is the one this frame is rendered from.
    // The climb tilt rides on top as feedback: the camera still noses up as
    // the bee climbs and down as it settles, which is how you read your own
    // vertical motion without an instrument. The player's own look, if any,
    // rides on top of that -- a nudge on the auto aim, not a replacement --
    // so releasing the second finger settles back onto the subject.
    const climbTilt = Math.max(-VIEW_TILT_LIMIT,
      Math.min(VIEW_TILT_LIMIT, v[1] * VIEW_TILT));
    const target = Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT,
      this.aimPitch(sites) + climbTilt + this.lookRate * LOOK_PITCH_RANGE));
    this.pitch = approach(this.pitch, target, VIEW_TILT_LAG, step);

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
   * Elevation angle from the eye to the nearest flower head.
   *
   * The table the GPU publishes is the honest source for where the heads
   * actually are -- they sway, and the sway is solved there. The reference
   * plant's height is the fallback for the first frames, before any readback
   * has landed. This was written against a list when there was one flower in
   * it, on the grounds that "nearest" is a list operation whatever the length;
   * scaling it to several hundred was a one-line change, which is the whole
   * argument for having done it that way.
   */
  aimPitch(sites) {
    let best = [0, FLOWER.stemHeight, 0];
    if (sites && sites.count > 0) {
      const i = sites.nearest(this.position);
      if (i >= 0) best = sites.frame(i, this.scratch).pos;
    }
    const flat = Math.hypot(best[0] - this.position[0], best[2] - this.position[2]);
    // atan2 rather than atan: hovering directly over the head takes `flat` to
    // zero, and the aim there wants to be straight down, not undefined. The
    // clamp belongs here rather than at the call site -- straight down IS what
    // this returns from overhead, and an unusable view angle should never
    // leave the method that knows why it is capped.
    const a = Math.atan2(best[1] - this.position[1], flat);
    // See GROUND_AIM_FADE: only the upward half is damped, and only by how
    // close to the ground the bee itself is -- not by anything about the
    // target -- so a flower that is merely far away is unaffected.
    const groundFade = Math.max(0, Math.min(1, this.position[1] / GROUND_AIM_FADE));
    const damped = a > 0 ? a * groundFade : a;
    return Math.max(-AIM_PITCH_LIMIT, Math.min(AIM_PITCH_LIMIT, damped));
  }

  /**
   * Soft cushion first, hard stop second. A bare clamp reads as hitting glass;
   * ramping a push-back over the last few centimetres lets the bee round out
   * of a dive on its own.
   */
  applyBounds(dt) {
    const { min, max, margin, floorMargin } = BOUNDS;
    for (let a = 0; a < 3; a++) {
      const p = this.position[a];
      // The floor gets its own, much closer cushion (see BOUNDS above); every
      // other wall keeps the general one.
      const lowMargin = a === 1 ? floorMargin : margin;
      const under = min[a] + lowMargin - p;
      const over = p - (max[a] - margin);
      if (under > 0) this.velocity[a] += WALL_PUSH * (under / lowMargin) * dt;
      if (over > 0) this.velocity[a] -= WALL_PUSH * (over / margin) * dt;

      if (p < min[a]) {
        this.position[a] = min[a];
        this.velocity[a] = Math.max(0, this.velocity[a]);
      } else if (p > max[a]) {
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

  /** Camera forward: the walk heading while crawling, the look while flying. */
  viewForward(sites) {
    const frame = this.mode === 'crawl' ? this.currentFrame(sites) : null;
    if (frame) return this.surfaceState(frame).forward;
    return this.forward();
  }

  /** Where the lens should focus: the head underfoot, or the nearest one. */
  focusTarget(sites) {
    if (this.mode === 'crawl') {
      const fwd = this.viewForward(sites);
      return [this.position[0] + fwd[0] * 0.035,
              this.position[1] + fwd[1] * 0.035,
              this.position[2] + fwd[2] * 0.035];
    }
    if (sites && sites.count > 0) {
      const i = sites.nearest(this.position);
      if (i >= 0) return sites.frame(i, this.scratch).pos.slice(0, 3);
    }
    return [0, FLOWER.stemHeight, 0];
  }

  get speed() { return Math.hypot(...this.velocity); }
}
