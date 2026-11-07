/* ==========================================================================
   Capture it. | script.js
   A tiny retro photo booth. Plain JavaScript, no libraries.

   How the file is organised:
     1. Settings (filters, frames, layouts)
     2. App state (one object that holds the whole session)
     3. Small helpers (toasts, confirm popup, screen switching)
     4. Cut-out heading letters
     5. Filters (real pixel edits on the captured photo)
     6. Camera (start / stop / errors)
     7. Countdown + capture + retake + continue
     8. Final composition (layouts, frames, caption, drawing)
     9. Compose screen (options, preview, download)
    10. Reset + start-up wiring
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   1. SETTINGS
   -------------------------------------------------------------------------- */

// Every photo is stored at this size (4:3). Keeping one size means no
// stretching or cropping later when we place photos into layouts.
const PHOTO_W = 1200;
const PHOTO_H = 900;
const MAX_CAPTION = 40;

// "css" is only used for the live camera preview. The saved photos use the
// real pixel filters in applyFilter() below.
const FILTERS = {
  warm:   { label: 'Warm Film',     css: 'f-warm'  },
  bw:     { label: 'Black & White', css: 'f-bw'    },
  faded:  { label: 'Faded Retro',   css: 'f-faded' },
  sepia:  { label: 'Sepia',         css: 'f-sepia' }
};

// pad = thickness of the frame around the photos (in export pixels).
// captionColor = text colour used on the frame, chosen to contrast with it.
const FRAMES = {
  burgundy: { label: 'Vintage Burgundy', color: '#400106', captionColor: '#D9B991', pad: 56 },
  film:     { label: 'Film Reel',        color: '#0D0C00', captionColor: '#F3E9D2', pad: 80 },
  black:    { label: 'Classic Black',    color: '#0D0C00', captionColor: '#F3E9D2', pad: 56 }
};

// "photos" = how many photos this layout needs.
const LAYOUTS = {
  polaroid: { label: 'Single Polaroid',   photos: 1 },
  strip3:   { label: '3-photo strip',     photos: 3 },
  strip4:   { label: '4-photo strip',     photos: 4 },
  grid:     { label: '4-photo grid',      photos: 4 }
};

const CAMERA_MESSAGES = {
  denied: {
    title: 'Camera access is blocked',
    text: 'Please allow camera access in your browser (look for the camera icon near the address bar), then press Retry camera.'
  },
  notfound: {
    title: 'No camera found',
    text: 'We could not find a camera. Plug one in or check your device settings, then press Retry camera.'
  },
  busy: {
    title: 'Camera is busy',
    text: 'Your camera might be in use by another app or browser tab. Close it, then press Retry camera.'
  },
  unsupported: {
    title: 'Camera not supported here',
    text: 'This browser cannot use the camera. Please try a recent version of Chrome, Edge, Firefox or Safari.'
  },
  insecure: {
    title: 'Camera needs a secure page',
    text: 'Browsers only allow camera access on HTTPS or on localhost. Please open this page through a local server (see the run instructions).'
  },
  unknown: {
    title: 'Something went wrong',
    text: 'The camera could not start. Please press Retry camera. If it keeps happening, reload the page.'
  }
};

/* --------------------------------------------------------------------------
   2. APP STATE
   -------------------------------------------------------------------------- */

const state = {
  screen: 'landing',      // landing | setup | booth | compose
  filter: null,           // 'warm' | 'bw' | 'faded' | 'sepia'
  count: 4,               // how many photos this session
  photos: [],             // approved photos (canvas elements, filter already applied)
  pending: null,          // the photo just taken, waiting for Retake / Continue

  // booth phase: idle | starting | live | countdown | review | saving | error
  phase: 'idle',
  stream: null,           // the active MediaStream (only ever one)
  cameraStarting: false,  // true while we wait for the camera, prevents double start
  sessionId: 0,           // bumped on every reset so late async results can be ignored
  countdownToken: 0,      // bumped to cancel a running countdown
  countdownTimer: null,
  streamPromise: null,    // set while we wait for the browser to give us the camera
  previewRaf: null,       // animation frame id for the live filter previews
  previewLast: 0,

  // compose screen
  layout: null,
  frame: 'burgundy',
  caption: '',
  renderQueued: false
};

// Handy shortcut + a place to keep references to page elements.
const $ = (id) => document.getElementById(id);
const els = {};

/* --------------------------------------------------------------------------
   3. SMALL HELPERS
   -------------------------------------------------------------------------- */

// Show one screen, hide the others.
function showScreen(name) {
  ['landing', 'setup', 'booth', 'compose'].forEach((s) => {
    $('screen-' + s).hidden = (s !== name);
  });
  state.screen = name;
  window.scrollTo(0, 0);

  // Move focus to the screen's heading so keyboard / screen-reader users land in the right place.
  const heading = $('screen-' + name).querySelector('h1, h2');
  if (heading) heading.focus({ preventScroll: true });
}

// Small notification at the bottom of the page.
function showToast(message, type) {
  const toast = document.createElement('div');
  toast.className = 'toast' + (type === 'error' ? ' error' : '');
  toast.textContent = message;
  els.toastRegion.innerHTML = '';          // only ever show one message at a time
  els.toastRegion.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// Inline message under a section (used for setup + compose problems).
function showInline(el, message) {
  el.textContent = message;
  el.hidden = false;
}
function hideInline(el) {
  el.hidden = true;
  el.textContent = '';
}

// Our own confirm popup. Returns a Promise that resolves to true / false.
function askConfirm(message, yesLabel, noLabel) {
  return new Promise((resolve) => {
    els.confirmText.textContent = message;
    els.confirmYes.textContent = yesLabel || 'Yes';
    els.confirmNo.textContent = noLabel || 'Cancel';
    els.confirmModal.hidden = false;
    els.confirmNo.focus();

    function finish(answer) {
      els.confirmModal.hidden = true;
      els.confirmYes.removeEventListener('click', onYes);
      els.confirmNo.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    }
    function onYes() { finish(true); }
    function onNo() { finish(false); }
    function onKey(e) { if (e.key === 'Escape') finish(false); }

    els.confirmYes.addEventListener('click', onYes);
    els.confirmNo.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
  });
}

/* --------------------------------------------------------------------------
   4. CUT-OUT HEADING LETTERS
   Splits a heading into letters and gives each one a different serif font,
   paper colour, tilt, size and slightly ragged edge.
   -------------------------------------------------------------------------- */

// A tiny repeatable random number generator, so the heading looks the same on every load.
function makeRandom(seed) {
  let s = seed % 233280;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildCutout(el) {
  const text = el.dataset.text || el.textContent.trim();
  const rand = makeRandom(text.split('').reduce((sum, c) => sum + c.charCodeAt(0) * 7, 13));
  const VARIANTS = 6;
  let previous = -1;

  el.setAttribute('aria-label', text);
  el.textContent = '';

  text.split(' ').forEach((word) => {
    const wordEl = document.createElement('span');
    wordEl.className = 'word';
    wordEl.setAttribute('aria-hidden', 'true');

    word.split('').forEach((letter) => {
      // pick a style that is different from the previous letter
      const variant = (previous + 1 + Math.floor(rand() * (VARIANTS - 1))) % VARIANTS;
      previous = variant;

      const tilt = (rand() * 8 - 4).toFixed(1);        // -4deg .. 4deg
      const lift = (rand() * 0.14 - 0.07).toFixed(2);  // small up/down shift in em
      const size = (0.9 + rand() * 0.22).toFixed(2);   // 0.9em .. 1.12em
      const edge = () => (rand() * 5).toFixed(1);       // ragged paper edge, 0-5%

      const ch = document.createElement('span');
      ch.className = 'ch v' + variant;
      ch.textContent = letter;
      ch.style.fontSize = size + 'em';
      ch.style.transform = 'translateY(' + lift + 'em) rotate(' + tilt + 'deg)';
      ch.style.clipPath =
        'polygon(' + edge() + '% ' + edge() + '%, ' + (100 - edge()) + '% ' + edge() + '%, ' +
        (100 - edge()) + '% ' + (100 - edge()) + '%, ' + edge() + '% ' + (100 - edge()) + '%)';
      wordEl.appendChild(ch);
    });

    el.appendChild(wordEl);
  });
}

/* --------------------------------------------------------------------------
   5. FILTERS
   These change the real pixels of a canvas, so the filter is baked into the
   saved photo and into the downloaded PNG.
   -------------------------------------------------------------------------- */

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function applyFilter(canvas, filterId) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  // For the soft vignette on Warm Film: distance from the centre.
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    if (filterId === 'warm') {
      // warm tint, slightly lifted blacks, gentle vignette
      r = r * 1.08 + 10;
      g = g * 1.01 + 4;
      b = b * 0.84;
      r = r * 0.93 + 12;
      g = g * 0.93 + 10;
      b = b * 0.93 + 8;
      const p = (i / 4) % w;
      const q = Math.floor(i / 4 / w);
      const dist = Math.sqrt((p - cx) * (p - cx) + (q - cy) * (q - cy)) / maxDist;
      const vignette = 1 - 0.22 * dist * dist;
      r *= vignette; g *= vignette; b *= vignette;

    } else if (filterId === 'bw') {
      // classic monochrome with a little extra contrast
      const v = (luma - 128) * 1.15 + 128;
      r = g = b = v;

    } else if (filterId === 'faded') {
      // pull colour out, lift the blacks, tiny warm cast
      r = luma + (r - luma) * 0.6;
      g = luma + (g - luma) * 0.6;
      b = luma + (b - luma) * 0.6;
      r = r * 0.80 + 40;
      g = g * 0.80 + 38;
      b = b * 0.80 + 34;

    } else if (filterId === 'sepia') {
      // the classic sepia matrix
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = (sr - 128) * 1.05 + 128;
      g = (sg - 128) * 1.05 + 128;
      b = (sb - 128) * 1.05 + 128;
    }

    d[i] = clamp(r);
    d[i + 1] = clamp(g);
    d[i + 2] = clamp(b);
  }

  ctx.putImageData(image, 0, 0);
}

// Little painted scene used for the filter samples on the setup screen.
// (It is only a swatch to show what a filter does. It is never used as a photo.)
function drawSampleScene(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#6FA8D0');
  sky.addColorStop(1, '#F3E2BE');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#F2C14E';
  ctx.beginPath(); ctx.arc(w * 0.78, h * 0.28, h * 0.14, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#5E9362';
  ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, h * 0.62);
  ctx.quadraticCurveTo(w * 0.3, h * 0.4, w * 0.6, h * 0.66);
  ctx.quadraticCurveTo(w * 0.8, h * 0.78, w, h * 0.6); ctx.lineTo(w, h); ctx.fill();

  ctx.fillStyle = '#3F6B46';
  ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, h * 0.82);
  ctx.quadraticCurveTo(w * 0.4, h * 0.62, w, h * 0.86); ctx.lineTo(w, h); ctx.fill();

  ctx.fillStyle = '#B5483A';
  ctx.fillRect(w * 0.2, h * 0.58, w * 0.22, h * 0.2);
  ctx.fillStyle = '#6B3A2A';
  ctx.beginPath(); ctx.moveTo(w * 0.17, h * 0.58); ctx.lineTo(w * 0.31, h * 0.44); ctx.lineTo(w * 0.45, h * 0.58); ctx.fill();
  ctx.fillStyle = '#F5E6B8';
  ctx.fillRect(w * 0.28, h * 0.65, w * 0.07, h * 0.08);
}

function drawFilterSamples() {
  document.querySelectorAll('.filter-card').forEach((card) => {
    const canvas = card.querySelector('canvas');
    drawSampleScene(canvas);
    applyFilter(canvas, card.dataset.filter);
  });
}

/* --------------------------------------------------------------------------
   6. CAMERA
   -------------------------------------------------------------------------- */

// Work out which friendly message matches a getUserMedia error.
function classifyCameraError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'notfound';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'unknown';
}

function showCameraError(kind) {
  const message = CAMERA_MESSAGES[kind] || CAMERA_MESSAGES.unknown;
  els.cameraErrorTitle.textContent = message.title;
  els.cameraErrorText.textContent = message.text;
  // Retrying will not help if the browser simply cannot do it.
  els.btnRetryCamera.hidden = (kind === 'unsupported' || kind === 'insecure');
  setPhase('error');
}

// Returns a reason string if this page cannot use the camera at all, otherwise null.
function cameraBlockedReason() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return window.isSecureContext === false ? 'insecure' : 'unsupported';
  }
  if (window.isSecureContext === false) return 'insecure';
  return null;
}

// Stop every track so the camera light goes off.
function stopCamera() {
  stopPreviewLoop();
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
  els.setupVideo.srcObject = null;
}

// Ask the browser for the camera. There is only ever ONE stream: if we already
// have a live one it is reused (setup screen and booth screen share it).
function acquireStream() {
  if (state.stream && state.stream.active) return Promise.resolve(state.stream);
  if (state.streamPromise) return state.streamPromise;   // already asking, don't ask twice

  state.streamPromise = (async () => {
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
          audio: false
        });
      } catch (firstError) {
        // Some cameras reject our preferred settings. Try again with anything.
        if (firstError && (firstError.name === 'OverconstrainedError' || firstError.name === 'ConstraintNotSatisfiedError')) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else {
          throw firstError;
        }
      }
      state.stream = stream;
      return stream;
    } finally {
      state.streamPromise = null;
    }
  })();

  return state.streamPromise;
}

// Draw the current video frame onto a canvas: centre-cropped to the canvas shape
// (same as the object-fit: cover preview) and flipped to match the mirrored preview.
function drawVideoToCanvas(video, canvas) {
  const targetRatio = canvas.width / canvas.height;
  const videoRatio = video.videoWidth / video.videoHeight;
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
  if (videoRatio > targetRatio) {
    sw = video.videoHeight * targetRatio;
    sx = (video.videoWidth - sw) / 2;
  } else {
    sh = video.videoWidth / targetRatio;
    sy = (video.videoHeight - sh) / 2;
  }

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/* ---- Setup screen: live filter previews ---- */

// Go to the setup screen and start the camera so people can see themselves in each filter.
function enterSetup() {
  drawFilterSamples();          // placeholder swatches until the first camera frame arrives
  hideInline(els.setupMessage);
  els.setupCameraStatus.hidden = true;
  showScreen('setup');
  startSetupPreview();
}

async function startSetupPreview() {
  els.setupCameraStatus.hidden = true;

  const blocked = cameraBlockedReason();
  if (blocked) {
    showSetupCameraProblem(blocked);
    return;
  }

  try {
    const stream = await acquireStream();
    if (state.screen !== 'setup') {
      // The person moved on while the permission popup was open.
      if (state.screen !== 'booth') stopCamera();
      return;
    }
    els.setupVideo.srcObject = stream;
    await els.setupVideo.play();
    startPreviewLoop();
  } catch (err) {
    stopCamera();
    if (state.screen === 'setup') showSetupCameraProblem(classifyCameraError(err));
  }
}

function showSetupCameraProblem(kind) {
  const message = CAMERA_MESSAGES[kind] || CAMERA_MESSAGES.unknown;
  els.setupCameraText.textContent = message.title + '. ' + message.text;
  els.btnSetupRetry.hidden = (kind === 'unsupported' || kind === 'insecure');
  els.setupCameraStatus.hidden = false;
}

// Redraw the four filter cards from the camera about 15 times a second.
function startPreviewLoop() {
  stopPreviewLoop();
  function tick(now) {
    if (state.screen !== 'setup') { state.previewRaf = null; return; }
    if (now - state.previewLast >= 66) {
      state.previewLast = now;
      drawPreviewFrame();
    }
    state.previewRaf = requestAnimationFrame(tick);
  }
  state.previewRaf = requestAnimationFrame(tick);
}

function stopPreviewLoop() {
  if (state.previewRaf) {
    cancelAnimationFrame(state.previewRaf);
    state.previewRaf = null;
  }
}

function drawPreviewFrame() {
  const video = els.setupVideo;
  if (!video.videoWidth) return;
  document.querySelectorAll('.filter-card').forEach((card) => {
    const canvas = card.querySelector('canvas');
    drawVideoToCanvas(video, canvas);
    applyFilter(canvas, card.dataset.filter);   // the same real filter used for the saved photos
  });
}

/* ---- Booth screen: camera ---- */

// Show the live camera in the booth (reusing the stream from the setup screen if we have it).
async function startCamera() {
  if (state.cameraStarting) return;          // never start two streams at once

  const blocked = cameraBlockedReason();
  if (blocked) {
    showCameraError(blocked);
    return;
  }

  state.cameraStarting = true;
  const sessionAtStart = state.sessionId;
  setPhase('starting');

  try {
    const stream = await acquireStream();

    // The person may have left the booth while the permission popup was open.
    if (sessionAtStart !== state.sessionId || state.screen !== 'booth') {
      if (state.screen !== 'setup' && state.screen !== 'booth') stopCamera();
      return;
    }

    els.video.srcObject = stream;
    await els.video.play();
    setPhase('live');
  } catch (err) {
    stopCamera();
    if (sessionAtStart === state.sessionId && state.screen === 'booth') {
      showCameraError(classifyCameraError(err));
    }
  } finally {
    state.cameraStarting = false;
  }
}

/* --------------------------------------------------------------------------
   7. BOOTH: PHASES, COUNTDOWN, CAPTURE, RETAKE, CONTINUE
   -------------------------------------------------------------------------- */

// Change the booth phase and update which buttons / views are visible.
function setPhase(phase) {
  state.phase = phase;

  const showError = (phase === 'error');
  const inReview = (phase === 'review' || phase === 'saving');

  els.stage.hidden = showError;
  els.cameraError.hidden = !showError;
  els.boothControls.hidden = showError;

  els.video.classList.toggle('is-hidden', inReview);
  els.reviewCanvas.hidden = !inReview;

  els.btnTake.hidden = inReview;
  els.btnTake.disabled = (phase !== 'live');
  if (phase === 'starting') els.btnTake.textContent = 'Starting camera...';
  else if (phase === 'countdown') els.btnTake.textContent = 'Get ready...';
  else els.btnTake.textContent = 'Take photo';

  els.reviewActions.hidden = !inReview;
  els.btnRetake.disabled = (phase !== 'review');
  els.btnContinue.disabled = (phase !== 'review');
}

// "Photo 2 of 4" + dots
function updateProgress() {
  const total = state.count;
  const current = Math.min(state.photos.length + 1, total);
  els.progressText.textContent = 'Photo ' + current + ' of ' + total;

  els.progressDots.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i < state.photos.length ? ' done' : (i === state.photos.length ? ' current' : ''));
    els.progressDots.appendChild(dot);
  }

  updateStrip();
}

// Build the empty photo strip: one slot per photo for this session.
function buildStrip() {
  els.photoStrip.innerHTML = '';
  for (let i = 0; i < state.count; i++) {
    const slot = document.createElement('div');
    slot.className = 'strip-slot';

    const number = document.createElement('span');
    number.className = 'slot-num';
    number.textContent = String(i + 1);

    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 180;

    slot.appendChild(number);
    slot.appendChild(canvas);
    els.photoStrip.appendChild(slot);
  }
}

// Fill the slots: approved photos, plus the photo currently being reviewed.
function updateStrip() {
  const slots = els.photoStrip.children;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const canvas = slot.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const photo = state.photos[i] || (i === state.photos.length ? state.pending : null);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (photo) ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);

    slot.classList.toggle('filled', Boolean(photo));
    slot.classList.toggle('pending', Boolean(photo) && photo === state.pending);
    slot.classList.toggle('current', !photo && i === state.photos.length);
  }
}

function showCountdownNumber(n) {
  els.countdown.textContent = String(n);
  els.countdown.hidden = false;
  els.countdown.classList.remove('pop');
  void els.countdown.offsetWidth;            // restart the CSS animation
  els.countdown.classList.add('pop');
}

function hideCountdown() {
  els.countdown.hidden = true;
  els.countdown.textContent = '';
  els.countdown.classList.remove('pop');
}

// Stop a countdown that is running (used when leaving the booth).
function cancelCountdown() {
  state.countdownToken++;
  clearTimeout(state.countdownTimer);
  state.countdownTimer = null;
  hideCountdown();
}

// 3 -> 2 -> 1 -> capture
function startCountdown() {
  if (state.phase !== 'live') return;        // ignores double clicks
  setPhase('countdown');

  const token = ++state.countdownToken;
  let n = 3;

  function tick() {
    if (token !== state.countdownToken) return;   // cancelled
    if (n > 0) {
      showCountdownNumber(n);
      n--;
      state.countdownTimer = setTimeout(tick, 1000);
    } else {
      hideCountdown();
      capturePhoto();
    }
  }
  tick();
}

// Grab the current video frame, crop it to 4:3, mirror it to match the preview, apply the filter.
function capturePhoto() {
  if (state.screen !== 'booth') return;

  try {
    const video = els.video;
    if (!video.videoWidth || !video.videoHeight) throw new Error('Video not ready');

    const photo = document.createElement('canvas');
    photo.width = PHOTO_W;
    photo.height = PHOTO_H;
    drawVideoToCanvas(video, photo);      // cropped to 4:3 and mirrored like the preview

    applyFilter(photo, state.filter);

    // Show the filtered photo for review.
    els.reviewCanvas.width = PHOTO_W;
    els.reviewCanvas.height = PHOTO_H;
    els.reviewCanvas.getContext('2d').drawImage(photo, 0, 0);

    state.pending = photo;
    updateProgress();                       // shows the new photo in the strip

    els.flash.classList.remove('go');
    void els.flash.offsetWidth;
    els.flash.classList.add('go');

    setPhase('review');
  } catch (err) {
    state.pending = null;
    showToast('Sorry, that photo did not work. Please try again.', 'error');
    setPhase('live');
  }
}

// Throw away the current photo and go back to the live camera. Approved photos stay.
function retakePhoto() {
  if (state.phase !== 'review') return;
  state.pending = null;
  updateProgress();                         // empties that strip slot again
  setPhase('live');
}

// Keep the current photo and move on.
function approvePhoto() {
  if (state.phase !== 'review' || !state.pending) return;   // no photo, no continue
  setPhase('saving');                                       // blocks repeat clicks

  state.photos.push(state.pending);
  state.pending = null;
  updateProgress();

  if (state.photos.length >= state.count) {
    stopCamera();
    enterCompose();
  } else {
    setPhase('live');
  }
}

async function leaveBooth() {
  if (state.photos.length > 0 || state.pending) {
    const ok = await askConfirm('Leave the booth? The photos you have taken so far will be cleared.', 'Yes, leave', 'Stay');
    if (!ok) return;
  }
  endBoothSession();
  enterSetup();
}

// Stop everything the booth was doing and forget its photos.
function endBoothSession() {
  state.sessionId++;
  cancelCountdown();
  stopCamera();
  state.photos = [];
  state.pending = null;
  state.phase = 'idle';
}

/* --------------------------------------------------------------------------
   SETUP SCREEN
   -------------------------------------------------------------------------- */

function selectFilter(id) {
  state.filter = id;
  document.querySelectorAll('.filter-card').forEach((card) => {
    card.setAttribute('aria-pressed', String(card.dataset.filter === id));
  });
  hideInline(els.setupMessage);
}

function selectCount(n) {
  state.count = n;
  document.querySelectorAll('#count-options .pill').forEach((pill) => {
    const on = Number(pill.dataset.count) === n;
    pill.setAttribute('aria-pressed', String(on));
    pill.classList.toggle('is-selected', on);
  });
}

function startSession() {
  if (!state.filter) {
    showInline(els.setupMessage, 'Please pick a filter first.');
    $('filter-options').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  state.photos = [];
  state.pending = null;
  state.sessionId++;

  // Lock in the filter for the booth screen.
  els.filterBadge.textContent = 'Filter: ' + FILTERS[state.filter].label + ' (locked)';
  els.video.className = FILTERS[state.filter].css;

  buildStrip();
  showScreen('booth');
  updateProgress();
  startCamera();
}

/* --------------------------------------------------------------------------
   8. FINAL COMPOSITION
   One function draws everything (layout + frame + caption). The preview and
   the download both use it, so they always match.
   -------------------------------------------------------------------------- */

// Work out the canvas size and where each photo goes.
function getGeometry(layoutId, frameId, hasCaption) {
  const pad = FRAMES[frameId].pad;
  const gap = 28;
  const captionBand = hasCaption ? 130 : 0;

  if (layoutId === 'polaroid') {
    const cardPad = 44, pw = 720, ph = 540, cardBottom = 190;
    const cardW = pw + cardPad * 2;
    const cardH = cardPad + ph + cardBottom;
    return {
      width: cardW + pad * 2,
      height: cardH + pad * 2,
      photos: [{ x: pad + cardPad, y: pad + cardPad, w: pw, h: ph }],
      card: { x: pad, y: pad, w: cardW, h: cardH },
      captionOnCard: true,
      captionX: pad + cardW / 2,
      captionY: pad + cardPad + ph + cardBottom / 2,
      captionMaxWidth: cardW - 80
    };
  }

  if (layoutId === 'grid') {
    const pw = 560, ph = 420;
    const contentBottom = pad + ph * 2 + gap;
    const width = pad * 2 + pw * 2 + gap;
    return {
      width: width,
      height: contentBottom + (hasCaption ? captionBand : pad),
      photos: [
        { x: pad, y: pad, w: pw, h: ph },
        { x: pad + pw + gap, y: pad, w: pw, h: ph },
        { x: pad, y: pad + ph + gap, w: pw, h: ph },
        { x: pad + pw + gap, y: pad + ph + gap, w: pw, h: ph }
      ],
      captionOnCard: false,
      captionX: width / 2,
      captionY: contentBottom + captionBand / 2,
      captionMaxWidth: width - pad * 2
    };
  }

  // strip3 / strip4: photos stacked vertically
  const count = (layoutId === 'strip3') ? 3 : 4;
  const pw = 640, ph = 480;
  const contentBottom = pad + count * ph + (count - 1) * gap;
  const width = pad * 2 + pw;
  const photos = [];
  for (let i = 0; i < count; i++) {
    photos.push({ x: pad, y: pad + i * (ph + gap), w: pw, h: ph });
  }
  return {
    width: width,
    height: contentBottom + (hasCaption ? captionBand : pad),
    photos: photos,
    captionOnCard: false,
    captionX: width / 2,
    captionY: contentBottom + captionBand / 2,
    captionMaxWidth: width - pad * 2
  };
}

// Frame: background colour plus any decoration.
function drawFrame(ctx, g, frameId) {
  const frame = FRAMES[frameId];
  ctx.fillStyle = frame.color;
  ctx.fillRect(0, 0, g.width, g.height);

  if (frameId === 'burgundy') {
    // thin tan keyline inside the edge
    ctx.strokeStyle = 'rgba(217, 185, 145, 0.85)';
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, g.width - 36, g.height - 36);
  }

  if (frameId === 'film') {
    // sprocket holes down both sides, evenly spaced and centred
    const holeW = 26, holeH = 38, pitch = 66;
    const count = Math.floor((g.height - 60) / pitch);
    const startY = (g.height - count * pitch) / 2 + (pitch - holeH) / 2;
    const leftX = frame.pad / 2 - holeW / 2;
    const rightX = g.width - frame.pad / 2 - holeW / 2;
    ctx.fillStyle = '#D9B991';
    for (let i = 0; i < count; i++) {
      const y = startY + i * pitch;
      roundRect(ctx, leftX, y, holeW, holeH, 6);
      roundRect(ctx, rightX, y, holeW, holeH, 6);
    }
  }
}

// A small rounded rectangle (filled with the current fillStyle).
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

// Caption: shrinks the text if it would be too wide.
function drawCaption(ctx, g, frameId, text) {
  if (!text) return;
  const frame = FRAMES[frameId];
  let size = g.captionOnCard ? 52 : 46;
  const fontFor = (px) => px + 'px "Special Elite", "Courier New", monospace';

  ctx.font = fontFor(size);
  while (ctx.measureText(text).width > g.captionMaxWidth && size > 18) {
    size -= 2;
    ctx.font = fontFor(size);
  }

  // On a polaroid the caption sits on the cream card, so it uses the frame colour as ink.
  ctx.fillStyle = g.captionOnCard ? frame.color : frame.captionColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, g.captionX, g.captionY);
}

// Draw the whole composition onto a canvas. scale < 1 makes small thumbnails.
function renderComposition(canvas, options, scale) {
  const s = scale || 1;
  const caption = (options.caption || '').trim();
  const g = getGeometry(options.layout, options.frame, caption.length > 0);

  canvas.width = Math.round(g.width * s);
  canvas.height = Math.round(g.height * s);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  drawFrame(ctx, g, options.frame);

  // Polaroid card behind the photo
  if (g.card) {
    ctx.fillStyle = '#F5EEDC';
    ctx.fillRect(g.card.x, g.card.y, g.card.w, g.card.h);
  }

  // Photos
  g.photos.forEach((rect, i) => {
    const photo = options.photos[i];
    if (!photo) return;
    ctx.drawImage(photo, rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = g.card ? 'rgba(13, 12, 0, 0.25)' : 'rgba(217, 185, 145, 0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  });

  drawCaption(ctx, g, options.frame, caption);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* --------------------------------------------------------------------------
   9. COMPOSE SCREEN
   -------------------------------------------------------------------------- */

function currentOptions(includeCaption) {
  return {
    layout: state.layout,
    frame: state.frame,
    caption: includeCaption === false ? '' : state.caption,
    photos: state.photos
  };
}

// Build the layout + frame option buttons (each with a real mini preview).
function buildOptionButtons() {
  els.layoutOptions.innerHTML = '';
  els.frameOptions.innerHTML = '';

  Object.keys(LAYOUTS)
    .filter((id) => LAYOUTS[id].photos === state.photos.length)   // only compatible layouts
    .forEach((id) => {
      els.layoutOptions.appendChild(makeThumbButton('layout', id, LAYOUTS[id].label));
    });

  Object.keys(FRAMES).forEach((id) => {
    els.frameOptions.appendChild(makeThumbButton('frame', id, FRAMES[id].label));
  });
}

function makeThumbButton(kind, id, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-btn';
  btn.dataset.kind = kind;
  btn.dataset.id = id;
  btn.setAttribute('aria-pressed', 'false');

  const wrap = document.createElement('span');
  wrap.className = 'thumb-canvas-wrap';
  wrap.appendChild(document.createElement('canvas'));

  const text = document.createElement('span');
  text.textContent = label;

  btn.appendChild(wrap);
  btn.appendChild(text);
  return btn;
}

// Redraw the little previews and highlight the chosen ones.
function renderOptionThumbs() {
  document.querySelectorAll('.thumb-btn').forEach((btn) => {
    const kind = btn.dataset.kind;
    const id = btn.dataset.id;
    const opts = currentOptions(false);
    if (kind === 'layout') opts.layout = id; else opts.frame = id;

    const g = getGeometry(opts.layout, opts.frame, false);
    const scale = Math.min(112 / g.width, 150 / g.height);
    renderComposition(btn.querySelector('canvas'), opts, scale);

    const selected = (kind === 'layout') ? (id === state.layout) : (id === state.frame);
    btn.setAttribute('aria-pressed', String(selected));
  });
}

// Redraw the big preview (batched so typing stays smooth).
function renderPreview() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    if (state.screen !== 'compose') return;
    renderComposition(els.finalCanvas, currentOptions(true), 1);
    const caption = state.caption.trim();
    els.finalCanvas.setAttribute('aria-label',
      'Preview: ' + LAYOUTS[state.layout].label + ', ' + FRAMES[state.frame].label + ' frame, ' +
      FILTERS[state.filter].label + ' filter' + (caption ? ', caption: ' + caption : ''));
  });
}

function enterCompose() {
  const compatible = Object.keys(LAYOUTS).filter((id) => LAYOUTS[id].photos === state.photos.length);
  state.layout = compatible[0];
  state.frame = 'burgundy';
  state.caption = '';
  els.captionInput.value = '';
  updateCaptionCount();
  hideInline(els.composeMessage);

  els.filterNote.textContent = 'Filter: ' + FILTERS[state.filter].label;

  buildOptionButtons();
  showScreen('compose');
  renderOptionThumbs();
  renderPreview();
}

function updateCaptionCount() {
  els.captionCount.textContent = els.captionInput.value.length + ' / ' + MAX_CAPTION;
}

function onOptionClick(event) {
  const btn = event.target.closest('.thumb-btn');
  if (!btn) return;
  if (btn.dataset.kind === 'layout') state.layout = btn.dataset.id;
  else state.frame = btn.dataset.id;
  renderOptionThumbs();
  renderPreview();
}

function onCaptionInput() {
  state.caption = els.captionInput.value.slice(0, MAX_CAPTION);
  updateCaptionCount();
  renderPreview();
}

// Export the finished composition as a PNG file.
async function downloadPhoto() {
  hideInline(els.composeMessage);
  els.btnDownload.disabled = true;

  try {
    // Make sure the caption font is ready so it appears in the file.
    if (document.fonts && document.fonts.load) {
      try { await document.fonts.load('40px "Special Elite"'); } catch (e) { /* fall back to Courier */ }
    }

    const exportCanvas = document.createElement('canvas');
    renderComposition(exportCanvas, currentOptions(true), 1);

    const blob = await new Promise((resolve) => exportCanvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No image data');

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'capture-it-photo.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    showToast('Saved as capture-it-photo.png');
  } catch (err) {
    showInline(els.composeMessage, 'Sorry, we could not create your image. Please try again.');
  } finally {
    els.btnDownload.disabled = false;
  }
}

async function startAgain() {
  if (state.photos.length > 0) {
    const ok = await askConfirm(
      'Start again? Your current photos will be cleared. Download your photo first if you want to keep it.',
      'Yes, start again',
      'Keep it'
    );
    if (!ok) return;
  }
  resetSession();
}

/* --------------------------------------------------------------------------
   10. RESET + START-UP
   -------------------------------------------------------------------------- */

function resetSession() {
  endBoothSession();
  state.filter = null;
  state.layout = null;
  state.frame = 'burgundy';
  state.caption = '';
  els.captionInput.value = '';
  selectFilter(null);
  selectCount(4);
  hideInline(els.setupMessage);
  hideInline(els.composeMessage);
  showScreen('landing');
}

function init() {
  // Grab elements once.
  [
    'toast-region', 'confirm-modal', 'confirm-text', 'confirm-yes', 'confirm-no',
    'setup-message', 'camera-video', 'review-canvas', 'stage', 'countdown', 'flash',
    'camera-error', 'camera-error-title', 'camera-error-text', 'btn-retry-camera',
    'booth-controls', 'btn-take', 'review-actions', 'btn-retake', 'btn-continue',
    'progress-text', 'progress-dots', 'filter-badge',
    'final-canvas', 'filter-note', 'layout-options', 'frame-options',
    'caption-input', 'caption-count', 'compose-message', 'btn-download',
    'setup-video', 'setup-camera-status', 'setup-camera-text', 'btn-setup-retry', 'photo-strip'
  ].forEach((id) => {
    // "camera-video" -> els.cameraVideo
    const key = id.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    els[key] = $(id);
  });
  els.video = els.cameraVideo;

  // Decorative lettering and filter samples.
  document.querySelectorAll('.cutout').forEach(buildCutout);
  drawFilterSamples();

  // Landing + setup
  $('btn-start-photobooth').addEventListener('click', enterSetup);
  $('btn-setup-back').addEventListener('click', () => {
    stopCamera();                 // leaving setup: release the camera
    showScreen('landing');
  });
  els.btnSetupRetry.addEventListener('click', startSetupPreview);
  document.querySelectorAll('.filter-card').forEach((card) => {
    card.addEventListener('click', () => selectFilter(card.dataset.filter));
  });
  document.querySelectorAll('#count-options .pill').forEach((pill) => {
    pill.addEventListener('click', () => selectCount(Number(pill.dataset.count)));
  });
  $('btn-start-session').addEventListener('click', startSession);

  // Booth
  els.btnTake.addEventListener('click', startCountdown);
  els.btnRetake.addEventListener('click', retakePhoto);
  els.btnContinue.addEventListener('click', approvePhoto);
  $('btn-booth-exit').addEventListener('click', leaveBooth);
  $('btn-error-back').addEventListener('click', leaveBooth);
  els.btnRetryCamera.addEventListener('click', startCamera);

  // Compose
  els.layoutOptions.addEventListener('click', onOptionClick);
  els.frameOptions.addEventListener('click', onOptionClick);
  els.captionInput.addEventListener('input', onCaptionInput);
  els.btnDownload.addEventListener('click', downloadPhoto);
  $('btn-start-again').addEventListener('click', startAgain);

  // Safety: if the tab is closed or navigated away, release the camera.
  window.addEventListener('pagehide', stopCamera);

  // Redraw once the caption font has loaded so the preview uses it.
  if (document.fonts && document.fonts.load) {
    document.fonts.load('40px "Special Elite"').then(renderPreview).catch(() => {});
  }

  selectCount(4);
  showScreen('landing');
}

document.addEventListener('DOMContentLoaded', init);
