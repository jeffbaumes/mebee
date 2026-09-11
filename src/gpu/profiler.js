// Per-pass GPU timing, from the device's own clock.
//
// A frame that is slow tells you nothing about WHICH pass is slow, and on a
// tiler the CPU-side timings are all wrong anyway: submit returns long before
// the GPU has finished. So this writes a timestamp either side of every pass
// and reads the pairs back a few frames later.
//
// It is optional in two directions. The `timestamp-query` feature may not be
// present (Safari, and Chrome without the flag), in which case every method
// here is a no-op and the renderer is unchanged; and the readback is
// double-buffered through a ring so a frame never blocks on a map.

const RING = 3;

export class Profiler {
  /**
   * @param {GPUDevice} device
   * @param {string[]} passes  labels, in the order they are encoded
   */
  constructor(device, passes) {
    this.device = device;
    this.passes = passes;
    this.enabled = device.features.has('timestamp-query');
    /** Smoothed milliseconds per pass, in `passes` order. */
    this.ms = new Float64Array(passes.length);
    if (!this.enabled) return;

    // Two timestamps per pass.
    this.slots = passes.length * 2;
    this.querySet = device.createQuerySet({
      type: 'timestamp', count: this.slots, label: 'pass-timing',
    });
    this.resolveBuffer = device.createBuffer({
      size: this.slots * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.staging = Array.from({ length: RING }, () => device.createBuffer({
      size: this.slots * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    this.free = this.staging.map((_, i) => i);
    this.index = new Map(passes.map((p, i) => [p, i]));
  }

  /**
   * Timestamp writes for one pass, spread into a render/compute pass
   * descriptor. Returns undefined when profiling is off, which is exactly
   * what the descriptor field wants.
   */
  writes(label) {
    if (!this.enabled) return undefined;
    const i = this.index.get(label);
    if (i === undefined) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    };
  }

  /** Resolve into a staging slot. Call once, after the last pass is encoded. */
  resolve(encoder) {
    if (!this.enabled) return;
    const slot = this.free.pop();
    if (slot === undefined) return;          // all three in flight; skip a frame
    this.pending = slot;
    encoder.resolveQuerySet(this.querySet, 0, this.slots, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.staging[slot], 0, this.slots * 8);
  }

  /** Map the slot resolve() staged. Call after submit. */
  read() {
    if (!this.enabled || this.pending === undefined) return;
    const slot = this.pending;
    this.pending = undefined;
    const buf = this.staging[slot];
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(buf.getMappedRange().slice(0));
      buf.unmap();
      this.free.push(slot);
      for (let i = 0; i < this.passes.length; i++) {
        const dt = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;   // ns -> ms
        // A pass that was not encoded this frame leaves its pair untouched,
        // which reads as zero or as garbage from an earlier frame; both are
        // rejected here rather than smeared into the average.
        if (dt >= 0 && dt < 200) this.ms[i] += (dt - this.ms[i]) * 0.1;
      }
    }).catch(() => { this.free.push(slot); });
  }

  /** Milliseconds of GPU in the whole frame, or 0 when it cannot be measured. */
  total() {
    if (!this.enabled) return 0;
    let t = 0;
    for (let i = 0; i < this.passes.length; i++) t += this.ms[i];
    return t;
  }

  /** Milliseconds in every pass whose label starts with `prefix`. */
  sum(prefix) {
    if (!this.enabled) return 0;
    let t = 0;
    for (let i = 0; i < this.passes.length; i++) {
      if (this.passes[i].startsWith(prefix)) t += this.ms[i];
    }
    return t;
  }

  /**
   * One HUD line. `groups` is a list of [label, prefix]; anything matching
   * more than one prefix is counted under the first, so order them
   * specific-first.
   */
  report(groups) {
    if (!this.enabled) return '';
    let total = 0;
    const parts = groups.map(([label, prefix]) => {
      const t = this.sum(prefix);
      total += t;
      return `${label} ${t.toFixed(1)}`;
    });
    return `gpu ${total.toFixed(1)}ms = ` + parts.join('  ');
  }
}
