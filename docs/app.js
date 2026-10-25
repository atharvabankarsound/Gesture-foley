import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { Hand, SLOTS, TIP } from "./gestures.js";
import { A, LIB, createAudio, initAudio, makeCtx, setSpace, setVolume } from "./sounds.js";
import { cornerWeights, layers } from "./blend.js";
import * as Samples from "./samples.js";

const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = { left: css("--left"), right: css("--right"), accent: css("--accent") };
const CORNER_COL = ["#0a84ff", "#30d1c4", "#ff9f0a", "#bf5af2"];      // top-left, top-right, bottom-left, bottom-right
const CORNER_POS = ["Top left", "Top right", "Bottom left", "Bottom right"];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* -------------------------------------------------------------- folders */

const CATS = {
  footsteps: { slots: { index: "Step", middle: "Scuff", ring: "Squeak", pinky: "Stomp" }, corners: ["gravel", "puddle", "sneakers", "wood"], alias: ["footsteps", "footstep", "steps", "feet"] },
  cloth: { slots: { index: "Grab", middle: "Snap", ring: "Zip", pinky: "Body fall" }, corners: ["cotton", "leather", "denim", "nylon"], alias: ["cloth", "clothes", "clothing", "fabric", "rustle"] },
  movement: { slots: { index: "Whoosh", middle: "Long whoosh", ring: "Punch", pinky: "Body hit" }, corners: ["swish", "heavy", "blade", "body"], alias: ["movement", "movements", "whooshes"] },
  guns: { slots: { index: "Shot", middle: "Reload", ring: "Shell drop", pinky: "Burst" }, corners: ["pistol", "rifle", "shotgun", "silenced"], alias: ["guns", "gun", "weapons", "firearms"] },
  jewellery: { slots: { index: "Jingle", middle: "Shake", ring: "Drop", pinky: "Handful" }, corners: ["keys", "coins", "chain", "bells"], alias: ["jewellery", "jewelry", "jewels", "trinkets"] },
  cinematic: { slots: { index: "Hit", middle: "Braam", ring: "Riser", pinky: "Boom" }, corners: ["epic", "deep", "metal", "scifi"], alias: ["cinematic", "cinematics", "trailer", "impacts"] },
};
const CAT_KEYS = Object.keys(CATS);
const catName = (ck) => LIB[ck].name;
const texName = (ck, tx) => LIB[ck].presets[tx] || tx;
const textures = (ck) => Object.keys(LIB[ck].presets);
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
  steer: false,
  knobs: Object.fromEntries(KNOBS.map((m) => [m.k, m.def])),
  pads: Object.fromEntries(CAT_KEYS.map((k) => [k, { corners: [...CATS[k].corners], x: 0.5, y: 0.5 }])),
};
const pad = () => state.pads[state.cat];

// Remember each folder's corners and point between visits (this browser only).
try {
  const saved = JSON.parse(localStorage.getItem("gf-pads") || "{}");
  for (const [k, v] of Object.entries(saved)) {
    if (!state.pads[k] || !Array.isArray(v.corners) || v.corners.length !== 4) continue;
    if (!v.corners.every((t) => textures(k).includes(t))) continue;
    state.pads[k] = { corners: v.corners, x: clamp(+v.x || 0.5), y: clamp(+v.y || 0.5) };
  }
} catch { /* storage unavailable */ }
let saveTimer = 0;
function savePads() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem("gf-pads", JSON.stringify(state.pads)); } catch { /* ignore */ } }, 300);
}

/* -------------------------------------------------------------- folders */

const FOLDER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.5"/></svg>';

function renderFolders() {
  const box = $("cats");
  box.innerHTML = "";
  for (const ck of CAT_KEYS) {
    const n = Samples.countFolder(ck);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat-btn";
    b.setAttribute("aria-pressed", String(ck === state.cat));
    b.innerHTML = `${FOLDER_SVG}<span>${catName(ck)}</span><span class="count${n ? " has" : ""}">${n ? n : "synth"}</span>`;
    b.addEventListener("click", () => selectCategory(ck));
    box.appendChild(b);
  }
}

function selectCategory(ck) {
  state.cat = ck;
  $("stageCat").textContent = catName(ck);
  $("libCat").textContent = catName(ck);
  setSpace(state.knobs.reverb, state.cat);
  renderFolders();
  renderCorners();
  renderPad();
  renderSlots();
  renderLibrary();
}

/* ------------------------------------------------------------ blend pad */

function renderCorners() {
  const p = pad();
  const make = (i) => {
    const el = document.createElement("div");
    el.className = "corner";
    const tx = p.corners[i];
    el.innerHTML = `<button class="arrow" type="button" aria-label="${CORNER_POS[i]}: previous texture">◀</button>
      <span class="cname"><i style="background:${CORNER_COL[i]}"></i><span></span></span>
      <button class="arrow" type="button" aria-label="${CORNER_POS[i]}: next texture">▶</button>`;
    el.querySelector(".cname span").textContent = texName(state.cat, tx);
    el.title = `${CORNER_POS[i]}: ${texName(state.cat, tx)}`;
    const [prev, next] = el.querySelectorAll(".arrow");
    prev.addEventListener("click", () => cycleCorner(i, -1));
    next.addEventListener("click", () => cycleCorner(i, 1));
    return el;
  };
  const top = $("cornersTop"), bottom = $("cornersBottom");
  top.innerHTML = ""; bottom.innerHTML = "";
  top.append(make(0), make(1));
  bottom.append(make(2), make(3));
}

function cycleCorner(i, dir) {
  const p = pad(), all = textures(state.cat);
  let idx = all.indexOf(p.corners[i]);
  // Skip textures already used in another corner when there are enough to choose from.
  for (let n = 0; n < all.length; n++) {
    idx = (idx + dir + all.length) % all.length;
    if (!p.corners.some((t, j) => j !== i && t === all[idx]) || all.length <= 4) break;
  }
  p.corners[i] = all[idx];
  savePads();
  renderCorners(); renderPad(); renderSlots(); renderLibrary();
}

function setPoint(x, y) {
  const p = pad();
  p.x = clamp(x); p.y = clamp(y);
  savePads();
  renderPad();
}

function blendSummary() {
  const p = pad();
  return layers(p.corners, p.x, p.y).map((l) => `${texName(state.cat, l.tex)} ${Math.round(l.w * 100)}%`).join(" · ");
}

const padCanvas = $("padCanvas"), pctx = padCanvas.getContext("2d");
function renderPad() {
  const p = pad();
  $("puck").style.left = p.x * 100 + "%";
  $("puck").style.top = p.y * 100 + "%";
  const [w, h] = fit(padCanvas, pctx);
  pctx.clearRect(0, 0, w, h);
  const wts = cornerWeights(p.x, p.y);
  const pts = [[0, 0], [w, 0], [0, h], [w, h]];
  // corner glows, brighter the more that texture is in the mix
  pts.forEach(([cx, cy], i) => {
    const g = pctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.95);
    const a = Math.round((0.08 + 0.5 * wts[i]) * 255).toString(16).padStart(2, "0");
    g.addColorStop(0, CORNER_COL[i] + a);
    g.addColorStop(1, CORNER_COL[i] + "00");
    pctx.fillStyle = g;
    pctx.fillRect(0, 0, w, h);
  });
  // guide arcs centred on each corner
  pctx.strokeStyle = "rgba(255,255,255,0.09)";
  pctx.lineWidth = 1;
  for (const [cx, cy] of pts) { pctx.beginPath(); pctx.arc(cx, cy, w * 0.82, 0, Math.PI * 2); pctx.stroke(); }
  pctx.beginPath(); pctx.moveTo(w / 2, 0); pctx.lineTo(w / 2, h); pctx.moveTo(0, h / 2); pctx.lineTo(w, h / 2); pctx.stroke();
  // lines from the point to each corner, thicker for bigger shares
  pts.forEach(([cx, cy], i) => {
    if (wts[i] < 0.04) return;
    pctx.strokeStyle = CORNER_COL[i];
    pctx.globalAlpha = 0.25 + 0.6 * wts[i];
    pctx.lineWidth = 1 + 3 * wts[i];
    pctx.beginPath(); pctx.moveTo(p.x * w, p.y * h); pctx.lineTo(cx, cy); pctx.stroke();
  });
  pctx.globalAlpha = 1;
  // percentages on the corner labels
  document.querySelectorAll(".corner").forEach((el, i) => {
    let pct = el.querySelector(".pct");
    if (!pct) { pct = document.createElement("span"); pct.className = "pct"; el.querySelector(".cname").after(pct); }
    pct.textContent = Math.round(wts[i] * 100) + "%";
  });
  $("pad").setAttribute("aria-valuetext", blendSummary());
}

(() => {
  const el = $("pad");
  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    setPoint((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); $("padHint").hidden = true; fromEvent(e); });
  el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) fromEvent(e); });
  el.addEventListener("dblclick", () => setPoint(0.5, 0.5));
  el.addEventListener("keydown", (e) => {
    const p = pad(), st = e.shiftKey ? 0.1 : 0.04;
    const moves = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] };
    if (moves[e.key]) { e.preventDefault(); e.stopPropagation(); setPoint(p.x + moves[e.key][0], p.y + moves[e.key][1]); }
  });
})();
$("centreBtn").addEventListener("click", () => setPoint(0.5, 0.5));
$("diceBtn").addEventListener("click", () => {
  const all = [...textures(state.cat)];
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const p = pad();
  p.corners = all.slice(0, 4);
  p.x = 0.2 + Math.random() * 0.6; p.y = 0.2 + Math.random() * 0.6;
  savePads();
  renderCorners(); renderPad(); renderSlots(); renderLibrary();
});
$("steer").addEventListener("change", (e) => { state.steer = e.target.checked; });

/* ----------------------------------------------------------- finger slots */

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
      <span class="acts"><button type="button" class="mini">Play</button></span>`;
    el.querySelector(".mini").addEventListener("click", async () => { await initAudio(state.volume); trigger(slot, "center", 0.8); });
    slotEls[slot] = el;
    box.appendChild(el);
  });
}

function renderSlots() {
  const p = pad();
  for (const slot of SLOTS) {
    const el = slotEls[slot];
    el.querySelector(".snd").textContent = CATS[state.cat].slots[slot];
    const withSamples = [...new Set(p.corners)].filter((tx) => Samples.count(state.cat, tx, slot));
    const src = el.querySelector(".src");
    src.innerHTML = "";
    if (withSamples.length) {
      const b = document.createElement("b");
      b.textContent = `Samples: ${withSamples.map((tx) => texName(state.cat, tx)).join(", ")}`;
      src.append(b);
      const rest = [...new Set(p.corners)].length - withSamples.length;
      if (rest) src.append(` · synth for ${rest} more`);
    } else {
      src.textContent = "Synth placeholder";
    }
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

/* ---------------------------------------------------------- sound library */

const note = (msg) => { $("sampleNote").textContent = msg; };
let pendingCell = null;

function renderLibrary() {
  const table = $("libTable"), p = pad();
  table.innerHTML = "";
  const thead = table.createTHead().insertRow();
  const th0 = document.createElement("th");
  th0.textContent = "Texture";
  thead.appendChild(th0);
  for (const slot of SLOTS) {
    const th = document.createElement("th");
    th.innerHTML = `Thumb + ${FINGER[slot]}<span></span>`;
    th.querySelector("span").textContent = CATS[state.cat].slots[slot];
    thead.appendChild(th);
  }
  const tbody = table.createTBody();
  for (const tx of textures(state.cat)) {
    const row = tbody.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    const dot = document.createElement("i");
    const ci = p.corners.indexOf(tx);
    if (ci >= 0) { dot.style.background = CORNER_COL[ci]; dot.style.borderColor = CORNER_COL[ci]; dot.title = `${CORNER_POS[ci]} corner`; }
    th.append(dot, texName(state.cat, tx));
    row.appendChild(th);
    for (const slot of SLOTS) {
      const td = row.insertCell();
      const items = Samples.list(state.cat, tx, slot);
      const cell = document.createElement("div");
      cell.className = "cell";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add" + (items.length ? " has" : "");
      add.textContent = items.length ? `${items.length} sample${items.length > 1 ? "s" : ""}` : "+ Add";
      add.title = items.length ? items.map((s) => s.name).join("\n") : `Add ${CATS[state.cat].slots[slot]} samples for ${texName(state.cat, tx)}`;
      add.setAttribute("aria-label", `${texName(state.cat, tx)}, ${CATS[state.cat].slots[slot]}: ${items.length ? items.length + " samples, click to add more" : "add samples"}`);
      add.addEventListener("click", () => { pendingCell = { tx, slot }; $("cellInput").click(); });
      cell.appendChild(add);
      if (items.length) {
        const x = document.createElement("button");
        x.type = "button"; x.className = "x"; x.textContent = "×";
        x.setAttribute("aria-label", `Remove ${texName(state.cat, tx)} ${CATS[state.cat].slots[slot]} samples`);
        x.addEventListener("click", async () => {
          await Samples.clearCell(state.cat, tx, slot);
          note(`Removed ${texName(state.cat, tx)} · ${CATS[state.cat].slots[slot]} samples.`);
          refreshCounts();
        });
        cell.appendChild(x);
      }
      cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("drag"); });
      cell.addEventListener("dragleave", () => cell.classList.remove("drag"));
      cell.addEventListener("drop", async (e) => {
        e.preventDefault();
        cell.classList.remove("drag");
        await addToCell(tx, slot, [...e.dataTransfer.files]);
      });
      td.appendChild(cell);
    }
  }
}

function refreshCounts() { renderFolders(); renderSlots(); renderLibrary(); }

$("cellInput").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (pendingCell) await addToCell(pendingCell.tx, pendingCell.slot, files);
  pendingCell = null;
});

async function addToCell(tx, slot, files) {
  if (!files.length) return;
  createAudio(state.volume);
  note(`Loading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const { added, failed } = await Samples.addFiles(state.cat, tx, slot, files);
  let msg = `Added ${added} sample${added === 1 ? "" : "s"} to ${texName(state.cat, tx)} · ${CATS[state.cat].slots[slot]}.`;
  if (failed.length) msg += ` Skipped ${failed.length}: ${failed.slice(0, 2).map((f) => `${f.name} (${f.reason})`).join(", ")}${failed.length > 2 ? "…" : ""}`;
  note(msg);
  refreshCounts();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Work out folder, texture and finger from a path like "My Pack/Footsteps/Gravel/Step/step_01.wav". */
export function route(path) {
  const segs = path.split("/").slice(0, -1).map(norm);
  let cat = null, catSeg = -1;
  segs.forEach((s, i) => {
    for (const ck of CAT_KEYS) if (!cat && CATS[ck].alias.map(norm).includes(s)) { cat = ck; catSeg = i; }
  });
  if (!cat) return null;
  let tex = null, texSeg = -1;
  segs.forEach((s, i) => {
    if (i <= catSeg || tex) return;
    for (const tx of textures(cat)) if (!tex && (norm(tx) === s || norm(texName(cat, tx)) === s)) { tex = tx; texSeg = i; }
  });
  if (!tex) return null;
  // Exact match beats a contained word, and longer names win ("Long whoosh" over "Whoosh").
  let slot = null, best = 0;
  for (const s of segs.slice(texSeg + 1)) {
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
  return slot ? { cat, tex, slot } : null;
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
    const k = `${r.cat}/${r.tex}/${r.slot}`;
    if (!groups.has(k)) groups.set(k, { ...r, files: [] });
    groups.get(k).files.push(f);
  }
  let added = 0, failed = 0;
  for (const g of groups.values()) {
    const res = await Samples.addFiles(g.cat, g.tex, g.slot, g.files);
    added += res.added; failed += res.failed.length;
  }
  let msg = `Added ${added} samples to ${groups.size} cell${groups.size === 1 ? "" : "s"}.`;
  if (unmatched) msg += ` ${unmatched} files weren't in a matching folder (for example Footsteps/Gravel/Step).`;
  if (failed) msg += ` ${failed} couldn't be read.`;
  note(msg);
  refreshCounts();
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
  refreshCounts();
});

// Dropping a file outside a cell shouldn't open it in the browser tab.
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
      v = clamp(v);
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

function trigger(slot, hand, vel) {
  if (!A.ctx) return;
  if (A.ctx.state !== "running") A.ctx.resume();
  const v = 1 - state.knobs.dynamics * (1 - vel);          // Dynamics 0 = every hit at full level
  const pan = hand === "left" ? -0.25 : hand === "right" ? 0.25 : 0;
  const p = pad();
  let fromSamples = 0, fromSynth = 0;
  // One layer per corner texture, each at its equal-power share of the blend.
  for (const layer of layers(p.corners, p.x, p.y)) {
    if (Samples.play(state.cat, layer.tex, slot, v, pan, state.knobs.variation, layer.gain)) { fromSamples++; continue; }
    const c = makeCtx(v, pan, 0.5, { intensity: 0.55, tone: 0.5, pitch: 0.5, variation: state.knobs.variation }, false);
    c.out.gain.value *= layer.gain;
    LIB[state.cat].play(SYNTH_KEY[slot], c, layer.tex);
    fromSynth++;
  }
  cueEvents.push({ t: performance.now(), slot, hand, vel });
  lightSlot(slot, hand);
  const name = $("lastName");
  name.textContent = `${CATS[state.cat].slots[slot]} · ${blendSummary()}`;
  name.className = "big " + (hand === "center" ? "" : hand);
  const who = hand === "center" ? "Test" : hand === "left" ? "Left hand" : "Right hand";
  const src = fromSamples && fromSynth ? `${fromSamples} sample + ${fromSynth} synth layers` : fromSamples ? `${fromSamples} sample layer${fromSamples > 1 ? "s" : ""}` : `${fromSynth} synth layer${fromSynth > 1 ? "s" : ""}`;
  $("lastMeta").textContent = `${who} · velocity ${Math.round(1 + vel * 126)}/127 · ${src}`;
}

/* ------------------------------------------------------------- controls */

$("touch").addEventListener("input", (e) => { state.touch = +e.target.value; $("touchOut").textContent = state.touch.toFixed(2); });
$("volume").addEventListener("input", (e) => { state.volume = +e.target.value; setVolume(state.volume); $("volOut").textContent = Math.round(state.volume * 100) + "%"; });
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.target.classList?.contains("knob") || e.target.id === "pad") return;
  if (e.key >= "1" && e.key <= String(CAT_KEYS.length)) selectCategory(CAT_KEYS[+e.key - 1]);
});
window.addEventListener("resize", () => renderPad());

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

  // Steering: the palm of the left hand (or the only hand) moves the blend point.
  if (state.steer) {
    const hand = hands.get("left") || hands.get("right");
    if (hand?.ready) {
      const P = hand.pts;
      const px = (P[0].x + P[5].x + P[9].x + P[17].x) / 4 / aspect, py = (P[0].y + P[5].y + P[9].y + P[17].y) / 4;
      const tx = clamp(((1 - px) - 0.2) / 0.6), ty = clamp((py - 0.15) / 0.6);   // middle 60% of the frame covers the pad
      const p = pad();
      setPoint(p.x + 0.35 * (tx - p.x), p.y + 0.35 * (ty - p.y));
    }
  }

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
    const closeness = clamp((release + 0.4 - s.r) / 0.4);
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
  const span = 8000, padL = 70, padR = 12, top = 8, bottom = 22;
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
Promise.all([Samples.restore((ck) => state.pads[ck]?.corners[0]), Samples.loadBundled()]).then(([mine, bundled]) => {
  if (mine || bundled) {
    note(`${mine ? `${mine} of your samples restored` : ""}${mine && bundled ? ", " : ""}${bundled ? `${bundled} bundled samples loaded` : ""}.`);
    refreshCounts();
  }
});
(function idle(now) { if ($("gate").hidden) return; drawCue(now); requestAnimationFrame(idle); })(performance.now());
