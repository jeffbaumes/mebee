// First-person bee flight.
//
// Two inputs, as designed: drag steers, one button gives lift. Everything else
// -- forward drift, sink, the way altitude lags behind the thumb -- comes from
// the model, so the player is never asked to hold a heading or manage speed.

/** Play volume. The bee cannot leave it; `margin` is the soft cushion inside. */
export const BOUNDS = {
  min: [-0.40, 0.020, -0.40],
  max: [0.40, 0.400, 0.40],
  margin: 0.07,
};

const CRUISE_FWD = 0.075;   // m/s at full forward stick
const CRUISE_BACK = 0.040;  // m/s at full back stick; backing off is slower
const CLIMB = 0.160;        // m/s added while boosting
const SINK = 0.045;         // m/s of gentle settle with no boost
const VERT_LAG = 2.6;       // 1/s. Lower = more floaty; this is ~0.4s to settle
const HORIZ_LAG = 3.6;      // 1/s
const TURN_RATE = 1.2;      // rad/s at full stick; a full circle in ~5s
// The view tilt is feedback, not a control: the camera noses up as the bee
// climbs and down as it settles, which is how you read your own vertical
// motion without an instrument.
const VIEW_TILT = 1.1;      // rad per m/s of vertical velocity
const VIEW_TILT_LIMIT = 0.22;
const VIEW_TILT_LAG = 3.0;  // 1/s
// The higher you get, the more you look down. Level flight at altitude points
// the camera at empty sky, which is both useless and gives no read on where
// you are; tipping the view toward the ground keeps the world in frame.
const ALT_LOOK_DOWN = 0.55; // rad at the ceiling
const WALL_PUSH = 2.6;      // m/s^2 at the very edge of the cushion

// --- crawl -----------------------------------------------------------------
// The landable surface is an oblate ellipsoid standing in for the flower head.
// Approximating rather than colliding against the real petals means the walk
// never catches on a notch or falls between two florets, and the bee can round
// the rim onto the underside without any special case.
export const CRAWL_AXES = [0.040, 0.013, 0.040];
// Capture shell, as a uniform margin in metres around the ellipsoid rather
// than a scale factor. A normalised threshold looks even but is not: at 1.3 it
// reaches 12mm out at the rim and only 4mm above the disc, because the head is
// thin. A constant margin gives the same forgiving approach from every angle.
const LAND_MARGIN = 0.013;
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
  constructor() {
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
    this.position = [0.115, 0.205, 0.130];
    // Face the flower head at the origin.
    this.yaw = Math.atan2(-this.position[0], -this.position[2]);
    this.pitch = 0;                 // derived from climb rate, not steered
    this.velocity = [0, 0, 0];
    // Stick deflection in [-1,1]: x turns, y is throttle (up = forward).
    this.steer = [0, 0];
    this.boost = 0;
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
    const A = CRAWL_AXES;
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
    const A = CRAWL_AXES;
    const l = toLocal(b, this.position);
    this.surfaceDir = norm3([l[0] / A[0], l[1] / A[1], l[2] / A[2]]);
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
    this.landCooldown = LAND_COOLDOWN;
  }

  updateCrawl(step, frame) {
    this.surfaceHeading += this.steer[0] * CRAWL_TURN * step;
    const throttle = -this.steer[1];
    const speed = throttle >= 0 ? throttle * CRAWL_FWD : throttle * CRAWL_BACK;

    if (Math.abs(speed) > 1e-6) {
      const A = CRAWL_AXES;
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
      this.surfaceDir = next;
      const nb = tangentBasis(next);
      this.surfaceHeading = Math.atan2(dot3(dNext, nb.e2), dot3(dNext, nb.e1));
    }

    const st = this.surfaceState(frame);
    this.position = [
      st.point[0] + st.normal[0] * EYE_HEIGHT,
      st.point[1] + st.normal[1] * EYE_HEIGHT,
      st.point[2] + st.normal[2] * EYE_HEIGHT,
    ];
    return this;
  }

  update(dt, frame = null) {
    const step = Math.min(0.05, Math.max(1 / 240, dt));
    this.landCooldown = Math.max(0, this.landCooldown - step);

    if (this.mode === 'crawl') {
      if (!frame) return this;                  // no frame yet: hold position
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

    const climbTilt = Math.max(-VIEW_TILT_LIMIT,
      Math.min(VIEW_TILT_LIMIT, v[1] * VIEW_TILT));
    const altFrac = Math.max(0, Math.min(1,
      (this.position[1] - BOUNDS.min[1]) / (BOUNDS.max[1] - BOUNDS.min[1])));
    this.pitch = approach(this.pitch, climbTilt - altFrac * ALT_LOOK_DOWN,
      VIEW_TILT_LAG, step);

    for (let a = 0; a < 3; a++) this.position[a] += v[a] * step;
    this.applyBounds(step);

    // Touchdown. Tested in ellipsoid-normalised space, where the surface is
    // exactly the unit sphere whatever the head's orientation.
    if (frame && this.landCooldown <= 0) {
      const b = headBasis(frame);
      const l = toLocal(b, this.position);
      const r = Math.hypot(
        l[0] / (CRAWL_AXES[0] + LAND_MARGIN),
        l[1] / (CRAWL_AXES[1] + LAND_MARGIN),
        l[2] / (CRAWL_AXES[2] + LAND_MARGIN),
      );
      if (r < 1.0) this.land(frame);
    }
    return this;
  }

  /**
   * Soft cushion first, hard stop second. A bare clamp reads as hitting glass;
   * ramping a push-back over the last few centimetres lets the bee round out
   * of a dive on its own.
   */
  applyBounds(dt) {
    const { min, max, margin } = BOUNDS;
    for (let a = 0; a < 3; a++) {
      const p = this.position[a];
      const under = min[a] + margin - p;
      const over = p - (max[a] - margin);
      if (under > 0) this.velocity[a] += WALL_PUSH * (under / margin) * dt;
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
  upVector(frame) {
    if (this.mode === 'crawl' && frame) return this.surfaceState(frame).normal;
    return [0, 1, 0];
  }

  /** Camera forward: the walk heading while crawling, the look while flying. */
  viewForward(frame) {
    if (this.mode === 'crawl' && frame) return this.surfaceState(frame).forward;
    return this.forward();
  }

  get speed() { return Math.hypot(...this.velocity); }
}
