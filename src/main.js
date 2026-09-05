// Entry point: device bring-up, input, and the frame loop.

import { initWebGPU } from './gpu/device.js';
import { Renderer } from './render/renderer.js';
import { MacroCamera } from './render/camera.js';

const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const fpsEl = document.getElementById('fps');

const state = {
  sunElevation: 0.30,      // radians above the horizon
  sunAzimuth: 2.35,
  sunIntensity: 20.0,
  wind: 0.55,
  windDir: 0.9,
  time: 0,
  bloom: 1.0,              // 0 = bud, 1 = open
  floretFront: 0.35,       // maturation front; sweeps 1 -> 0 as the disc opens
  exposure: 1.0,
  bloomStrength: 0.055,
  grain: 0.020,
  chromatic: 0.0022,
  vignette: 0.85,
  renderScale: 1.0,
  animate: true,
};

const camera = new MacroCamera();

function fail(message, detail) {
  hud.hidden = true;
  document.getElementById('error').hidden = false;
  document.getElementById('error-msg').textContent = message;
  document.getElementById('error-detail').textContent = detail || '';
  console.error(message, detail);
}

// --- input -----------------------------------------------------------------
function bindInput() {
  const pointers = new Map();
  let lastPinch = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      camera.orbit(dx * 0.006, dy * 0.006);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0) camera.dolly(lastPinch / Math.max(1, d));
      lastPinch = d;
    }
  });

  const release = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.dolly(Math.exp(e.deltaY * 0.0011));
  }, { passive: false });
}

/** Wire every slider to its state or camera field. */
function bindControls() {
  const targets = {
    sunElevation: (v) => { state.sunElevation = v; },
    wind: (v) => { state.wind = v; },
    bloom: (v) => { state.bloom = v; },
    floretFront: (v) => { state.floretFront = v; },
    fNumber: (v) => { camera.fNumber = v; },
    focalLength: (v) => { camera.focalLength = v; },
    exposure: (v) => { state.exposure = v; },
    bloomStrength: (v) => { state.bloomStrength = v; },
    grain: (v) => { state.grain = v; },
    chromatic: (v) => { state.chromatic = v; },
    renderScale: (v) => { state.renderScale = v; resizeCanvas(); },
  };
  for (const [id, apply] of Object.entries(targets)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const out = document.getElementById(`${id}-val`);
    const sync = () => {
      const v = parseFloat(el.value);
      apply(v);
      if (out) out.textContent = v.toFixed(el.dataset.digits ? +el.dataset.digits : 2);
    };
    el.addEventListener('input', sync);
    sync();
  }
  document.getElementById('animate').addEventListener('change', (e) => {
    state.animate = e.target.checked;
  });
  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('collapsed');
  });
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * state.renderScale;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
}

// --- boot ------------------------------------------------------------------
(async function boot() {
  let gpu;
  try {
    gpu = await initWebGPU(canvas);
  } catch (e) {
    fail(e.message, 'chrome://gpu (or Safari 26+/Chrome 113+) can confirm WebGPU support.');
    return;
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  let renderer;
  try {
    // Uncaptured GPU errors are otherwise silent: the frame just goes black.
    gpu.device.pushErrorScope('validation');
    renderer = await Renderer.create(gpu.device, gpu.context, gpu.format, canvas);
    const err = await gpu.device.popErrorScope();
    if (err) throw new Error(err.message);
  } catch (e) {
    fail('Failed to build the render pipeline.', e.message);
    return;
  }

  gpu.device.addEventListener?.('uncapturederror', (e) => {
    console.error('WebGPU error:', e.error?.message ?? e);
  });

  bindInput();
  bindControls();
  document.getElementById('loading').hidden = true;

  let last = performance.now();
  let frames = 0, fpsClock = last;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    state.time += dt;

    if (state.animate) {
      // The maturation front creeps inward, so the disc opens outside-in the
      // way a real capitulum does over a few days.
      state.floretFront = 0.5 + 0.5 * Math.cos(state.time * 0.06);
      document.getElementById('floretFront').value = state.floretFront;
    }

    camera.update(canvas.width / canvas.height);
    renderer.render(camera, state, dt);

    frames++;
    if (now - fpsClock > 500) {
      fpsEl.textContent = `${Math.round(frames * 1000 / (now - fpsClock))} fps  ${canvas.width}x${canvas.height}`;
      frames = 0; fpsClock = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
