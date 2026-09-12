// Physical macro-lens camera.
//
// Framing and defocus are driven by the same lens, so changing the aperture
// changes only the blur and changing the focal length changes only the field
// of view -- the way a real camera behaves. Both feed the shader as physical
// quantities rather than as tuned blur radii.

import { mat4, lookAt, perspective, invert, multiply, normalize } from './math.js';
import { FLOWER } from '../geom/flower.js';

export const SENSOR_HEIGHT = 0.024;   // full-frame, metres

/** How close to straight up or straight down the chase camera may be aimed. */
const POLE_MARGIN = 0.14;   // rad, about 8 degrees

/**
 * Swing `dir` down by `angle` in the plane it shares with `up`.
 *
 * A rotation about the camera's own right axis, not about world X, so it does
 * the same thing whatever compass bearing the look is on -- and, crawling, it
 * pitches relative to the petal the bee is standing on rather than relative to
 * the sky. Looking straight along `up` there is no such plane and nothing to
 * pitch within, so the direction is returned untouched.
 */
/**
 * Hold `dir` at least `margin` radians off the `up` axis, keeping its bearing.
 *
 * lookAt has no defined roll along its own up vector, and approaching it the
 * roll becomes arbitrarily sensitive: a degree of yaw spins the horizon. The
 * look's own limit already stops short of vertical (PITCH_LIMIT in flight.js),
 * but the chase tilt spends part of the margin that limit was leaving, so the
 * guard belongs here where the two are finally added together rather than in
 * either one of them.
 */
function clampOffPole(dir, up, margin) {
  const c = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2];
  const limit = Math.cos(margin);
  if (Math.abs(c) <= limit) return dir;
  const horiz = [dir[0] - up[0] * c, dir[1] - up[1] * c, dir[2] - up[2] * c];
  const hl = Math.hypot(horiz[0], horiz[1], horiz[2]);
  // Exactly on the pole there is no bearing left to keep, and nothing this can
  // do that is better than what the caller already has.
  if (hl < 1e-6) return dir;
  const s = Math.sin(margin) / hl;
  const k = Math.sign(c) * limit;
  return [
    horiz[0] * s + up[0] * k,
    horiz[1] * s + up[1] * k,
    horiz[2] * s + up[2] * k,
  ];
}

function pitchDown(dir, up, angle) {
  const dotUp = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2];
  const perp = [up[0] - dir[0] * dotUp, up[1] - dir[1] * dotUp, up[2] - dir[2] * dotUp];
  const len = Math.hypot(perp[0], perp[1], perp[2]);
  if (len < 1e-4) return dir;
  const c = Math.cos(angle), s = Math.sin(angle) / len;
  return [
    dir[0] * c - perp[0] * s,
    dir[1] * c - perp[1] * s,
    dir[2] * c - perp[2] * s,
  ];
}

export class MacroCamera {
  constructor() {
    this.focalLength = 0.055;         // metres
    // Stopped down well past the macro-lens default: at f/4 the field is a
    // couple of millimetres deep at bee scale, which throws almost everything
    // but the exact thing looked at into blur. f/12 gives enough depth to
    // read a flower and the ground under it in the same glance while still
    // softening the background behind it.
    this.fNumber = 12.0;
    this.focusDistance = 0.20;
    this.autoFocus = true;

    // A crawling bee's eye sits about 4mm off the petal, so the near plane has
    // to be closer than that or the surface underfoot clips away.
    this.near = 0.004;
    // The ground disc runs to sixty metres, and the horizon has to be inside
    // the frustum or the sky's own ground shows through a hole where the disc
    // was clipped. Safe here because the depth buffer is float32: with a
    // 1/distance distribution the near field keeps far more precision than a
    // unorm24 buffer would give it.
    this.far = 80.0;

    this.flyPosition = [0, 0.4, 0.3];
    this.flyForward = [0, 0, -1];
    this.flyUp = [0, 1, 0];
    this.subject = [0, FLOWER.stemHeight, 0];  // what the lens focuses on

    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.invViewProj = mat4();
    this.position = [0, 0, 0];
  }

  /** Vertical field of view implied by the lens and sensor. */
  get fovY() {
    return 2 * Math.atan(SENSOR_HEIGHT / (2 * this.focalLength));
  }

  /**
   * Drive the camera from the flight model. `up` is not always world up: a bee
   * crawling under a flower is upside down, and the horizon has to roll with it
   * or the view reads as the world having tipped rather than the bee.
   */
  setFly(position, forward, up = [0, 1, 0]) {
    this.flyPosition = position;
    this.flyForward = forward;
    this.flyUp = up;
  }

  /**
   * Third-person rig: behind the subject, above it, and aimed BELOW it.
   *
   * Measured in the SUBJECT's frame, not the world's, so the rig holds while
   * the bee is crawling round the side of a flower head and its up is the
   * petal's normal rather than the sky. Built on top of setFly rather than
   * beside it, so there is still one flying camera and one place that decides
   * what the eye is looking at.
   *
   * `tilt` is what makes the view an over-the-shoulder one rather than a
   * gunsight. The rig runs along the look, so without it the bee sits dead
   * centre and half the frame is spent on sky -- and the ground the bee is
   * trying to land on is squeezed into the bottom edge, or off it. Pitching
   * the camera down by a fixed angle after the rig is built pushes the bee up
   * into the top third and spends the frame it vacates on what is underneath.
   * The bee stays exactly on the thrust axis either way, so where it sits on
   * screen is still where the boost will take it; it is simply no longer the
   * middle of the screen.
   *
   * The floor clamp is the one concession to the world: a bee walking on a
   * clover leaf sits about 20mm up, and a rig 68mm behind and 30mm above would
   * otherwise put the eye under the soil looking at the underside of it.
   */
  setChase(subject, forward, up, { back, lift, ahead, tilt = 0, minEyeY = 0.006 }) {
    const f = normalize([forward[0], forward[1], forward[2]]);
    const u = normalize([up[0], up[1], up[2]]);
    const eye = [
      subject[0] - f[0] * back + u[0] * lift,
      subject[1] - f[1] * back + u[1] * lift,
      subject[2] - f[2] * back + u[2] * lift,
    ];
    eye[1] = Math.max(eye[1], minEyeY);
    const at = [
      subject[0] + f[0] * ahead,
      subject[1] + f[1] * ahead,
      subject[2] + f[2] * ahead,
    ];
    // The rig also settles what the lens focuses on: the subject it was built
    // around. Copied, because the caller's is the live position array and this
    // must not alias it. The rig offset is fixed, so this is a fixed focus
    // distance in all but name -- it just picks up the floor clamp for free.
    this.subject = [subject[0], subject[1], subject[2]];
    let dir = normalize([at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]);
    if (tilt !== 0) dir = pitchDown(dir, u, tilt);
    return this.setFly(eye, clampOffPole(dir, u, POLE_MARGIN), u);
  }

  update(aspect) {
    this.position = this.flyPosition;
    const at = [
      this.position[0] + this.flyForward[0],
      this.position[1] + this.flyForward[1],
      this.position[2] + this.flyForward[2],
    ];
    // Focus on the subject, which flying means the bee -- see setChase. It sat
    // on the nearest FLOWER for a while, on the theory that the flower is what
    // a photographer would hold focus on. In a meadow of six hundred of them it
    // reads as the lens hunting: the nearest head changes as you cross the
    // field, and the plane of focus jumps a foot at a time to a plant you were
    // not looking at and had no way to predict. The bee is a fixed distance
    // away and never surprises anyone.
    if (this.autoFocus) {
      const d = Math.hypot(
        this.subject[0] - this.position[0],
        this.subject[1] - this.position[1],
        this.subject[2] - this.position[2],
      );
      this.focusDistance = Math.max(0.04, Math.min(4.0, d));
    }
    lookAt(this.view, this.position, at, this.flyUp);
    perspective(this.proj, this.fovY, aspect, this.near, this.far);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
    return this;
  }

  /**
   * Depth reconstruction constants: ndcZ = A + B / viewDistance.
   * Derived from the projection so the two can never drift apart.
   */
  get depthParams() {
    const A = this.far / (this.far - this.near);
    return { A, B: -A * this.near };
  }

  get tanHalfFovY() { return Math.tan(this.fovY / 2); }
}
