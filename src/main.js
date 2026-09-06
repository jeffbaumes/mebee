// Entry point: device bring-up, input, and the frame loop.

import { initWebGPU } from './gpu/device.js';
import { Renderer } from './render/renderer.js';
import { MacroCamera } from './render/camera.js';
import { BeeFlight } from './sim/flight.js';
import { FLOWER, buildRayMesh } from './geom/flower.js';
import { FLOATS_PER_VERTEX } from './geom/mesh.js';

/** Widest extent of the flower head, measured rather than assumed. */
function headRadius() {
  const ray = buildRayMesh();
  let r = 0;
  for (let i = 0; i < ray.vertexCount; i++) {
    const o = i * FLOATS_PER_VERTEX;
    r = Math.max(r, Math.hypot(ray.vertices[o], ray.vertices[o + 2]));
  }
  return r;
}
const HEAD_RADIUS = headRadius();

// Anything that throws outside boot()'s own try/catch -- a listener, a late
// rejection -- would otherwise just leave the loading overlay up forever with
// no indication of why.
window.addEventListener('error', (e) => reportFatal(e.message, e.filename ? `${e.filename}:${e.lineno}` : ''));
window.addEventListener('unhandledrejection', (e) =>
  reportFatal(e.reason?.message ?? String(e.reason), 'unhandled rejection'));

// A long press must not raise the callout menu, and iOS page-pinch must not
// fight the in-canvas gestures. Both are document-level and cannot be handled
// by touch-action alone.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

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
  // Direct sun now enters as albedo/pi * E, so a mid-grey (0.18) under a
  // sunIntensity of 20 lands near 1.15 pre-tonemap -- close to clipping.
  // Halving brings it to a mid-tone; this is the knob to reach for first if
  // the image comes out blown or muddy.
  exposure: 0.5,
  bloomStrength: 0.055,
  grain: 0.020,
  chromatic: 0.0022,
  vignette: 0.85,
  renderScale: 1.0,
  animate: true,
  debugView: 0,
  mode: 'orbit',           // 'orbit' inspects the flower, 'fly' is the bee
};

const camera = new MacroCamera();
const bee = new BeeFlight();

let fatalReported = false;
function reportFatal(message, detail) {
  if (fatalReported) return;
  fatalReported = true;
  fail(message, detail);
}

function fail(message, detail) {
  hud.hidden = true;
  document.getElementById('loading').hidden = true;
  document.getElementById('error').hidden = false;
  document.getElementById('error-msg').textContent = message;
  document.getElementById('error-detail').textContent = detail || '';
  console.error(message, detail);
}

// --- input -----------------------------------------------------------------
// Radius, in CSS pixels, at which the steering drag reaches full deflection.
// 60 rather than 90: the stick appears under the thumb, so this is the whole
// travel available without repositioning the hand.
const STICK_RADIUS = 60;
const STICK_SIZE = 132;

function bindInput() {
  const pointers = new Map();
  let lastPinch = 0;
  let multiTouch = false;
  let travelled = 0;
  let lastTapTime = 0;
  // Virtual stick: where the steering drag started, and where it is now.
  let stickId = null;
  let stickOrigin = { x: 0, y: 0 };
  const stickEl = document.getElementById('stick');
  const knobEl = document.getElementById('stick-knob');

  /** Move the joystick under the thumb, so no reach is ever required. */
  const placeStick = (x, y) => {
    stickEl.style.left = `${x - STICK_SIZE / 2}px`;
    stickEl.style.top = `${y - STICK_SIZE / 2}px`;
    stickEl.style.bottom = 'auto';
    stickEl.classList.add('active');
  };
  const restStick = () => {
    stickEl.style.left = '';
    stickEl.style.top = '';
    stickEl.style.bottom = '';
    stickEl.classList.remove('active');
    knobEl.style.transform = '';
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size > 1) multiTouch = true;
    if (state.mode === 'fly' && stickId === null) {
      stickId = e.pointerId;
      stickOrigin = { x: e.clientX, y: e.clientY };
      placeStick(e.clientX, e.clientY);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    travelled += Math.hypot(dx, dy);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (state.mode === 'fly') {
      // Rate control, not delta control: hold the drag off-centre and the bee
      // keeps turning. Delta steering would need continuous thumb travel to
      // hold a turn, which is unusable on a phone.
      if (e.pointerId === stickId) {
        // Clamp to a disc, not a square, so a diagonal drag cannot exceed full
        // deflection on both axes at once.
        let ox = e.clientX - stickOrigin.x;
        let oy = e.clientY - stickOrigin.y;
        const len = Math.hypot(ox, oy);
        if (len > STICK_RADIUS) {
          ox *= STICK_RADIUS / len;
          oy *= STICK_RADIUS / len;
        }
        bee.steer = [ox / STICK_RADIUS, oy / STICK_RADIUS];
        knobEl.style.transform = `translate(${ox}px, ${oy}px)`;
      }
      return;
    }

    if (pointers.size === 1) {
      camera.orbit(dx * 0.006, dy * 0.006);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch > 0) camera.dolly(lastPinch / Math.max(1, d));
      lastPinch = d;
    }
  });

  const release = (e) => {
    const wasTap = !multiTouch && travelled < 12 && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (e.pointerId === stickId) {
      stickId = null;
      bee.steer = [0, 0];          // release levels the bee out
      restStick();
    }
    if (pointers.size < 2) lastPinch = 0;
    if (pointers.size > 0) return;

    if (wasTap && state.mode === 'orbit') {
      const now = performance.now();
      if (now - lastTapTime < 320) {
        camera.resetFraming();
        camera.frameSubject(HEAD_RADIUS, canvas.width / canvas.height);
      }
      lastTapTime = now;
    }
    multiTouch = false;
    travelled = 0;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('wheel', (e) => {
    if (state.mode === 'fly') return;
    e.preventDefault();
    camera.dolly(Math.exp(e.deltaY * 0.0011));
  }, { passive: false });

  // --- boost ---------------------------------------------------------------
  const boostBtn = document.getElementById('boost');
  const setBoost = (on) => {
    bee.boost = on ? 1 : 0;
    boostBtn.classList.toggle('held', on);
  };
  boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setBoost(true); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    boostBtn.addEventListener(ev, () => setBoost(false));
  }
  // A pointer lost to a phone call or a backgrounded tab must not stick.
  window.addEventListener('blur', () => setBoost(false));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setBoost(true); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') setBoost(false); });

  // --- mode ----------------------------------------------------------------
  document.getElementById('mode').addEventListener('click', () => setMode(
    state.mode === 'orbit' ? 'fly' : 'orbit'));
}

function setMode(mode) {
  state.mode = mode;
  const flying = mode === 'fly';
  document.getElementById('mode').textContent = flying ? 'Orbit' : 'Fly';
  document.getElementById('boost').hidden = !flying;
  document.getElementById('stick').hidden = !flying;
  document.getElementById('hint').hidden = !flying;
  bee.steer = [0, 0];
  bee.boost = 0;
  document.getElementById('boost').classList.remove('held');
  document.getElementById('boost').textContent = 'CLIMB';

  if (flying) {
    bee.reset();
    // A macro lens is a telescope to fly with. Widen for flight, and put the
    // aperture back where the depth of field still reads at this distance.
    camera.focalLength = 0.030;
    camera.mode = 'fly';
  } else {
    camera.focalLength = 0.055;
    camera.mode = 'orbit';
    camera.resetFraming();
    camera.frameSubject(HEAD_RADIUS, canvas.width / canvas.height);
  }
  const fl = document.getElementById('focalLength');
  if (fl) {
    fl.value = camera.focalLength;
    fl.dispatchEvent(new Event('input'));
  }
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
  // Whole header toggles, so the target is a thumb rather than a 24px glyph.
  const panel = document.getElementById('panel');
  panel.classList.toggle('open', window.innerWidth > 560);
  document.getElementById('panel-header').addEventListener('click', () => {
    panel.classList.toggle('open');
  });
  document.getElementById('debugView').addEventListener('change', (e) => {
    state.debugView = parseInt(e.target.value, 10) || 0;
  });
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2) * state.renderScale;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  // Re-fit on rotation: portrait and landscape need very different distances.
  camera.frameSubject(HEAD_RADIUS, canvas.width / canvas.height);
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

  const stage = (text) => {
    const p = document.querySelector('#loading p');
    if (p) p.textContent = text;
    // Let the browser paint before the next synchronous burst; the leaf bake
    // alone blocks for the better part of a second on a phone.
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  };

  let renderer;
  try {
    await stage('Compiling shaders and growing the flower…');
    // Uncaptured GPU errors are otherwise silent: the frame just goes black.
    gpu.device.pushErrorScope('validation');
    renderer = await Renderer.create(gpu.device, gpu.context, gpu.format, canvas);
    const err = await gpu.device.popErrorScope();
    if (err) throw new Error(err.message);
  } catch (e) {
    fail('Failed to build the render pipeline.', e.message);
    return;
  }

  let reportedErrors = 0;
  gpu.device.addEventListener?.('uncapturederror', (e) => {
    const msg = e.error?.message ?? String(e);
    console.error('WebGPU error:', msg);
    // Only the first few: a per-frame error would otherwise flood the panel.
    if (reportedErrors++ < 3) {
      const el = document.getElementById('diag');
      if (el) el.textContent = `GPU error: ${msg.slice(0, 400)}`;
    }
  });

  bindInput();
  bindControls();
  document.getElementById('build').textContent =
    `build ${globalThis.__BUILD__ ?? 'dev'}`;
  document.getElementById('loading').hidden = true;

  // Readback diagnostics. Reported on screen as well as logged, so the numbers
  // can be relayed without needing devtools open.
  const diag = document.getElementById('diag');
  document.getElementById('diagnose').addEventListener('click', async () => {
    diag.textContent = 'reading…';
    try {
      const [hdr, stem] = await Promise.all([renderer.probeHDR(), renderer.probeStem()]);
      const text =
        `hdr  min ${hdr.min.toExponential(2)}  max ${hdr.max.toExponential(2)}\n` +
        `     mean ${hdr.mean.toExponential(2)}  nan ${(hdr.nanFraction * 100).toFixed(1)}%\n` +
        `stem finite=${stem.finite}\n` +
        `     n0 ${JSON.stringify(stem.first.pos)}\n` +
        `     n15 ${JSON.stringify(stem.last.pos)}\n` +
        `     axis15 ${JSON.stringify(stem.last.axis)}\n` +
        `cam  ${camera.position.map((v) => v.toFixed(3)).join(', ')}  d=${camera.distance.toFixed(3)}`;
      diag.textContent = text;
      console.log(text);
    } catch (e) {
      diag.textContent = `probe failed: ${e.message}`;
      console.error(e);
    }
  });

  const boostLabel = document.getElementById('boost');
  const hintEl = document.getElementById('hint');
  let lastBeeMode = bee.mode;

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

    if (state.mode === 'fly') {
      // The head's frame arrives from the GPU a couple of frames late, which
      // is far below what is visible at the speed the flower sways.
      const head = renderer.headFrame;
      bee.update(dt, head);
      const fwd = bee.viewForward(head);
      camera.setFly(bee.position, fwd, bee.upVector(head));
      // Focus a short way ahead while crawling. Focusing on the flower's centre
      // -- millimetres away, and clamped up to the minimum focus distance --
      // would leave everything the bee is standing on out of focus.
      camera.subject = bee.mode === 'crawl'
        ? [bee.position[0] + fwd[0] * 0.035,
           bee.position[1] + fwd[1] * 0.035,
           bee.position[2] + fwd[2] * 0.035]
        : [0, FLOWER.stemHeight, 0];
      if (bee.mode !== lastBeeMode) {
        lastBeeMode = bee.mode;
        const crawling = bee.mode === 'crawl';
        boostLabel.textContent = crawling ? 'TAKE OFF' : 'CLIMB';
        hintEl.textContent = crawling
          ? 'stick: walk the flower \u00b7 take off to leave'
          : 'stick: turn \u0026 throttle \u00b7 hold to climb';
      }
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
