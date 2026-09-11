// Dynamic resolution: hold the refresh interval by moving the render scale.
//
// The one thing that reliably makes this scene expensive is pixels. Almost
// every shader in it is fragment-bound -- the sward, the ground, the petals,
// the defocus gather -- so cost tracks the backing store's area, and area is
// the only knob that moves smoothly. Geometry is already chosen by the lens
// (render/lod.js), and dropping detail to hold a frame rate would fight that.
//
// It is also the least visible knob this scene has, which is not a general
// truth about renderers -- it is true HERE because the image is a macro
// photograph. Everything past a few centimetres is already inside a circle of
// confusion tens of pixels wide, so the resolution that matters is the sharp
// sliver at the focal plane, and even that is resampled by the defocus chain
// on its way out. Rendering three quarters of the way up and letting the post
// chain resolve costs a fraction of what dropping the sward would.
//
// The floor is one canvas pixel per CSS pixel: below that the in-focus edges
// start to crawl, and the honest answer is a smaller window, not a softer one.
//
// What it steers on
// -----------------
// Wall-clock frame time is what the player feels, but it is not something the
// scale can move directly: a frame is our GPU work plus a presentation cost --
// compositing, the swap chain, whatever else owns the display -- that the
// render scale does nothing about. Steering on wall clock alone therefore
// spirals to the floor whenever that overhead is what is missing the target.
// Steering on GPU time alone needs a budget picked in advance, and the right
// budget depends on the machine.
//
// So it uses both. While frames are being MISSED the two together give the
// overhead directly (wall minus GPU), and what is left of the refresh interval
// after paying it is the budget the scale can actually chase. While frames are
// being MADE, wall clock is pinned to the refresh interval and says nothing at
// all -- so the rule there is simply to try a step up now and then, and let
// the miss case take it back if that was too far.

/** Frames of clear air before trying a higher scale. Roughly two seconds. */
const CLIMB_AFTER = 110;

/**
 * Ceiling on that wait, and how fast a failed attempt pushes toward it.
 *
 * A scene will usually sit between two steps -- comfortable at 0.60, a shade
 * too slow at 0.65 -- and a governor that retries the higher one on a fixed
 * timer pumps the resolution up and down forever. So each attempt that has to
 * be taken straight back triples the wait before the next, which turns a
 * two-second pulse into a once-a-minute one within three tries and leaves the
 * image sitting still. A climb that STICKS resets it, so a scene that genuinely
 * gets cheaper -- the bee flies out of the sward, the aperture opens -- is
 * picked up again within a couple of seconds.
 */
const CLIMB_MAX = 3600;
const CLIMB_BACKOFF = 3;

/** Frames a climb has to survive before it counts as having worked. */
const PROBATION = 240;

/** Below this there is no point taking pixels away: the cost is elsewhere. */
const MIN_GPU_MS = 3.0;

export class ResolutionGovernor {
  constructor({ targetHz = 60, step = 0.05 } = {}) {
    this.targetMs = 1000 / targetHz;
    this.step = step;
    this.scale = 1;
    this.min = 0.5;
    this.max = 1;
    /** Smoothed wall clock and GPU time, in ms. Long, so a gust cannot move it. */
    this.wallMs = 0;
    this.gpuMs = 0;
    /** Frames to ignore after a change: a resize reallocates every target. */
    this.settle = 0;
    this.holdFor = 0;
    this.good = 0;
    this.climbAfter = CLIMB_AFTER;
    this.probation = 0;
  }

  /**
   * The floor, from the display. One canvas pixel per CSS pixel is the point
   * below which this stops being "a slightly softer photograph".
   */
  setFloor(dpr) {
    this.min = Math.min(1, Math.max(0.35, 1 / Math.max(1, dpr)));
    this.scale = Math.max(this.min, this.scale);
  }

  /**
   * @param {number} gpuMs  GPU time for this frame, or 0 if unmeasurable
   * @param {number} dt     wall-clock frame time in seconds
   * @returns {number|null} a new scale to apply, or null to leave it alone
   */
  update(gpuMs, dt) {
    if (this.settle > 0) { this.settle--; return null; }
    const wall = dt * 1000;
    const k = this.wallMs === 0 ? 1 : 0.06;
    this.wallMs += (wall - this.wallMs) * k;
    this.gpuMs += (gpuMs - this.gpuMs) * k;
    if (this.holdFor > 0) { this.holdFor--; return null; }

    // 1.08 rather than 1.0: a frame that lands a whisker late is a frame that
    // landed, and a display running at 59.94 is not a performance problem.
    const missing = this.wallMs > this.targetMs * 1.08;
    if (!missing) {
      // Vsync is holding the frame time down, so it carries no information
      // about how much room is left. Climb a step on a long clear run and find
      // out; if that was too far, the branch below undoes it within a second.
      if (this.probation > 0 && --this.probation === 0) {
        // It held. Whatever made the last attempt fail is gone.
        this.climbAfter = CLIMB_AFTER;
      }
      if (this.scale >= this.max) { this.good = 0; return null; }
      if (++this.good < this.climbAfter) return null;
      const up = this.#apply(this.scale + this.step);
      if (up !== null) this.probation = PROBATION;
      return up;
    }
    this.good = 0;
    if (this.probation > 0) {
      // The last climb did not survive. Wait longer before trying that again.
      this.probation = 0;
      this.climbAfter = Math.min(CLIMB_MAX, this.climbAfter * CLIMB_BACKOFF);
    }

    // Without timestamps there is no way to separate our cost from the
    // presentation's, so assume it is all ours and step down. Slower than the
    // measured case, because a wrong guess here is a permanently soft image.
    if (this.gpuMs <= 0) return this.#apply(this.scale - this.step);

    // What is left of the refresh interval once the overhead is paid. Floored,
    // because when the overhead alone misses the target no amount of scaling
    // reaches it, and grinding down to a quarter resolution to not fix that is
    // worse than the dropped frames.
    const overhead = Math.max(0, this.wallMs - this.gpuMs);
    const budget = Math.max(MIN_GPU_MS, this.targetMs - overhead);
    if (this.gpuMs <= budget) return null;      // the overhead is the problem

    // Cost goes as the area, so the scale that fits is the square root of the
    // ratio. Damped to half of it: the measurement is a long average, and
    // over-correcting on a stale one is what makes these oscillate.
    const ideal = this.scale * Math.sqrt(budget / this.gpuMs);
    return this.#apply(this.scale + 0.5 * (ideal - this.scale));
  }

  /** Quantise, clamp, and hold still long enough to see what it did. */
  #apply(want) {
    const clamped = Math.max(this.min, Math.min(this.max,
      Math.round(Math.max(this.scale - 2 * this.step,
                          Math.min(this.scale + this.step, want)) / this.step) * this.step));
    if (Math.abs(clamped - this.scale) < this.step * 0.5) return null;
    this.scale = clamped;
    // A resize destroys and rebuilds every render target and every bind group
    // that names one, which costs a frame or two; measuring across that would
    // read as a spike and provoke another change.
    this.settle = 8;
    this.holdFor = 45;
    this.good = 0;
    return clamped;
  }
}
