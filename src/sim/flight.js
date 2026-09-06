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

const CRUISE = 0.060;       // m/s of forward drift, on the horizontal only
const CLIMB = 0.160;        // m/s added while boosting
const SINK = 0.045;         // m/s of gentle settle with no input
const VERT_LAG = 2.6;       // 1/s. Lower = more floaty; this is ~0.4s to settle
const HORIZ_LAG = 3.6;      // 1/s
const TURN_RATE = 1.2;      // rad/s at full stick; a full circle in ~5s
const PITCH_RATE = 0.85;    // rad/s at full stick -- view only, see update()
// Wider than before: now that pitch is view-only it cannot get you into
// trouble, so there is no reason not to let you look up at the flower.
const PITCH_LIMIT = 0.95;   // rad, about 54 degrees
const PITCH_CENTRE = 0.7;   // 1/s that the view drifts back to level
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
    this.pitch = -0.05;
    this.velocity = [0, 0, 0];
    // Stick deflection in [-1,1], set by the drag; zero when released.
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
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
      this.pitch - this.steer[1] * PITCH_RATE * step));
    // Self-centring pitch. Without it a fractional stick offset leaves a
    // permanent climb or dive that the player has to notice and correct, which
    // is most of what makes a free-flight camera feel unmanageable.
    if (Math.abs(this.steer[1]) < 0.08) {
      this.pitch = approach(this.pitch, 0, PITCH_CENTRE, step);
    }

    const v = this.velocity;

    // Heading drives travel; pitch does not. Looking up or down aims the
    // camera and nothing else, so the two axes of the stick never fight: one
    // turns you, the other only changes what you can see. Flying where you are
    // looking sounds natural and is in practice the thing that makes a free
    // camera hard to hold level.
    const hx = Math.sin(this.yaw), hz = Math.cos(this.yaw);
    // Enough lag that a hard turn carries the bee wide rather than pivoting it
    // on the spot.
    v[0] = approach(v[0], hx * CRUISE, HORIZ_LAG, step);
    v[2] = approach(v[2], hz * CRUISE, HORIZ_LAG, step);

    // Altitude comes from the boost and gravity, nothing else. It is
    // deliberately the laggiest axis: press and the climb builds over about
    // half a second, release and it bleeds away over the same. That delay is
    // the whole feel of a bee-suit hover.
    const targetVy = this.boost * CLIMB - SINK;
    v[1] = approach(v[1], targetVy, VERT_LAG, step);

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
