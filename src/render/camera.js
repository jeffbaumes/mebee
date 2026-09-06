// Physical macro-lens camera.
//
// Framing and defocus are driven by the same lens, so changing the aperture
// changes only the blur and changing the focal length changes only the field
// of view -- the way a real camera behaves. Both feed the shader as physical
// quantities rather than as tuned blur radii.

import { mat4, lookAt, perspective, invert, multiply } from './math.js';

export const SENSOR_HEIGHT = 0.024;   // full-frame, metres

export class MacroCamera {
  constructor() {
    this.target = [0, 0.40, 0];       // the flower head
    // Far enough back that the whole head plus some stem is in frame; at 0.20
    // the flower filled better than 80% of the height and read as a wall of
    // petals rather than a flower.
    this.distance = 0.26;
    this.yaw = 0.75;
    this.pitch = 0.22;

    this.focalLength = 0.055;         // metres
    this.fNumber = 4.0;
    this.focusDistance = 0.20;
    this.autoFocus = true;

    this.near = 0.01;
    this.far = 12.0;

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

  orbit(dx, dy) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy));
  }

  dolly(factor) {
    this.distance = Math.max(0.045, Math.min(1.2, this.distance * factor));
  }

  update(aspect) {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.position = [
      this.target[0] + Math.sin(this.yaw) * cp * this.distance,
      this.target[1] + sp * this.distance,
      this.target[2] + Math.cos(this.yaw) * cp * this.distance,
    ];
    // Focusing on the orbit target is what a photographer does, and it keeps
    // the subject sharp while the background falls away.
    if (this.autoFocus) this.focusDistance = this.distance;

    lookAt(this.view, this.position, this.target, [0, 1, 0]);
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
