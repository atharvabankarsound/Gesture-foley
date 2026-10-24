import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { Hand, SLOTS, TIP } from "./gestures.js";
import { A, LIB, createAudio, initAudio, makeCtx, setSpace, setVolume } from "./sounds.js";
import * as Samples from "./samples.js";

const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = { left: css("--left"), right: css("--right"), accent: css("--accent") };

/* -------------------------------------------------------------- folders */

const CATS = {
  footsteps: { name: "Footsteps", slots: { index: "Step", middle: "Scuff", ring: "Squeak", pinky: "Stomp" }, alias: ["footsteps", "footstep", "steps", "feet"] },
  cinematic: { name: "Cinematic", slots: { index: "Hit", middle: "Braam", ring: "Riser", pinky: "Boom" }, alias: ["cinematic", "cinematics", "trailer", "impacts"] },
  guns: { name: "Guns", slots: { index: "Shot", middle: "Reload", ring: "Shell drop", pinky: "Burst" }, alias: ["guns", "gun", "weapons", "firearms"] },
  cloth: { name: "Cloth", slots: { index: "Grab", middle: "Snap", ring: "Zip", pinky: "Body fall" }, alias: ["cloth", "clothes", "clothing", "fabric", "rustle"] },
  movement: { name: "Movement", slots: { index: "Whoosh", middle: "Long whoosh", ring: "Punch", pinky: "Body hit" }, alias: ["movement", "movements", "whooshes", "whoosh"] },
};
const CAT_KEYS = Object.keys(CATS);
const FINGER = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky" };
const SLOT_ALIAS = { index: ["index", "1", "first"], middle: ["middle", "2", "second"], ring: ["ring", "3", "third"], pinky: ["pinky", "little", "4", "fourth"] };
const SYNTH_KEY = { index: "a", middle: "b", ring: "c", pinky: "fist" };   // placeholder sounds in sounds.js

const KNOBS = [
  { k: "variation", label: "Variation", def: 0.4, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "dynamics", label: "Dynamics", def: 0.7, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "reverb", label: "Reverb", def: 0.15, fmt: (v) => Math.round(v * 100) + "%" },
];

const state = {
  cat: "footsteps",
  touch: 0.22,
  volume: 0.8,
  knobs: Object.fromEntries(KNOBS.map((m) => [m.k, m.def])),
};

/* --------------------------------------------------------------- render */

const FOLDER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.5"/></svg>';

function renderFolders() {
  const box = $("cats");
  box.innerHTML = "";
  CAT_KEYS.forEach((ck, i) => {
    const n = SLOTS.reduce((a, s) => a + Samples.count(ck, s), 0);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat-btn";
    b.setAttribute("aria-pressed", String(ck === state.cat));
    b.innerHTML = `${FOLDER_SVG}<span>${CATS[ck].name}</span><span class="count${n ? " has" : ""}">${n ? n + (n === 1 ? " sample" : " samples") : "synth"}</span>`;
    b.addEventListener("click", () => selectCategory(ck));
    box.appendChild(b);
  });
}

function selectCategory(ck) {
  state.cat = ck;
  $("stageCat").textContent = CATS[ck].name;
  setSpace(state.knobs.reverb, state.cat);
  renderFolders();
  renderSlots();
}

const slotEls = {};
function buildSlots() {
  const box = $("slots");
  SLOTS.forEach((slot, i) => {
    const el = document.createElement("div");
    el.className = "slot";
    el.innerHTML = `
      <span class="lamps" aria-hidden="true"><i></i><i></i></span>
      <span class="finger"><b>${i + 1}</b>Thumb + ${FINGER[slot]}</span>
      <span class="snd"></span>
      <span class="src"></span>
      <span class="acts">
        <button type="button" class="mini primary" data-act="add">Add samples</button>
        <button type="button" class="mini" data-act="test">Play</button>
        <button type="button" class="mini" data-act="clear">Clear</button>
      </span>
      <input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.flac,.ogg,.m4a" multiple hidden>`;
    const input = el.querySelector("input");
    el.querySelector('[data-act="add"]').addEventListener("click", () => input.click());
    el.querySelector('[data-act="test"]').addEventListener("click", async () => { await initAudio(state.volume); trigger(slot, "center", 0.8); });
    el.querySelector('[data-act="clear"]').addEventListener("click", async () => {
      await Samples.clearSlot(state.cat, slot);
      note(`Cleared ${CATS[state.cat].name} · ${CATS[state.cat].slots[slot]}.`);
      renderFolders(); renderSlots();
    });
    input.addEventListener("change", async () => { await addToSlot(slot, [...input.files]); input.value = ""; });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drag"); });
    el.addEventListener("dragleave", () => el.classList.remove("drag"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("drag");
      await addToSlot(slot, [...e.dataTransfer.files]);
    });
    slotEls[slot] = el;
    box.appendChild(el);
  });
}

function renderSlots() {
  for (const slot of SLOTS) {
    const el = slotEls[slot], items = Samples.list(state.cat, slot);
    el.querySelector(".snd").textContent = CATS[state.cat].slots[slot];
    const src = el.querySelector(".src");
    if (items.length) {
      src.className = "src";
      const names = items.slice(0, 2).map((s) => s.name).join(", ") + (items.length > 2 ? "…" : "");
      src.innerHTML = `<span class="n">${items.length} sample${items.length > 1 ? "s" : ""}</span> · `;
      src.append(names);
    } else {
      src.className = "src synth";
      src.textContent = "Synth placeholder. Drop audio files here.";
    }
    el.querySelector('[data-act="clear"]').hidden = !items.length;
  }
}

function lightSlot(slot, hand) {
  const el = slotEls[slot];
  if (!el) return;
  const lamp = el.querySelectorAll(".lamps i")[hand === "right" ? 1 : 0];
  const cls = hand === "right" ? "on-r" : "on-l";
  lamp.classList.add(cls);
  el.classList.add("hit");
  clearTimeout(el._t);
  el._t = setTimeout(() => { lamp.classList.remove(cls); el.classList.remove("hit"); }, 160);
}

const note = (msg) => { $("sampleNote").textContent = msg; };

/* -------------------------------------------------------------- samples */

async function addToSlot(slot, files) {
  if (!files.length) return;
  createAudio(state.volume);
  note(`Loading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const { added, failed } = await Samples.addFiles(state.cat, slot, files);
  let msg = `Added ${added} sample${added === 1 ? "" : "s"} to ${CATS[state.cat].name} · ${CATS[state.cat].slots[slot]}.`;
  if (failed.length) msg += ` Skipped ${failed.length}: ${failed.slice(0, 2).map((f) => `${f.name} (${f.reason})`).join(", ")}${failed.length > 2 ? "…" : ""}`;
  note(msg);
  renderFolders();
  renderSlots();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Work out the folder and finger slot from a path such as "My Pack/Footsteps/Index/step_01.wav". */
export function route(path) {
  const segs = path.split("/").slice(0, -1).map(norm);
  let cat = null, slot = null, catSeg = -1;
  segs.forEach((s, i) => {
    for (const ck of CAT_KEYS) if (!cat && CATS[ck].alias.map(norm).includes(s)) { cat = ck; catSeg = i; }
  });
  if (!cat) return null;
  // Score each slot name against each folder name: exact match beats a contained word,
  // and longer names win (so "Long whoosh" isn't mistaken for "Whoosh").
  let best = 0;
  for (const s of segs.slice(catSeg + 1)) {   // only folders inside the category folder
    for (const sk of SLOTS) {
      for (const n of [...SLOT_ALIAS[sk], CATS[cat].slots[sk]].map(norm)) {
        let score = 0;
        if (s === n) score = 1000 + n.length;
        else if (/^\d$/.test(n)) score = new RegExp(`(^|\\D)${n}(\\D|$)`).test(s) ? 1 : 0;
        else if (n.length > 2 && s.includes(n)) score = 10 + n.length;
        if (score > best) { best = score; slot = sk; }
      }
    }
  }
  return slot ? { cat, slot } : null;
}

$("folderBtn").addEventListener("click", () => $("folderInput").click());
$("folderInput").addEventListener("change", async (e) => {
  const files = [...e.target.files].filter((f) => Samples.AUDIO_EXT.test(f.name));
  e.target.value = "";
  if (!files.length) { note("No audio files found in that folder."); return; }
  createAudio(state.volume);
  note(`Loading ${files.length} files…`);
  const groups = new Map();
  let unmatched = 0;
  for (const f of files) {
    const r = route(f.webkitRelativePath || f.name);
    if (!r) { unmatched++; continue; }
    const k = r.cat + "/" + r.slot;
    if (!groups.has(k)) groups.set(k, { ...r, files: [] });
    groups.get(k).files.push(f);
  }
  let added = 0, failed = 0;
  for (const g of groups.values()) {
    const res = await Samples.addFiles(g.cat, g.slot, g.files);
    added += res.added; failed += res.failed.length;
  }
  let msg = `Added ${added} samples to ${groups.size} slot${groups.size === 1 ? "" : "s"}.`;
  if (unmatched) msg += ` ${unmatched} files weren't in a matching folder (for example Footsteps/Index).`;
  if (failed) msg += ` ${failed} couldn't be read.`;
  note(msg);
  renderFolders();
  renderSlots();
});

let clearArmed = false;
$("clearAllBtn").addEventListener("click", async () => {
  const btn = $("clearAllBtn");
  if (!clearArmed) {
    clearArmed = true;
    btn.textContent = "Click again to remove all";
    setTimeout(() => { clearArmed = false; btn.textContent = "Remove all my samples"; }, 3000);
    return;
  }
  clearArmed = false;
  btn.textContent = "Remove all my samples";
  await Samples.clearAll();
  note("Removed all samples.");
  renderFolders();
  renderSlots();
});

// Dropping a file outside a slot shouldn't open it in the browser tab.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

/* ---------------------------------------------------------------- knobs */

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;

function buildKnobs() {
  const box = $("knobs");
  for (const m of KNOBS) {
    const el = document.createElement("div");
    el.className = "knob";
    el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", m.label);
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.innerHTML = `<svg viewBox="0 0 58 58" aria-hidden="true">
      <circle cx="29" cy="29" r="17" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.16)"/>
      <path d="${arc(29, 29, 24, A0, A0 + SWEEP)}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4" stroke-linecap="round"/>
      <path class="val" fill="none" stroke="${COL.accent}" stroke-width="4" stroke-linecap="round"/>
      <line class="ptr" x1="29" y1="29" stroke="#f5f5f7" stroke-width="2.5" stroke-linecap="round"/>
    </svg><span class="kv"></span><span class="kl">${m.label}</span>`;
    const set = (v) => {
      v = Math.min(1, Math.max(0, v));
      state.knobs[m.k] = v;
      const a = A0 + SWEEP * v;
      el.querySelector(".val").setAttribute("d", arc(29, 29, 24, A0, A0 + Math.max(SWEEP * v, 0.001)));
      const ptr = el.querySelector(".ptr");
      ptr.setAttribute("x2", (29 + 12 * Math.cos(a)).toFixed(2));
      ptr.setAttribute("y2", (29 + 12 * Math.sin(a)).toFixed(2));
      el.querySelector(".kv").textContent = m.fmt(v);
      el.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      el.setAttribute("aria-valuetext", m.fmt(v));
      if (m.k === "reverb") setSpace(v, state.cat);
    };
    let startY = 0, startV = 0;
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); startY = e.clientY; startV = state.knobs[m.k]; });
    el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) set(startV + (startY - e.clientY) / 160); });
    el.addEventListener("wheel", (e) => { e.preventDefault(); set(state.knobs[m.k] - Math.sign(e.deltaY) * 0.02); }, { passive: false });
    el.addEventListener("dblclick", () => set(m.def));
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { set(state.knobs[m.k] + step); e.preventDefault(); }
      if (e.key === "ArrowDown" || e.key === "ArrowLeft") { set(state.knobs[m.k] - step); e.preventDefault(); }
    });
    set(m.def);
    box.appendChild(el);
  }
}

/* -------------------------------------------------------------- trigger */

const cueEvents = [];
let count = 0;

function trigger(slot, hand, vel) {
  if (!A.ctx) return;
  if (A.ctx.state !== "running") A.ctx.resume();
  const v = 1 - state.knobs.dynamics * (1 - vel);          // Dynamics 0 = every hit at full level
  const pan = hand === "left" ? -0.25 : hand === "right" ? 0.25 : 0;
  let source = Samples.play(state.cat, slot, v, pan, state.knobs.variation);
  if (!source) {
    const c = makeCtx(v, pan, 0.5, { intensity: 0.55, tone: 0.5, pitch: 0.5, variation: state.knobs.variation }, false);
    LIB[state.cat].play(SYNTH_KEY[slot], c, Object.keys(LIB[state.cat].presets)[0]);
    source = "synth placeholder";
  }
  count++;
  cueEvents.push({ t: performance.now(), slot, hand, vel });
  lightSlot(slot, hand);
  const name = $("lastName");
  name.textContent = `${CATS[state.cat].slots[slot]} · ${CATS[state.cat].name}`;
  name.className = "big " + (hand === "center" ? "" : hand);
  const who = hand === "center" ? "Test" : hand === "left" ? "Left hand" : "Right hand";
  $("lastMeta").textContent = `${who} · velocity ${Math.round(1 + vel * 126)}/127 · ${source}`;
}

/* ------------------------------------------------------------- controls */

$("touch").addEventListener("input", (e) => { state.touch = +e.target.value; $("touchOut").textContent = state.touch.toFixed(2); });
$("volume").addEventListener("input", (e) => { state.volume = +e.target.value; setVolume(state.volume); $("volOut").textContent = Math.round(state.volume * 100) + "%"; });
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.target.classList?.contains("knob")) return;
  if (e.key >= "1" && e.key <= String(CAT_KEYS.length)) selectCategory(CAT_KEYS[+e.key - 1]);
});

/* --------------------------------------------------------- hand tracker */

let landmarker = null;
const status = (msg, err = false) => { const s = $("status"); s.textContent = msg; s.classList.toggle("err", err); };
const pill = (msg, live = false) => { $("pillText").textContent = msg; $("pill").classList.toggle("live", live); };

const trackerReady = (async () => {
  const files = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO", numHands: 2,
    minHandDetectionConfidence: 0.7, minHandPresenceConfidence: 0.7, minTrackingConfidence: 0.6,
  });
  try { landmarker = await HandLandmarker.createFromOptions(files, opts("GPU")); }
  catch { landmarker = await HandLandmarker.createFromOptions(files, opts("CPU")); }
  status("Hand tracker ready");
})().catch((e) => { status("Could not load the hand tracker. Check your connection and reload.", true); throw e; });

$("startBtn").addEventListener("click", async () => {
  const btn = $("startBtn");
  btn.disabled = true;
  await initAudio(state.volume);
  setSpace(state.knobs.reverb, state.cat);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status("The camera needs a secure page. Open this site over https.", true);
    btn.disabled = false;
    return;
  }
  status("Asking for camera access…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false,
    });
    const video = $("video");
    video.srcObject = stream;
    await video.play();
    $("videoWrap").style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    status("Loading hand tracker…");
    await trackerReady;
    $("gate").hidden = true;
    pill("Tracking", true);
    requestAnimationFrame(loop);
  } catch (e) {
    const msg = e?.name === "NotAllowedError" ? "Camera blocked. Allow camera access in your browser's address bar, then press Start again."
      : e?.name === "NotFoundError" ? "No camera found. Connect a webcam and press Start again."
      : "The camera could not start: " + (e?.message || e);
    status(msg, true);
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------ main loop */

const hands = new Map();
const flashes = [];
let lastVideoTime = -1, fps = 0, lastFrame = 0;
const overlay = $("overlay"), octx = overlay.getContext("2d");
const cue = $("cue"), cctx = cue.getContext("2d");
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function fit(c, g) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [r.width, r.height];
}

function loop(now) {
  const video = $("video");
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const t0 = performance.now();
    const res = landmarker.detectForVideo(video, t0);
    if (lastFrame) fps = 0.9 * fps + 0.1 * (1000 / (t0 - lastFrame));
    lastFrame = t0;
    processHands(res, t0 / 1000, video.videoWidth / video.videoHeight);
    const n = res.landmarks.length;
    pill(`${n} ${n === 1 ? "hand" : "hands"} · ${fps.toFixed(0)} fps`, true);
  }
  drawCue(now);
  requestAnimationFrame(loop);
}

function processHands(res, t, aspect) {
  const [w, h] = fit(overlay, octx);
  octx.clearRect(0, 0, w, h);
  const seen = new Set();
  res.landmarks.forEach((lms, i) => {
    // The camera image isn't mirrored, so MediaPipe's "Left" is the performer's right hand.
    let side = (res.handedness[i]?.[0]?.categoryName || "Left") === "Left" ? "right" : "left";
    if (seen.has(side)) side = side === "left" ? "right" : "left";
    seen.add(side);
    if (!hands.has(side)) hands.set(side, new Hand(t));
    const hand = hands.get(side);
    for (const e of hand.update(lms, t, aspect, { touch: state.touch })) {
      trigger(e.slot, side, e.vel);
      flashes.push({ x: e.x, y: e.y, t, side });
    }
    drawHand(lms, hand, side, w, h, aspect);
  });
  for (const k of [...hands.keys()]) if (!seen.has(k)) hands.delete(k);

  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i], age = t - f.t;
    if (age > 0.3) { flashes.splice(i, 1); continue; }
    const u = age / 0.3;
    octx.strokeStyle = f.side === "left" ? COL.left : COL.right;
    octx.globalAlpha = 1 - u;
    octx.lineWidth = 3;
    octx.beginPath();
    octx.arc((1 - f.x) * w, f.y * h, 12 + u * 30, 0, Math.PI * 2);
    octx.stroke();
  }
  octx.globalAlpha = 1;
}

function drawHand(lms, hand, side, w, h, aspect) {
  const X = (p) => (1 - p.x) * w, Y = (p) => p.y * h;
  const FX = (p) => (1 - p.x / aspect) * w;          // filtered points are stored in aspect units
  const col = side === "left" ? COL.left : COL.right;
  octx.lineWidth = 1.5;
  octx.strokeStyle = "rgba(255,255,255,0.3)";
  octx.beginPath();
  for (const [a, b] of BONES) { octx.moveTo(X(lms[a]), Y(lms[a])); octx.lineTo(X(lms[b]), Y(lms[b])); }
  octx.stroke();
  if (!hand.ready) return;

  const th = hand.pts[4];
  const release = state.touch + 0.25;
  for (const slot of SLOTS) {
    const s = hand.s[slot], tip = hand.pts[TIP[slot]];
    const closeness = Math.max(0, Math.min(1, (release + 0.4 - s.r) / 0.4));
    if (closeness > 0) {
      octx.strokeStyle = col;
      octx.globalAlpha = 0.2 + 0.8 * closeness;
      octx.lineWidth = 1 + 2.5 * closeness;
      octx.beginPath(); octx.moveTo(FX(th), Y(th)); octx.lineTo(FX(tip), Y(tip)); octx.stroke();
      octx.globalAlpha = 1;
    }
    // Filled = ready to play. Hollow = open your fingers to re-arm.
    octx.beginPath();
    octx.arc(FX(tip), Y(tip), 6, 0, Math.PI * 2);
    if (s.armed) { octx.fillStyle = col; octx.fill(); }
    else { octx.strokeStyle = col; octx.lineWidth = 2; octx.stroke(); }
  }
  octx.fillStyle = "#fff";
  octx.beginPath(); octx.arc(FX(th), Y(th), 5, 0, Math.PI * 2); octx.fill();
}

function drawCue(now) {
  const [w, h] = fit(cue, cctx);
  const span = 8000, padL = 62, padR = 12, top = 8, bottom = 22;
  const laneH = (h - top - bottom) / SLOTS.length;
  const xAt = (t) => padL + (1 - (now - t) / span) * (w - padL - padR);
  cctx.clearRect(0, 0, w, h);
  cctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  for (let s = 0; s <= 8; s++) {
    const x = padL + (s / 8) * (w - padL - padR);
    cctx.strokeStyle = "rgba(255,255,255,0.06)";
    cctx.beginPath(); cctx.moveTo(x, top); cctx.lineTo(x, h - bottom); cctx.stroke();
    if (s % 2 === 0 || w > 560) {
      cctx.fillStyle = "rgba(235,235,245,0.4)";
      cctx.textAlign = "center";
      cctx.fillText(s === 8 ? "now" : `−${8 - s}s`, x, h - 6);
    }
  }
  cctx.textAlign = "left";
  SLOTS.forEach((slot, i) => {
    const y = top + laneH * i;
    cctx.fillStyle = "rgba(235,235,245,0.55)";
    cctx.fillText(CATS[state.cat].slots[slot], 10, y + laneH / 2 + 4, padL - 14);
    cctx.strokeStyle = "rgba(255,255,255,0.05)";
    cctx.beginPath(); cctx.moveTo(padL, y + laneH); cctx.lineTo(w - padR, y + laneH); cctx.stroke();
  });
  while (cueEvents.length && now - cueEvents[0].t > span) cueEvents.shift();
  for (const ev of cueEvents) {
    const lane = SLOTS.indexOf(ev.slot);
    const x = xAt(ev.t), base = top + laneH * (lane + 1) - 3, bh = Math.max(3, ev.vel * (laneH - 6));
    cctx.fillStyle = ev.hand === "right" ? COL.right : COL.left;
    cctx.fillRect(x - 2, base - bh, 4, bh);
  }
  cctx.fillStyle = COL.accent;
  cctx.fillRect(w - padR - 1, top, 2, h - top - bottom);
}

/* ----------------------------------------------------------------- boot */

buildSlots();
buildKnobs();
selectCategory(state.cat);
createAudio(state.volume);           // suspended until the first click; lets samples decode now
Promise.all([Samples.restore(), Samples.loadBundled()]).then(([mine, bundled]) => {
  if (mine || bundled) {
    note(`${mine ? `${mine} of your samples restored` : ""}${mine && bundled ? ", " : ""}${bundled ? `${bundled} bundled samples loaded` : ""}.`);
    renderFolders();
    renderSlots();
  }
});
(function idle(now) { if ($("gate").hidden) return; drawCue(now); requestAnimationFrame(idle); })(performance.now());
