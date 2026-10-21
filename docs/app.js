import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { Hand } from "./gestures.js";
import { A, LIB, initAudio, makeCtx, setSpace, setTexture, setVolume, textureFrame } from "./sounds.js";

const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = { left: css("--left"), right: css("--right"), accent: css("--accent") };

const GESTURES = [
  { k: "a", how: "Thumb + index" },
  { k: "b", how: "Thumb + middle" },
  { k: "c", how: "Thumb + ring" },
  { k: "fist", how: "Make a fist" },
  { k: "swipe", how: "Swipe sideways" },
  { k: "texture", how: "Move open hand" },
];
const LANES = ["a", "b", "c", "fist", "swipe"];
const LANE_NAMES = { a: "Index", b: "Middle", c: "Ring", fist: "Fist", swipe: "Swipe" };

const MACROS = [
  { k: "intensity", label: "Intensity", def: 0.55, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "tone", label: "Tone", def: 0.5, fmt: (v) => { const n = Math.round((v - 0.5) * 200); return (n > 0 ? "+" : "") + n; } },
  { k: "space", label: "Space", def: 0.35, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "pitch", label: "Pitch", def: 0.5, fmt: (v) => { const st = Math.round((v - 0.5) * 24); return (st > 0 ? "+" : "") + st + " st"; } },
  { k: "variation", label: "Variation", def: 0.5, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "texture", label: "Texture", def: 0.6, fmt: (v) => Math.round(v * 100) + "%" },
];

const state = {
  cat: "footsteps",
  presetBy: Object.fromEntries(Object.entries(LIB).map(([k, c]) => [k, Object.keys(c.presets)[0]])),
  macros: Object.fromEntries(MACROS.map((m) => [m.k, m.def])),
  touch: 0.25, early: false, heightTone: true, volume: 0.8,
  gest: { a: true, b: true, c: true, fist: true, swipe: true, texture: true },
};
const preset = () => state.presetBy[state.cat];

/* ------------------------------------------------------------ library */

const FOLDER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.5"/></svg>';

function renderLibrary() {
  const box = $("cats");
  box.innerHTML = "";
  for (const [ck, cat] of Object.entries(LIB)) {
    const open = ck === state.cat;
    const wrap = document.createElement("div");
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "cat-btn";
    btn.setAttribute("aria-expanded", String(open));
    btn.innerHTML = `${FOLDER}<span>${cat.name}</span><span class="count">${Object.keys(cat.presets).length}</span>`;
    btn.addEventListener("click", () => selectCategory(ck));
    wrap.appendChild(btn);
    if (open) {
      const ul = document.createElement("ul");
      ul.className = "presets";
      for (const [pk, pname] of Object.entries(cat.presets)) {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button"; b.className = "preset"; b.textContent = pname;
        b.setAttribute("aria-pressed", String(pk === preset()));
        b.addEventListener("click", () => selectPreset(pk));
        li.appendChild(b); ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }
    box.appendChild(wrap);
  }
}

function selectCategory(ck) {
  state.cat = ck;
  refreshSound();
}
function selectPreset(pk) {
  state.presetBy[state.cat] = pk;
  refreshSound();
}
function refreshSound() {
  renderLibrary();
  renderGestures();
  $("stageCat").textContent = LIB[state.cat].name;
  $("stagePreset").textContent = LIB[state.cat].presets[preset()];
  setSpace(state.macros.space, state.cat);
  setTexture(state.cat, preset(), state.macros.pitch);
}

/* ------------------------------------------------------- gesture tiles */

const tiles = {};
function renderGestures() {
  const box = $("gestures");
  if (!box.childElementCount) {
    for (const g of GESTURES) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "gtile";
      b.innerHTML = `<span class="how">${g.how}</span><span class="snd"></span><span class="lamps"><i></i><i></i></span>${g.k === "texture" ? '<span class="meter"><b></b></span>' : ""}`;
      b.addEventListener("click", () => {
        if (b.classList.contains("na")) return;
        state.gest[g.k] = !state.gest[g.k];
        renderGestures();
      });
      tiles[g.k] = b;
      box.appendChild(b);
    }
  }
  const labels = LIB[state.cat].labels;
  for (const g of GESTURES) {
    const b = tiles[g.k], label = labels[g.k];
    b.querySelector(".snd").textContent = label || "Not used here";
    b.classList.toggle("na", !label);
    b.setAttribute("aria-pressed", String(!!label && state.gest[g.k]));
    b.setAttribute("aria-label", `${g.how}: ${label || "not used in this folder"}${label ? (state.gest[g.k] ? ", on" : ", off") : ""}`);
  }
}

function lightTile(k, hand) {
  const lamp = tiles[k]?.querySelectorAll(".lamps i")[hand === "left" ? 0 : 1];
  if (!lamp) return;
  const cls = hand === "left" ? "on-l" : "on-r";
  lamp.classList.add(cls);
  clearTimeout(lamp._t);
  lamp._t = setTimeout(() => lamp.classList.remove(cls), 160);
}

/* --------------------------------------------------------------- knobs */

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;

function buildKnobs() {
  const box = $("knobs");
  for (const m of MACROS) {
    const el = document.createElement("div");
    el.className = "knob"; el.tabIndex = 0;
    el.setAttribute("role", "slider");
    el.setAttribute("aria-label", m.label);
    el.setAttribute("aria-valuemin", "0"); el.setAttribute("aria-valuemax", "100");
    el.innerHTML = `<svg viewBox="0 0 58 58" aria-hidden="true">
      <circle cx="29" cy="29" r="17" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.16)"/>
      <path d="${arc(29, 29, 24, A0, A0 + SWEEP)}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4" stroke-linecap="round"/>
      <path class="val" fill="none" stroke="${COL.accent}" stroke-width="4" stroke-linecap="round"/>
      <line class="ptr" x1="29" y1="29" stroke="#f5f5f7" stroke-width="2.5" stroke-linecap="round"/>
    </svg><span class="kv"></span><span class="kl">${m.label}</span>`;
    const set = (v) => {
      v = Math.min(1, Math.max(0, v));
      state.macros[m.k] = v;
      const a = A0 + SWEEP * v;
      el.querySelector(".val").setAttribute("d", arc(29, 29, 24, A0, A0 + Math.max(SWEEP * v, 0.001)));
      const ptr = el.querySelector(".ptr");
      ptr.setAttribute("x2", (29 + 12 * Math.cos(a)).toFixed(2));
      ptr.setAttribute("y2", (29 + 12 * Math.sin(a)).toFixed(2));
      el.querySelector(".kv").textContent = m.fmt(v);
      el.setAttribute("aria-valuenow", String(Math.round(v * 100)));
      el.setAttribute("aria-valuetext", m.fmt(v));
      if (m.k === "space") setSpace(v, state.cat);
      if (m.k === "pitch" && LIB[state.cat].texture === "drone") setTexture(state.cat, preset(), v);
    };
    let startY = 0, startV = 0;
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); startY = e.clientY; startV = state.macros[m.k]; });
    el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) set(startV + (startY - e.clientY) / 160); });
    el.addEventListener("wheel", (e) => { e.preventDefault(); set(state.macros[m.k] - Math.sign(e.deltaY) * 0.02); }, { passive: false });
    el.addEventListener("dblclick", () => set(m.def));
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { set(state.macros[m.k] + step); e.preventDefault(); }
      if (e.key === "ArrowDown" || e.key === "ArrowLeft") { set(state.macros[m.k] - step); e.preventDefault(); }
    });
    set(m.def);
    box.appendChild(el);
  }
}

/* -------------------------------------------------------------- trigger */

const cueEvents = [];
const texHist = [];
let count = 0;

function trigger(kind, hand, vel, extra = {}) {
  const cat = LIB[state.cat];
  const label = cat.labels[kind];
  if (!label) return;
  initAudio(state.volume).then(() => {
    if (!A.tex && cat.texture) setTexture(state.cat, preset(), state.macros.pitch);
  });
  if (!A.ctx) return;
  setSpace(state.macros.space, state.cat);
  const pan = hand === "left" ? -0.25 : 0.25;
  const c = makeCtx(vel, pan, extra.height ?? 0.5, state.macros, state.heightTone);
  c.dir = extra.dir || 1;
  c.speed = extra.speed || 0;
  cat.play(kind, c, preset());
  count++;
  cueEvents.push({ t: performance.now(), kind, hand, vel });
  lightTile(kind, hand);
  const name = $("lastName");
  name.textContent = `${label} · ${cat.presets[preset()]}`;
  name.className = "big " + hand;
  $("lastMeta").textContent = `${hand === "left" ? "Left" : "Right"} hand · velocity ${Math.round(1 + vel * 126)}/127 · #${count}`;
}

/* ------------------------------------------------------------ controls */

$("testBtn").addEventListener("click", () => trigger("a", Math.random() < 0.5 ? "left" : "right", 0.7));
$("touch").addEventListener("input", (e) => { state.touch = +e.target.value; $("touchOut").textContent = state.touch.toFixed(2); });
$("early").addEventListener("change", (e) => { state.early = e.target.checked; });
$("heightTone").addEventListener("change", (e) => { state.heightTone = e.target.checked; });
$("volume").addEventListener("input", (e) => { state.volume = +e.target.value; setVolume(state.volume); $("volOut").textContent = Math.round(state.volume * 100) + "%"; });
window.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" && e.target.type !== "range") return;
  if (e.target.classList?.contains("knob")) return;
  if (e.key >= "1" && e.key <= "9") {
    const keys = Object.keys(LIB[state.cat].presets), i = +e.key - 1;
    if (keys[i]) selectPreset(keys[i]);
  } else if (e.code === "Space" && tag !== "BUTTON") {
    e.preventDefault();
    trigger("a", "left", 0.7);
  }
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
    minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try { landmarker = await HandLandmarker.createFromOptions(files, opts("GPU")); }
  catch { landmarker = await HandLandmarker.createFromOptions(files, opts("CPU")); }
  status("Hand tracker ready");
})().catch((e) => { status("Could not load the hand tracker. Check your connection and reload.", true); throw e; });

$("startBtn").addEventListener("click", async () => {
  const btn = $("startBtn");
  btn.disabled = true;
  await initAudio(state.volume);
  setSpace(state.macros.space, state.cat);
  setTexture(state.cat, preset(), state.macros.pitch);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    status("The camera needs a secure page. Open this site over https.", true);
    btn.disabled = false; return;
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
let lastVideoTime = -1, fps = 0, procMs = 0, lastFrame = 0;
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
    procMs = 0.9 * procMs + 0.1 * (performance.now() - t0);
    if (lastFrame) fps = 0.9 * fps + 0.1 * (1000 / (t0 - lastFrame));
    lastFrame = t0;
    processHands(res, t0 / 1000, video.videoWidth / video.videoHeight);
    pill(`${res.landmarks.length} ${res.landmarks.length === 1 ? "hand" : "hands"} · ${fps.toFixed(0)} fps · ${procMs.toFixed(0)} ms`, true);
  }
  drawCue(now);
  requestAnimationFrame(loop);
}

function processHands(res, t, aspect) {
  const [w, h] = fit(overlay, octx);
  octx.clearRect(0, 0, w, h);
  const seen = new Set();
  let texLevel = 0, texHeight = 0.5;
  const cfg = { touch: state.touch, early: state.early, gest: state.gest };

  res.landmarks.forEach((lms, i) => {
    // The camera image isn't mirrored, so MediaPipe's "Left" is the performer's right hand.
    let side = (res.handedness[i]?.[0]?.categoryName || "Left") === "Left" ? "right" : "left";
    if (seen.has(side)) side = side === "left" ? "right" : "left";
    seen.add(side);
    if (!hands.has(side)) hands.set(side, new Hand());
    const hand = hands.get(side);
    for (const e of hand.update(lms, t, aspect, cfg)) {
      trigger(e.kind, side, e.vel, { height: hand.height, dir: e.dir, speed: e.speed });
      flashes.push({ x: e.x, y: e.y, t, side, big: e.kind === "fist" || e.kind === "swipe" });
    }
    if (hand.motion > texLevel) { texLevel = hand.motion; texHeight = hand.height; }
    drawHand(lms, hand, side, w, h);
  });
  for (const k of [...hands.keys()]) if (!seen.has(k)) hands.delete(k);

  const lvl = state.gest.texture && LIB[state.cat].texture ? texLevel * state.macros.texture : 0;
  textureFrame(lvl, texHeight);
  const meter = tiles.texture?.querySelector(".meter b");
  if (meter) meter.style.width = Math.round(lvl * 100) + "%";
  texHist.push({ t: performance.now(), v: lvl });

  // contact flashes
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i], age = t - f.t;
    if (age > 0.3) { flashes.splice(i, 1); continue; }
    const u = age / 0.3;
    octx.strokeStyle = f.side === "left" ? COL.left : COL.right;
    octx.globalAlpha = 1 - u;
    octx.lineWidth = 3;
    octx.beginPath();
    octx.arc((1 - f.x) * w, f.y * h, (f.big ? 30 : 12) + u * (f.big ? 50 : 30), 0, Math.PI * 2);
    octx.stroke();
  }
  octx.globalAlpha = 1;
}

function drawHand(lms, hand, side, w, h) {
  const X = (p) => (1 - p.x) * w, Y = (p) => p.y * h;
  const col = side === "left" ? COL.left : COL.right;
  octx.lineWidth = 1.5;
  octx.strokeStyle = "rgba(255,255,255,0.35)";
  octx.beginPath();
  for (const [a, b] of BONES) { octx.moveTo(X(lms[a]), Y(lms[a])); octx.lineTo(X(lms[b]), Y(lms[b])); }
  octx.stroke();
  octx.fillStyle = "rgba(255,255,255,0.8)";
  for (const p of lms) { octx.beginPath(); octx.arc(X(p), Y(p), 2.2, 0, Math.PI * 2); octx.fill(); }

  // Thumb-to-fingertip guides: brighter as the fingers get closer.
  const th = lms[4];
  for (const k of ["a", "b", "c"]) {
    const pn = hand.pinch[k];
    if (!state.gest[k] || !LIB[state.cat].labels[k]) continue;
    const tip = lms[pn.tip];
    const closeness = Math.max(0, Math.min(1, (0.9 - pn.r) / (0.9 - state.touch)));
    if (closeness <= 0) continue;
    octx.strokeStyle = col;
    octx.globalAlpha = 0.15 + 0.85 * closeness;
    octx.lineWidth = 1 + 2 * closeness;
    octx.beginPath(); octx.moveTo(X(th), Y(th)); octx.lineTo(X(tip), Y(tip)); octx.stroke();
    octx.globalAlpha = 1;
    if (pn.down) {
      octx.fillStyle = col;
      octx.beginPath(); octx.arc((X(th) + X(tip)) / 2, (Y(th) + Y(tip)) / 2, 6, 0, Math.PI * 2); octx.fill();
    }
  }
  octx.fillStyle = col;
  for (const i of [4, 8, 12, 16]) { octx.beginPath(); octx.arc(X(lms[i]), Y(lms[i]), 4, 0, Math.PI * 2); octx.fill(); }
}

function drawCue(now) {
  const [w, h] = fit(cue, cctx);
  const span = 8000, padL = 62, padR = 12, top = 8, bottom = 22;
  const rows = LANES.length + 1, laneH = (h - top - bottom) / rows;
  const xAt = (t) => padL + (1 - (now - t) / span) * (w - padL - padR);
  cctx.clearRect(0, 0, w, h);
  cctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";

  for (let s = 0; s <= 8; s++) {
    const x = padL + (s / 8) * (w - padL - padR);
    cctx.strokeStyle = "rgba(255,255,255,0.06)";
    cctx.beginPath(); cctx.moveTo(x, top); cctx.lineTo(x, h - bottom); cctx.stroke();
    if (s % 2 === 0 || w > 560) {
      cctx.fillStyle = "rgba(235,235,245,0.4)"; cctx.textAlign = "center";
      cctx.fillText(s === 8 ? "now" : `−${8 - s}s`, x, h - 6);
    }
  }
  cctx.textAlign = "left";
  const names = [...LANES.map((k) => LANE_NAMES[k]), "Texture"];
  names.forEach((n, i) => {
    const y = top + laneH * i;
    cctx.fillStyle = "rgba(235,235,245,0.55)";
    cctx.fillText(n, 10, y + laneH / 2 + 4);
    cctx.strokeStyle = "rgba(255,255,255,0.05)";
    cctx.beginPath(); cctx.moveTo(padL, y + laneH); cctx.lineTo(w - padR, y + laneH); cctx.stroke();
  });

  while (cueEvents.length && now - cueEvents[0].t > span) cueEvents.shift();
  for (const ev of cueEvents) {
    const lane = LANES.indexOf(ev.kind);
    if (lane < 0) continue;
    const x = xAt(ev.t), base = top + laneH * (lane + 1) - 3, bh = Math.max(3, ev.vel * (laneH - 6));
    cctx.fillStyle = ev.hand === "left" ? COL.left : COL.right;
    cctx.beginPath(); cctx.roundRect(x - 2, base - bh, 4, bh, 2); cctx.fill();
  }

  while (texHist.length && now - texHist[0].t > span) texHist.shift();
  if (texHist.length > 1) {
    const base = top + laneH * rows - 3, ht = laneH - 6;
    cctx.beginPath();
    cctx.moveTo(xAt(texHist[0].t), base);
    for (const p of texHist) cctx.lineTo(xAt(p.t), base - p.v * ht);
    cctx.lineTo(xAt(texHist[texHist.length - 1].t), base);
    cctx.closePath();
    cctx.fillStyle = "rgba(10,132,255,0.35)";
    cctx.fill();
  }
  cctx.fillStyle = COL.accent;
  cctx.fillRect(w - padR - 1, top, 2, h - top - bottom);
}

/* ---------------------------------------------------------------- boot */

buildKnobs();
refreshSound();
(function idle(now) { if ($("gate").hidden) return; drawCue(now); requestAnimationFrame(idle); })(performance.now());
