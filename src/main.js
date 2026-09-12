// Entry point: device bring-up, input, and the frame loop.

import { initWebGPU } from './gpu/device.js';
import { Renderer } from './render/renderer.js';
import { MacroCamera } from './render/camera.js';
import { ResolutionGovernor } from './render/resolution.js';
import { BeeFlight } from './sim/flight.js';
import { FLOWER } from './geom/flower.js';

// The "hero" plant, picked from the field once it has been grown: the biggest
// head near the middle, used for diagnostics (probeStem) and the head-position
// trace below. Until the field exists, the reference species' head is the best
// guess.
let heroPlant = -1;
const heroTarget = [0, FLOWER.stemHeight, 0];

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
  // Both are now nudges applied on top of each plant's OWN phase, which comes
  // out of species.js: the field already contains buds, half-open heads and
  // ones going over. The panel shifts the whole meadow rather than setting it.
  bloom: 1.0,              // multiplier on each plant's unfurl, 0 = all bud
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
  autoResolution: true,    // hold a frame budget by moving the render scale
  debugView: 0,
  lodBias: 1.0,            // >1 spends more geometry than the lens asks for
  grassDensity: 1.0,
  pinnedPlant: -1,         // held at the finest tier whatever the metric says
  showDebug: false,        // the upper-right fps/lod readout; off by default
};

const camera = new MacroCamera();
const bee = new BeeFlight();
/** @type {import('./render/renderer.js').Renderer|null} */
let renderer = null;

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
// Radius, in CSS pixels, at which the joystick reaches full deflection. 60
// rather than 90: the stick appears under the thumb, so this is the whole
// travel available without repositioning the hand.
const STICK_RADIUS = 60;
const STICK_SIZE = 132;
// Radians of view per CSS pixel of pointer travel. The mouse is captured and
// reports raw movement, so this is a plain delta -- move it and the view moves
// with it, stop and it stops. Nothing about the bee is on this axis.
const MOUSE_LOOK = 0.0030;

// A macro lens is a telescope to fly with. At bee scale a narrow view gives
// nothing to navigate by -- the flower fills the frame or is not in it at all.
//
// Wider again now the camera aims BELOW the bee rather than along it (see
// CHASE_FLY). The whole point of that tilt is to spend frame on the ground
// being landed on, and at 62 degrees there was no frame to spend: the horizon
// and the bee between them used all of it, and the turf the bee was descending
// onto was off the bottom edge until the moment of contact. Everything gained
// here goes downward -- what is ABOVE a bee it is not about to land on.
const FLY_FOCAL = 0.0155;    // 75 deg vertical
// Crawling, the flower head fills the lower half of the frame and the bee is
// four millimetres off it. A longer lens looks straight over the florets
// underfoot into the sky, so the walk loses the only thing it is walking on.
// It is now marginally the TIGHTER of the two, which is the right way round:
// on a flower head there is nothing further off than the head to look at.
const CRAWL_FOCAL = 0.016;   // 74 deg vertical

/**
 * Where the camera sits relative to the bee.
 *
 * Third person, and specifically third person from directly BEHIND, with no
 * vertical or angular offset, because the two things this scene is worth
 * doing are crawling over a flower head and flying down onto one -- and in
 * first person you cannot see yourself do either. The rig is measured along
 * the LOOK, not along the bee, so the mouse swings the camera round the bee
 * and the bee is seen from wherever the mouse put it.
 *
 * `lift` and `tilt` are both zero: the camera sits at the bee's own height and
 * looks exactly along its facing, so the bee sits dead centre and its thrust
 * axis runs straight through the middle of the screen. That is what makes the
 * bee itself usable as the aim reticle -- flying at a flower or walking toward
 * a landing spot is a matter of putting the bee's own silhouette on the
 * target, which only lines up when nothing has nudged the frame off that
 * axis. An earlier version lifted the rig and tilted it down to spend more of
 * the frame on the ground ahead; that read better for landing but put the
 * point you actually steer by above the centreline, which is the wrong trade
 * once precise aim matters more than a generous view of the turf.
 */
const CHASE_FLY = { back: 0.068, lift: 0, ahead: 0.018, tilt: 0 };
const CHASE_CRAWL = { back: 0.034, lift: 0, ahead: 0.013, tilt: 0 };

/**
 * Radius of the landing ring, in metres: about a bee's own length across.
 *
 * Drawn straight down from the bee onto whatever is first underneath it -- see
 * landingMark() in common.wgsl. Off while crawling, where the bee is already
 * standing on the thing the ring would be drawn on.
 */
const MARK_RADIUS = 0.014;

/**
 * How long landing and take-off take to settle the view, in seconds.
 *
 * Crawling and flying use different rigs (CHASE_CRAWL vs CHASE_FLY) and
 * different up vectors (a flower's surface normal vs world up), and both used
 * to switch on the exact frame bee.mode did -- a hard cut in both the horizon
 * roll and the camera's offset from the bee. Blending over a beat instead
 * turns that cut into a settle, which is what "smoothly on and off the
 * flower" means here: the aim itself (bee.lookDir) was already continuous
 * across the mode change, so this is the only discontinuity left to smooth.
 */
const CHASE_BLEND_TIME = 0.35;

const lerp3 = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const normalize3 = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const lerpChase = (a, b, t) => ({
  back: a.back + (b.back - a.back) * t,
  lift: a.lift + (b.lift - a.lift) * t,
  ahead: a.ahead + (b.ahead - a.ahead) * t,
  tilt: a.tilt + (b.tilt - a.tilt) * t,
});

/** Set the lens, keeping the panel's slider honest about what it is. */
function setFocalLength(metres) {
  camera.focalLength = metres;
  const fl = document.getElementById('focalLength');
  if (fl) {
    fl.value = metres;
    fl.dispatchEvent(new Event('input'));
  }
}

/**
 * Controls.
 *
 * In the air, the mouse is the only aim: it orbits the camera around the bee,
 * and the bee is always pointed dead away from the camera, on all three axes
 * -- look up or down and the nose follows, instantly, with no turn radius to
 * ease onto. A and D do nothing while flying, because there is no separate
 * turning axis left for them to drive; on a flower they still turn the walk.
 *
 *   mouse (captured)   aim. Orbits the camera, and while flying that is also
 *                      the bee's own facing and the line thrust runs along.
 *   A / D              nothing in the air. On a flower, turns the walk.
 *   W                  go, along the facing -- forward, up or down, whatever
 *                      the camera is looking along. Winds up to speed over a
 *                      beat rather than snapping to it. On a flower, walks
 *                      forward.
 *   S                  the same as W with the sign flipped, and sheds speed
 *                      fast rather than winding down slowly. On a flower,
 *                      walk backward.
 *   space / LIFT       straight up, with no facing component at all; the
 *                      launch off a flower.
 *   nothing held       drag alone brings the bee to a stop -- there is no
 *                      gravity, so it holds still rather than sinking.
 *
 * On a phone there is no pointer to capture and no keyboard, so the thumbstick
 * takes the movement axes -- turn across, go and stop along -- the LIFT button
 * takes the space bar, and a second finger anywhere else orbits.
 */
function bindInput() {
  const pointers = new Map();
  // Virtual stick: which touch owns it, and where the drag began.
  let stickId = null;
  let stickOrigin = { x: 0, y: 0 };
  // Whichever pointer is currently dragging the view: the second finger on a
  // phone, or an uncaptured mouse.
  let lookId = null;
  const stickEl = document.getElementById('stick');
  const knobEl = document.getElementById('stick-knob');

  const locked = () => document.pointerLockElement === canvas;
  // Set once the browser has told us it will not grant the lock -- an embedded
  // document that is not permitted to, most often. Drag-to-look is a perfectly
  // good fallback; what is not acceptable is asking forever for a capture that
  // is never going to come.
  let captureRefused = false;

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

  // --- pointer lock --------------------------------------------------------
  // Captured, because a look that has to be dragged is a look you keep running
  // out of screen for -- and because with the camera free of the bee there is
  // a lot more looking to do. The browser only grants it from a user gesture,
  // so the first click in fly mode spends itself on the capture.
  canvas.addEventListener('click', () => {
    if (hasTouch || captureRefused || locked()) return;
    let request;
    try {
      request = canvas.requestPointerLock?.();
    } catch {
      captureRefused = true;
    }
    // Chrome returns a promise, and a refusal rejects it. That MUST be caught:
    // an unhandled rejection reaches the global handler at the top of this
    // file, which treats it as fatal and replaces the whole app with an error
    // screen -- so a browser that simply declines to capture the pointer
    // (anything inside a frame that is not permitted to) killed the page
    // outright instead of falling back to dragging.
    request?.catch?.(() => { captureRefused = true; });
  });
  document.addEventListener('pointerlockchange', () => {
    // The mouse button cannot be released once the pointer is gone.
    if (!locked()) setBoost('mouse', false);
  });
  window.addEventListener('mousemove', (e) => {
    if (!locked()) return;
    bee.look(-e.movementX * MOUSE_LOOK, -e.movementY * MOUSE_LOOK, renderer?.sites);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (locked()) {
      // Held mouse button is a second boost, which is where a finger already
      // is once the pointer is captured.
      if (e.button === 0) setBoost('mouse', true);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // The thumbstick goes to the first finger down and drives the bee; any
    // second finger orbits. Same split in the air and on a flower, because the
    // stick now means the same thing in both.
    if (e.pointerType === 'touch' && stickId === null) {
      stickId = e.pointerId;
      stickOrigin = { x: e.clientX, y: e.clientY };
      placeStick(e.clientX, e.clientY);
    } else if (lookId === null) {
      lookId = e.pointerId;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerId === stickId) {
      // Rate control: hold the thumb off centre and it keeps going. Clamped
      // to a DISC, not a square, so a diagonal cannot exceed full deflection
      // on both axes at once.
      let ox = e.clientX - stickOrigin.x;
      let oy = e.clientY - stickOrigin.y;
      const len = Math.hypot(ox, oy);
      if (len > STICK_RADIUS) {
        ox *= STICK_RADIUS / len;
        oy *= STICK_RADIUS / len;
      }
      setStick(ox / STICK_RADIUS, oy / STICK_RADIUS);
      knobEl.style.transform = `translate(${ox}px, ${oy}px)`;
    } else if (e.pointerId === lookId) {
      // Drag-to-orbit: the second finger on a phone, and the fallback for a
      // mouse whose owner has not clicked to capture it yet.
      bee.look(-dx * MOUSE_LOOK, -dy * MOUSE_LOOK, renderer?.sites);
    }
  });

  const release = (e) => {
    if (locked()) { if (e.button === 0) setBoost('mouse', false); return; }
    pointers.delete(e.pointerId);
    if (e.pointerId === stickId) {
      stickId = null;
      setStick(0, 0);
      restStick();
    }
    if (e.pointerId === lookId) lookId = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  /**
   * The thumbstick is the WASD block: across turns, along goes and stops. It
   * used to be routed to whichever axis the mode left unreachable, which is no
   * longer a question -- the two modes take the same two axes now.
   */
  function setStick(x, y) {
    bee.steer = [x, y];
  }

  // --- lift ----------------------------------------------------------------
  // One button, and it means the same thing whatever else is happening: up. In
  // the air that is thrust straight up, with nothing forward in it; on a
  // flower it is the launch off the surface.
  const boostBtn = document.getElementById('boost');
  boostBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setBoost('button', true); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    boostBtn.addEventListener(ev, () => setBoost('button', false));
  }
  // A pointer lost to a phone call or a backgrounded tab must not stick.
  window.addEventListener('blur', clearBoost);

  // --- keyboard ------------------------------------------------------------
  // WASD is one axis pair with one meaning, in both modes: across is A/D and
  // along is W/S. What that pair DRIVES differs -- the camera's aim in the
  // air, the walk on a flower -- but that is flight.js's business, and it is
  // why this reads the keys the same way whatever the bee is doing. It used to
  // fork here, with W doubling as the boost while flying, and every state that
  // could strand a held key with the wrong meaning went through this function.
  const held = new Set();
  const WALK = {
    KeyA: [0, -1], ArrowLeft: [0, -1],
    KeyD: [0, 1], ArrowRight: [0, 1],
    KeyW: [1, -1], ArrowUp: [1, -1],
    KeyS: [1, 1], ArrowDown: [1, 1],
  };
  const applyKeys = () => {
    if (stickId !== null) return;      // a thumb already owns the movement
    let x = 0, y = 0;
    for (const code of held) {
      const axis = WALK[code];
      if (!axis) continue;
      if (axis[0] === 0) x += axis[1]; else y += axis[1];
    }
    bee.steer = [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && !WALK[e.code]) return;
    e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Space') { setBoost('space', true); return; }
    held.add(e.code);
    applyKeys();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' && !WALK[e.code]) return;
    if (e.code === 'Space') { setBoost('space', false); return; }
    held.delete(e.code);
    applyKeys();
  });
  window.addEventListener('blur', () => { held.clear(); bee.steer = [0, 0]; clearBoost(); });
  // Landing and taking off swap what the keys mean, so re-read them.
  refreshKeys = applyKeys;

  // --- settings gear ---------------------------------------------------------
  // Every slider and checkbox lives behind this one button, so it never
  // competes with the stick or the LIFT button for a corner of the screen.
  const panelEl = document.getElementById('panel');
  document.getElementById('gear').addEventListener('click', () => {
    panelEl.hidden = !panelEl.hidden;
  });
}

/** True on a device whose primary pointer cannot be captured. */
const hasTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Set by bindInput; the frame loop reaches back through this. */
let refreshKeys = () => {};

/**
 * Who is currently asking for boost.
 *
 * A set rather than a boolean, because three things can ask at once -- the
 * space bar, the on-screen button and the captured mouse button -- and any of
 * them writing the flag directly means the others can switch it off underneath
 * them. That is not hypothetical: a finger holding the button through a launch
 * used to have its claim cancelled by a keyboard with nothing held, and the
 * bee dropped straight back onto the flower it had just left.
 */
const boosting = new Set();

/** The one place the boost is written, so no path can leave it stuck on. */
function setBoost(source, on) {
  if (on) boosting.add(source); else boosting.delete(source);
  bee.boost = boosting.size > 0 ? 1 : 0;
  const btn = document.getElementById('boost');
  if (btn) btn.classList.toggle('held', bee.boost > 0);
}

/** Drop every claim, for a lost pointer or a blur. */
function clearBoost() {
  boosting.clear();
  setBoost('none', false);
}

/**
 * Set up the bee's controls. Called once at boot -- there is no other mode to
 * switch back from any more.
 *
 * The stick and the LIFT button are a touch-only affordance: a desktop
 * browser already has WASD and the space bar, so showing them there would
 * just be clutter sitting over the meadow.
 */
function initFlight() {
  document.getElementById('boost').hidden = !hasTouch;
  document.getElementById('stick').hidden = !hasTouch;
  bee.steer = [0, 0];
  clearBoost();
  document.getElementById('boost').textContent = 'LIFT';
  bee.reset();
  setFocalLength(FLY_FOCAL);
}

/** Wire every slider to its state or camera field. */
function bindControls() {
  const targets = {
    sunElevation: (v) => { state.sunElevation = v; },
    wind: (v) => { state.wind = v; },
    bloom: (v) => { state.bloom = v; },
    fNumber: (v) => { camera.fNumber = v; },
    focalLength: (v) => { camera.focalLength = v; },
    exposure: (v) => { state.exposure = v; },
    bloomStrength: (v) => { state.bloomStrength = v; },
    grain: (v) => { state.grain = v; },
    chromatic: (v) => { state.chromatic = v; },
    renderScale: (v) => { state.renderScale = v; resizeCanvas(); },
    lodBias: (v) => { state.lodBias = v; },
    grassDensity: (v) => { state.grassDensity = v; },
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
  document.getElementById('debugView').addEventListener('change', (e) => {
    state.debugView = parseInt(e.target.value, 10) || 0;
  });
  document.getElementById('showDebug').addEventListener('change', (e) => {
    state.showDebug = e.target.checked;
    document.getElementById('fps').hidden = !state.showDebug;
  });
  // Turning the slider is a statement that the player wants THIS resolution,
  // so it takes the governor off the wheel. It hangs off the event rather than
  // off the setter above because every control is synced once at startup, and
  // that sync would otherwise switch the governor off before the first frame.
  document.getElementById('renderScale').addEventListener('input', () => {
    state.autoResolution = false;
    document.getElementById('autoResolution').checked = false;
  });
  document.getElementById('autoResolution').addEventListener('change', (e) => {
    state.autoResolution = e.target.checked;
    // Handing control back starts from wherever the slider was left, so the
    // image does not jump on the frame the box is ticked.
    if (state.autoResolution) governor.scale = state.renderScale;
  });
}

/**
 * Holds the frame budget by moving the render scale. See render/resolution.js
 * for why that is the knob rather than the sward or the geometry.
 */
const governor = new ResolutionGovernor();

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  governor.setFloor(dpr);
  const scale = state.autoResolution ? governor.scale : state.renderScale;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * scale));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * scale));
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
    //
    // The timer is not belt and braces: a backgrounded tab is never handed a
    // frame at all, so waiting on requestAnimationFrame alone left boot
    // parked on this line for as long as the tab stayed hidden -- and the
    // page then came to the foreground still showing the loading overlay.
    // There is nothing to paint in that case, so whichever fires first wins.
    return new Promise((r) => {
      let settled = false;
      const go = () => { if (!settled) { settled = true; r(); } };
      requestAnimationFrame(() => setTimeout(go, 0));
      setTimeout(go, 250);
    });
  };

  try {
    await stage('Compiling shaders and growing the meadow…');
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

  // The "hero" plant, for diagnostics (probeStem) and the head-position trace.
  heroPlant = renderer.pickHero();
  renderer.headPosition(heroPlant, heroTarget);

  bindInput();
  bindControls();
  initFlight();

  // Dev hook. Every check in tools/ runs offline; this is the one thing they
  // cannot give -- a handle on the live scene, so the lens and the panel's
  // state can be parked somewhere specific and the frame compared against the
  // last one.
  window.__app = {
    camera, state, bee, renderer, setFocalLength,
    look(o = {}) {
      if (o.focal !== undefined) setFocalLength(o.focal);
      if (o.f !== undefined) camera.fNumber = o.f;
      for (const k of ['wind', 'grassDensity', 'lodBias', 'sunElevation',
                       'bloom', 'debugView']) {
        if (o[k] !== undefined) state[k] = o[k];
      }
      return this;
    },
    /** Indices of every plant of a species, nearest the origin first. */
    ofSpecies(key) {
      const sp = renderer.species.findIndex((s) => s.key === key);
      return renderer.plants
        .map((p, i) => ({ i, p, d: Math.hypot(p.x, p.z) }))
        .filter((e) => e.p.species === sp)
        .sort((a, b) => a.d - b.d)
        .map((e) => e.i);
    },
  };
  document.getElementById('loading').hidden = true;

  // Readback diagnostics. Reported on screen as well as logged, so the numbers
  // can be relayed without needing devtools open.
  const diag = document.getElementById('diag');
  document.getElementById('diagnose').addEventListener('click', async () => {
    diag.textContent = 'reading…';
    try {
      const [hdr, stem] = await Promise.all([
        renderer.probeHDR(), renderer.probeStem(Math.max(0, heroPlant))]);
      const st = renderer.lod.stats;
      const counts = Object.entries(renderer.field.stats.counts)
        .map(([k, n]) => `${k} ${n}`).join('  ');
      const text =
        `hdr  min ${hdr.min.toExponential(2)}  max ${hdr.max.toExponential(2)}\n` +
        `     mean ${hdr.mean.toExponential(2)}  nan ${(hdr.nanFraction * 100).toFixed(1)}%\n` +
        `stem finite=${stem.finite}  (hero ${heroPlant})\n` +
        `     n0 ${JSON.stringify(stem.first.pos)}\n` +
        `     n15 ${JSON.stringify(stem.last.pos)}\n` +
        `     axis15 ${JSON.stringify(stem.last.axis)}\n` +
        `lod  tiers ${st.tiers.join('/')}  drawn ${st.visible}  culled ${st.culled}\n` +
        `     ${(renderer.triangles / 1000).toFixed(1)}k tris  sites ${renderer.sites.count}\n` +
        `field ${renderer.plantCount} plants over ` +
        `${renderer.field.stats.area.toFixed(1)}m2\n     ${counts}\n` +
        `cam  ${camera.position.map((v) => v.toFixed(3)).join(', ')}  focus=${camera.focusDistance.toFixed(3)}`;
      diag.textContent = text;
      console.log(text);
    } catch (e) {
      diag.textContent = `probe failed: ${e.message}`;
      console.error(e);
    }
  });

  const boostLabel = document.getElementById('boost');
  let lastBeeMode = bee.mode;
  // Settles the chase rig and the horizon roll across a land or take-off; see
  // CHASE_BLEND_TIME. `null` once whichever transition was running has
  // finished settling into the target values.
  let chaseBlend = null;
  let lastUp = bee.upVector(null);
  let lastChase = CHASE_FLY;
  let lastMark = MARK_RADIUS;
  // Eases toward 1 while crawling (wings folded against the body) and back to
  // 0 in flight (wings spread for the beat blur). A plain lerp rather than
  // another chaseBlend entry: nothing else about the camera rig cares when
  // this settles.
  let wingFold = 0;

  let last = performance.now();
  let frames = 0, fpsClock = last;

  // --- head-position trace ------------------------------------------------
  // `?trace=head` records the hero head's published position every frame and
  // dumps it through window.__headStats().
  //
  // Jitter you can see is a large frame-to-frame CHANGE in how far the head
  // moved, and there are two quite different ways to get one. The solver can
  // genuinely lurch -- which is what a raced constraint pass was doing, see
  // the bend loop in wind.wgsl. Or the head can be moving perfectly smoothly
  // while the CAMERA reads it from a table that does not advance every frame:
  // `sites` comes back from the GPU asynchronously, and measuring it is the
  // point of the readback counters here, because guessing "a couple of frames
  // late" turned out to understate it badly. Separating those two is what
  // this trace is for; `stepMm` is the motion as the camera sees it, and
  // `tableAdvancedOnPct` says how much of that is the readback rather than
  // the plant.
  //
  // Everything here is off unless asked for, and the array is capped so a long
  // session cannot grow without bound.
  const traceHead = new URLSearchParams(location.search).get('trace') === 'head';
  const headTrace = [];
  const headStats = () => {
    const s = headTrace.slice(60);
    if (s.length < 8) return 'not enough frames';
    const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
    const step = [];
    for (let i = 1; i < s.length; i++) {
      step.push(1000 * Math.hypot(s[i].x - s[i - 1].x, s[i].y - s[i - 1].y, s[i].z - s[i - 1].z));
    }
    const jerk = [];
    for (let i = 1; i < step.length; i++) jerk.push(Math.abs(step[i] - step[i - 1]));

    // How the published table actually advances. A frame on which it did not
    // advance is a frame the camera spent on a stale head; the frame that
    // finally lands then has to cover everything that happened in between,
    // and THAT is the jump. `held` is how long each stale run lasted.
    const held = [];
    const jumpMm = [];
    let run = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i].sitesFrame === s[i - 1].sitesFrame) { run++; continue; }
      held.push(run + 1);
      jumpMm.push(step[i - 1]);
      run = 0;
    }
    const r = renderer;
    return {
      frames: s.length,
      // Motion of the head as the CAMERA sees it, which is the published
      // table -- not the motion the solver actually produced.
      stepMm: { mean: +(step.reduce((a, b) => a + b, 0) / step.length).toFixed(3),
                p50: +q(step, 0.5).toFixed(3), p99: +q(step, 0.99).toFixed(3),
                max: +Math.max(...step).toFixed(3) },
      jerkMm: { p50: +q(jerk, 0.5).toFixed(3), p99: +q(jerk, 0.99).toFixed(3),
                max: +Math.max(...jerk).toFixed(3) },
      tableAdvancedOnPct: +(100 * held.length / s.length).toFixed(1),
      heldFrames: held.length ? { p50: q(held, 0.5), p99: q(held, 0.99), max: Math.max(...held) } : null,
      jumpOnAdvanceMm: jumpMm.length
        ? { p50: +q(jumpMm, 0.5).toFixed(2), max: +Math.max(...jumpMm).toFixed(2) } : null,
      readback: { copies: r.landingCopies, lands: r.landingLands, skips: r.landingSkips,
                  fails: r.landingFails, lastMapMs: +r.landingMapMs.toFixed(1) },
    };
  };
  if (traceHead) {
    window.__headTrace = headTrace;
    window.__headStats = headStats;
    window.__renderer = renderer;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    state.time += dt;

    renderer.lodBias = state.lodBias;
    renderer.grassDensity = state.grassDensity;

    // The site table arrives from the GPU a couple of frames late, which is
    // far below what is visible at the speed the flowers sway.
    const sites = renderer.sites;
    bee.update(dt, sites);
    const look = bee.viewForward();
    const crawling = bee.mode === 'crawl';
    const targetUp = bee.upVector(sites);
    const targetChase = crawling ? CHASE_CRAWL : CHASE_FLY;
    const targetMark = crawling ? 0 : MARK_RADIUS;

    if (bee.mode !== lastBeeMode) {
      lastBeeMode = bee.mode;
      // Start the settle from whatever the rig actually showed last frame,
      // not from the pre-transition target -- so a land or take-off that
      // interrupts an earlier settle still blends from where the view is,
      // rather than snapping back to resume the old one. See
      // CHASE_BLEND_TIME.
      chaseBlend = { t: 0, fromUp: lastUp, fromChase: lastChase, fromMark: lastMark };
      // Landing and taking off swap the lens: see CRAWL_FOCAL.
      setFocalLength(crawling ? CRAWL_FOCAL : FLY_FOCAL);
      boostLabel.textContent = crawling ? 'TAKE OFF' : 'LIFT';
      // The walk and the aim take the same keys but not the same values, so
      // re-read whatever is held down. Only the keys: a finger still on the
      // LIFT button is still asking, and take-off must not cancel it.
      refreshKeys();
    }

    let up = targetUp, chase = targetChase, mark = targetMark;
    if (chaseBlend) {
      chaseBlend.t += dt;
      const k = Math.min(1, chaseBlend.t / CHASE_BLEND_TIME);
      const eased = 1 - (1 - k) ** 3;
      up = normalize3(lerp3(chaseBlend.fromUp, targetUp, eased));
      chase = lerpChase(chaseBlend.fromChase, targetChase, eased);
      mark = chaseBlend.fromMark + (targetMark - chaseBlend.fromMark) * eased;
      if (k >= 1) chaseBlend = null;
    }
    lastUp = up; lastChase = chase; lastMark = mark;

    // Third person, and the rig runs along the ORBIT rather than along the
    // bee -- which is the whole point of separating them. The pointer swings
    // the camera round the bee; the bee walks or flies underneath it, and in
    // the air it is the orbit's own bearing that W then flies toward.
    camera.setChase(bee.position, look, up, chase);
    // Where the ground is, relative to the bee. Nothing else in the frame
    // answers that: the sun's shadow lies downwind and falls on whatever the
    // sun can see, not on what the bee is above.
    renderer.markRadius = mark;
    // The BODY faces where the bee is actually going, which is not where
    // the camera is looking and has not been since the two came apart --
    // plus a cosmetic bank/pitch off the g-force it's actually pulling and
    // a small constant fidget (see visualState), neither of which the
    // camera or the flight model ever sees.
    const vis = bee.visualState(sites);
    wingFold += (Number(crawling) - wingFold) * Math.min(1, dt * 6);
    renderer.setBee(vis.position, vis.forward, vis.up, 1, wingFold);
    // Whatever the bee is standing on stays at the finest tier however the
    // metric scores it -- it is a few millimetres from the lens.
    state.pinnedPlant = bee.plant;

    // The hero head's own position, tracked purely for `?trace=head` below.
    renderer.headPosition(heroPlant, heroTarget);
    if (traceHead && headTrace.length < 20000) {
      headTrace.push({
        frame: renderer.frameId, dt,
        x: heroTarget[0], y: heroTarget[1], z: heroTarget[2],
        sitesFrame: renderer.sitesFrame,
        age: renderer.frameId - renderer.sitesFrame,
      });
    }
    camera.update(canvas.width / canvas.height);
    renderer.render(camera, state, dt);

    // Hold the budget. The profiler's total is the GPU's own account of the
    // frame and is what the governor wants; where the device has no timestamps
    // it falls back to wall clock, which can only tell it to slow down.
    if (state.autoResolution) {
      const gpuMs = renderer.profiler.total();
      if (governor.update(gpuMs, dt) !== null) {
        state.renderScale = governor.scale;
        const el = document.getElementById('renderScale');
        const out = document.getElementById('renderScale-val');
        if (el) el.value = governor.scale;
        if (out) out.textContent = governor.scale.toFixed(2);
        resizeCanvas();
      }
    }

    frames++;
    if (now - fpsClock > 500) {
      const t = renderer.lod.stats.tiers;
      const gpu = renderer.profiler.report([
        ['sim', 'sim'], ['shadow', 'shadow'], ['main', 'main'],
        ['dof', 'dof'], ['bloom', 'bloom'], ['post', 'post'],
      ]);
      fpsEl.textContent =
        `${Math.round(frames * 1000 / (now - fpsClock))} fps  ${canvas.width}x${canvas.height}\n` +
        `lod ${t[0]}/${t[1]}/${t[2]} + ${t[3]} blobs of ${renderer.plantCount}  ` +
        `${(renderer.triangles / 1000).toFixed(0)}k tris  ` +
        `scale ${(state.autoResolution ? governor.scale : state.renderScale).toFixed(2)}` +
        (gpu ? `\n${gpu}` : '');
      frames = 0; fpsClock = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
