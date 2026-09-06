// First-person bee flight.
//
// Two inputs, as designed: drag steers, one button gives lift. Everything else
// -- forward drift, sink, the way altitude lags behind the thumb -- comes from
// the model, so the player is never asked to hold a heading or manage speed.

/** Play volume. The bee cannot leave it; `margin` is the soft cushion inside. */
export const BOUNDS = {
  min: [-0.45, 0.030, -0.45],
  max: [0.45, 0.850, 0.45],
  margin: 0.09,
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
const WALL_PUSH = 2.6;      // m/s^2 at the very edge of the cushion

/** Exponential approach that is correct for any timestep. */
const approach = (current, target, rate, dt) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export class BeeFlight {
  constructor() {
    this.reset();
  }

  reset() {
    this.position = [0.26, 0.44, 0.30];
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

  update(dt) {
    const step = Math.min(0.05, Math.max(1 / 240, dt));

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

    const tilt = Math.max(-VIEW_TILT_LIMIT,
      Math.min(VIEW_TILT_LIMIT, v[1] * VIEW_TILT));
    this.pitch = approach(this.pitch, tilt, VIEW_TILT_LAG, step);

    for (let a = 0; a < 3; a++) this.position[a] += v[a] * step;
    this.applyBounds(step);
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

  get speed() { return Math.hypot(...this.velocity); }
}
