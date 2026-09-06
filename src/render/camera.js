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
    this.minDistance = 0.045;
    this.maxDistance = 2.0;
    this.distance = 0.30;             // replaced by frameSubject() on first layout
    // Auto-framing steps aside as soon as the viewer zooms themselves.
    this.userAdjusted = false;

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

  /**
   * Distance at which a subject of `radius` just fits the frame.
   *
   * The binding constraint is whichever axis is narrower, which on a portrait
   * phone is the horizontal one -- and by a lot. Framing on vertical FOV alone
   * looked right on a 16:9 desktop while cutting the flower off on a phone:
   * at 0.26m a 390x844 viewport sees 52mm across, and the flower is 71mm.
   */
  fitDistance(radius, aspect, margin = 1.18) {
    const halfY = this.fovY / 2;
    const halfX = Math.atan(Math.tan(halfY) * aspect);
    return (radius * margin) / Math.tan(Math.min(halfX, halfY));
  }

  /** Frame the subject, unless the viewer has taken manual control. */
  frameSubject(radius, aspect) {
    if (this.userAdjusted) return;
    this.distance = Math.min(this.maxDistance,
      Math.max(this.minDistance, this.fitDistance(radius, aspect)));
  }

  orbit(dx, dy) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch + dy));
  }

  dolly(factor) {
    this.userAdjusted = true;
    this.distance = Math.max(this.minDistance,
      Math.min(this.maxDistance, this.distance * factor));
  }

  /** Hand framing back to the automatic fit. */
  resetFraming() { this.userAdjusted = false; }

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
