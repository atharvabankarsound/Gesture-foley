import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { Hand, SLOTS, TIP } from "./gestures.js";
import { A, FOLDERS, FOLDER_KEYS, textureList, hasTexture, textureLabel, render, createAudio, initAudio, makeCtx,
  setChannel, setRoom, setVolume, dbToGain } from "./sounds.js";
import { cornerWeights, layers } from "./blend.js";
import { FACTORY } from "./templates.js";
import * as Samples from "./samples.js";

const MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COL = { left: css("--left"), right: css("--right"), accent: css("--accent") };
const CORNER_COL = ["#0a84ff", "#30d1c4", "#ff9f0a", "#bf5af2"];      // top-left, top-right, bottom-left, bottom-right
const CORNER_POS = ["Top left", "Top right", "Bottom left", "Bottom right"];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : a));
const FINGER = { index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky" };
const SLOT_ALIAS = { index: ["index", "1", "first"], middle: ["middle", "2", "second"], ring: ["ring", "3", "third"], pinky: ["pinky", "little", "4", "fourth"] };
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const clone = (o) => JSON.parse(JSON.stringify(o));
const folderName = (ck) => FOLDERS[ck].name;
const slotName = (ck, slot) => FOLDERS[ck].slots[slot];

/* --------------------------------------------------------------- defaults */

const CLOTH_DEFAULT = ["cotton.tshirt", "leather.jacket", "denim.jeans", "nylon.windbreaker"];
const META = {
  footsteps: { alias: ["footsteps", "footstep", "steps", "feet"], corners: ["gravel.fine", "puddle.shallow", "sneakers.hard", "wood.floorboard"], layer: { on: true, cat: "cloth", corners: CLOTH_DEFAULT } },
  cloth: { alias: ["cloth", "clothes", "clothing", "fabric"], corners: CLOTH_DEFAULT, layer: { on: false, cat: "jewellery", corners: ["keys.small", "coins.few", "chain.fine", "bells.small"] } },
  movement: { alias: ["movement", "movements", "whooshes"], corners: ["swish.hand", "heavy.swing", "blade.sword", "body.spin"], layer: { on: true, cat: "cloth", corners: ["cotton.tshirt", "leather.jacket", "nylon.windbreaker", "wool.coat"] } },
  impacts: { alias: ["impacts", "impact", "fights", "punches"], corners: ["flesh.face", "flesh.body", "wood.plank", "ground.dirt"], layer: { on: true, cat: "cloth", corners: ["leather.jacket", "denim.jacket", "cotton.tshirt", "wool.jumper"] } },
  props: { alias: ["props", "objects"], corners: ["door.wood", "drawer.wood", "paper.sheet", "glassware.bottle"], layer: { on: false, cat: "cloth", corners: CLOTH_DEFAULT } },
  guns: { alias: ["guns", "gun", "weapons", "firearms"], corners: ["pistol.indoor", "rifle.outdoor", "shotgun.pump", "silenced.pistol"], layer: { on: false, cat: "movement", corners: ["swish.hand", "swish.arm", "body.dodge", "body.spin"] } },
  jewellery: { alias: ["jewellery", "jewelry", "jewels", "trinkets"], corners: ["keys.small", "coins.few", "chain.fine", "bells.small"], layer: { on: false, cat: "cloth", corners: CLOTH_DEFAULT } },
  elements: { alias: ["elements", "weather"], corners: ["water.puddle", "fire.torch", "wind.gust", "rain.light"], layer: { on: false, cat: "cloth", corners: CLOTH_DEFAULT } },
  creatures: { alias: ["creatures", "animals", "creatureshorses"], corners: ["horse.cobble", "dog.wood", "beast.stone", "bird.small"], layer: { on: false, cat: "jewellery", corners: ["chain.heavy", "bells.small", "keys.small", "chain.fine"] } },
  cinematic: { alias: ["cinematic", "cinematics", "trailer"], corners: ["epic.hit", "deep.sub", "metal.clang", "scifi.laser"], layer: { on: false, cat: "movement", corners: ["heavy.swing", "heavy.sweep", "swish.arm", "cape.cloak"] } },
};
for (const ck of FOLDER_KEYS) META[ck].alias.push(norm(folderName(ck)));

function defaultFolder(ck) {
  const m = META[ck];
  return {
    main: { corners: [...m.corners], x: 0.5, y: 0.5 },
    layer: { on: m.layer.on, cat: m.layer.cat, corners: [...m.layer.corners], x: 0.5, y: 0.5, follow: "index" },
    size: 0.5,
    template: "default",
  };
}
const DEFAULT_MIXER = { main: { db: 0, pan: 0, mute: false, solo: false }, layer: { db: -8, pan: 0, mute: false, solo: false }, room: { db: -12 }, master: { db: -2 } };

/* ------------------------------------------------------------ validation */

const validCorners = (ck, corners, fallback) =>
  Array.isArray(corners) && corners.length === 4 && corners.every((k) => typeof k === "string" && hasTexture(ck, k)) ? [...corners] : [...fallback];

function sanitizeFolder(ck, s) {
  const d = defaultFolder(ck);
  if (!s || typeof s !== "object") return d;
  const lcat = FOLDERS[s.layer?.cat] ? s.layer.cat : d.layer.cat;
  return {
    main: { corners: validCorners(ck, s.main?.corners, d.main.corners), x: clamp(s.main?.x ?? 0.5), y: clamp(s.main?.y ?? 0.5) },
    layer: {
      on: !!s.layer?.on,
      cat: lcat,
      corners: validCorners(lcat, s.layer?.corners, lcat === d.layer.cat ? d.layer.corners : META[lcat].corners),
      x: clamp(s.layer?.x ?? 0.5), y: clamp(s.layer?.y ?? 0.5),
      follow: s.layer?.follow === "same" || SLOTS.includes(s.layer?.follow) ? s.layer.follow : "index",
    },
    size: clamp(s.size ?? 0.5),
    template: typeof s.template === "string" ? s.template : null,
  };
}

function sanitizeMixer(m, base = DEFAULT_MIXER) {
  const out = clone(base);
  if (!m || typeof m !== "object") return out;
  for (const k of ["main", "layer", "room", "master"]) {
    const src = m[k];
    if (!src || typeof src !== "object") continue;
    if (Number.isFinite(+src.db)) out[k].db = clamp(+src.db, -40, 6);
    if ("pan" in out[k] && Number.isFinite(+src.pan)) out[k].pan = clamp(+src.pan, -1, 1);
    if ("mute" in out[k] && "mute" in src) out[k].mute = !!src.mute;
    if ("solo" in out[k] && "solo" in src) out[k].solo = !!src.solo;
  }
  return out;
}

/* ------------------------------------------------------------------ state */

const KNOBS = [
  { k: "variation", label: "Variation", def: 0.4, fmt: (v) => Math.round(v * 100) + "%" },
  { k: "dynamics", label: "Dynamics", def: 0.7, fmt: (v) => Math.round(v * 100) + "%" },
];

const state = {
  cat: "footsteps",
  touch: 0.22,
  steer: false,
  knobs: Object.fromEntries(KNOBS.map((m) => [m.k, m.def])),
  mixer: clone(DEFAULT_MIXER),
  folders: Object.fromEntries(FOLDER_KEYS.map((k) => [k, defaultFolder(k)])),
};
const F = () => state.folders[state.cat];

try {
  const saved = JSON.parse(localStorage.getItem("gf-state-v2") || "null");
  if (saved) {
    if (FOLDERS[saved.cat]) state.cat = saved.cat;
    for (const k of FOLDER_KEYS) if (saved.folders?.[k]) state.folders[k] = sanitizeFolder(k, saved.folders[k]);
    state.mixer = sanitizeMixer(saved.mixer);
    for (const m of KNOBS) if (Number.isFinite(+saved.knobs?.[m.k])) state.knobs[m.k] = clamp(saved.knobs[m.k]);
    if (Number.isFinite(+saved.touch)) state.touch = clamp(saved.touch, 0.12, 0.4);
  }
} catch { /* storage unavailable */ }

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem("gf-state-v2", JSON.stringify({ cat: state.cat, folders: state.folders, mixer: state.mixer, knobs: state.knobs, touch: state.touch })); } catch { /* ignore */ }
  }, 300);
}

/** Something about the folder changed by hand: it no longer matches the loaded template. */
function edited() {
  if (F().template !== null) { F().template = null; renderTemplates(); }
  save();
}

/* ------------------------------------------------------------------- pads */

function fit(c, g) {
  const dpr = window.devicePixelRatio || 1, r = c.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [r.width, r.height];
}

class Pad {
  /** @param box container; get() returns {corners, x, y}; folder() returns the folder key */
  constructor(box, get, folder, onChange) {
    this.box = box; this.get = get; this.folder = folder; this.onChange = onChange;
    this.el = box.querySelector(".pad");
    this.canvas = this.el.querySelector("canvas");
    this.g = this.canvas.getContext("2d");
    this.puck = this.el.querySelector(".puck");
    this.rows = [box.querySelector('.corners[data-row="top"]'), box.querySelector('.corners[data-row="bottom"]')];
    const fromEvent = (e) => {
      const r = this.el.getBoundingClientRect();
      this.set((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    this.el.addEventListener("pointerdown", (e) => { this.el.setPointerCapture(e.pointerId); fromEvent(e); });
    this.el.addEventListener("pointermove", (e) => { if (this.el.hasPointerCapture(e.pointerId)) fromEvent(e); });
    this.el.addEventListener("dblclick", () => this.set(0.5, 0.5));
    this.el.addEventListener("keydown", (e) => {
      const s = this.get(), st = e.shiftKey ? 0.1 : 0.04;
      const mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (mv) { e.preventDefault(); e.stopPropagation(); this.set(s.x + mv[0], s.y + mv[1]); }
    });
  }

  set(x, y, quiet = false) {
    const s = this.get();
    s.x = clamp(x); s.y = clamp(y);
    this.draw();
    if (!quiet) this.onChange("point");
  }

  renderCorners() {
    const s = this.get(), ck = this.folder(), list = textureList(ck);
    this.rows.forEach((row) => (row.innerHTML = ""));
    s.corners.forEach((key, i) => {
      const el = document.createElement("div");
      el.className = "corner";
      const prev = document.createElement("button"), next = document.createElement("button");
      prev.type = next.type = "button";
      prev.className = next.className = "arrow";
      prev.textContent = "◀"; next.textContent = "▶";
      prev.setAttribute("aria-label", `${CORNER_POS[i]}: previous sound`);
      next.setAttribute("aria-label", `${CORNER_POS[i]}: next sound`);
      const dot = document.createElement("i");
      dot.style.background = CORNER_COL[i];
      const sel = document.createElement("select");
      sel.className = "plain";
      sel.setAttribute("aria-label", `${CORNER_POS[i]} corner sound`);
      let group = null, last = "";
      for (const t of list) {
        if (t.texName !== last) { group = document.createElement("optgroup"); group.label = t.texName; sel.appendChild(group); last = t.texName; }
        const o = document.createElement("option");
        o.value = t.key; o.textContent = t.label;
        group.appendChild(o);
      }
      sel.value = key;
      sel.title = textureLabel(ck, key);
      sel.addEventListener("change", () => { s.corners[i] = sel.value; this.renderCorners(); this.draw(); this.onChange("corners"); });
      const cycle = (dir) => {
        let idx = list.findIndex((t) => t.key === s.corners[i]);
        for (let n = 0; n < list.length; n++) {
          idx = (idx + dir + list.length) % list.length;
          if (!s.corners.some((k, j) => j !== i && k === list[idx].key)) break;
        }
        s.corners[i] = list[idx].key;
        this.renderCorners(); this.draw(); this.onChange("corners");
      };
      prev.addEventListener("click", () => cycle(-1));
      next.addEventListener("click", () => cycle(1));
      if (i % 2 === 0) el.append(prev, dot, sel, next); else el.append(prev, sel, dot, next);
      this.rows[i < 2 ? 0 : 1].appendChild(el);
    });
  }

  draw() {
    const s = this.get(), g = this.g;
    this.puck.style.left = s.x * 100 + "%";
    this.puck.style.top = s.y * 100 + "%";
    const [w, h] = fit(this.canvas, g);
    if (!w) return;
    g.clearRect(0, 0, w, h);
    const wts = cornerWeights(s.x, s.y);
    const pts = [[0, 0], [w, 0], [0, h], [w, h]];
    pts.forEach(([cx, cy], i) => {
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.95);
      grad.addColorStop(0, CORNER_COL[i] + Math.round((0.08 + 0.5 * wts[i]) * 255).toString(16).padStart(2, "0"));
      grad.addColorStop(1, CORNER_COL[i] + "00");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    });
    g.strokeStyle = "rgba(255,255,255,0.09)";
    g.lineWidth = 1;
    for (const [cx, cy] of pts) { g.beginPath(); g.arc(cx, cy, w * 0.82, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2, h); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    pts.forEach(([cx, cy], i) => {
      if (wts[i] < 0.04) return;
      g.strokeStyle = CORNER_COL[i];
      g.globalAlpha = 0.25 + 0.6 * wts[i];
      g.lineWidth = 1 + 3 * wts[i];
      g.beginPath(); g.moveTo(s.x * w, s.y * h); g.lineTo(cx, cy); g.stroke();
    });
    g.globalAlpha = 1;
    // share of each corner, printed inside the pad
    g.font = "600 11px ui-monospace, Menlo, monospace";
    g.fillStyle = "rgba(245,245,247,0.75)";
    const pad = 8;
    [["left", "top"], ["right", "top"], ["left", "bottom"], ["right", "bottom"]].forEach(([ax, ay], i) => {
      g.textAlign = ax; g.textBaseline = ay;
      g.fillText(Math.round(wts[i] * 100) + "%", ax === "left" ? pad : w - pad, ay === "top" ? pad : h - pad);
    });
    const summary = layers(s.corners, s.x, s.y).map((l) => `${textureLabel(this.folder(), l.tex)} ${Math.round(l.w * 100)}%`).join(", ");
    this.el.setAttribute("aria-description", summary);
  }
}

const mainPad = new Pad($("mainBox"), () => F().main, () => state.cat, (what) => {
  edited();
  if (what === "corners") { renderSlots(); renderLibrary(); }
});
const layerPad = new Pad($("layerBox"), () => F().layer, () => F().layer.cat, () => edited());

$("centreBtn").addEventListener("click", () => mainPad.set(0.5, 0.5));
$("diceBtn").addEventListener("click", () => {
  const all = textureList(state.cat).map((t) => t.key);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  F().main.corners = all.slice(0, 4);
  mainPad.renderCorners();
  mainPad.set(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6);
  renderSlots(); renderLibrary();
});
$("steer").addEventListener("change", (e) => { state.steer = e.target.checked; });

/* ---------------------------------------------------------------- folders */

const FOLDER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.5"/></svg>';

function renderFolders() {
  const box = $("cats");
  box.innerHTML = "";
  for (const ck of FOLDER_KEYS) {
    const n = Samples.countFolder(ck);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat-btn";
    b.setAttribute("aria-pressed", String(ck === state.cat));
    b.innerHTML = `${FOLDER_SVG}<span></span><span class="count${n ? " has" : ""}">${n ? n : "synth"}</span>`;
    b.querySelector("span").textContent = folderName(ck);
    b.addEventListener("click", () => selectCategory(ck));
    box.appendChild(b);
  }
}

function selectCategory(ck) {
  state.cat = ck;
  $("stageCat").textContent = folderName(ck);
  $("libCat").textContent = folderName(ck);
  renderAll();
  save();
}

function renderAll() {
  renderFolders();
  renderTemplates();
  mainPad.renderCorners(); mainPad.draw();
  renderLayer();
  renderSize();
  renderSlots();
  renderLibrary();
}

/* ------------------------------------------------------------------ layer */

(() => {
  const sel = $("layerCat");
  for (const ck of FOLDER_KEYS) { const o = document.createElement("option"); o.value = ck; o.textContent = folderName(ck); sel.appendChild(o); }
  sel.addEventListener("change", () => {
    const L = F().layer;
    L.cat = sel.value;
    L.corners = [...(META[sel.value].layer.cat === sel.value ? META[sel.value].layer.corners : META[sel.value].corners)];
    L.x = 0.5; L.y = 0.5;
    renderLayer();
    edited();
  });
  $("layerFollow").addEventListener("change", (e) => { F().layer.follow = e.target.value; edited(); });
  $("layerOn").addEventListener("change", (e) => { F().layer.on = e.target.checked; renderLayer(); applyMixer(); edited(); });
})();

function renderLayer() {
  const L = F().layer;
  $("layerOn").checked = L.on;
  $("layerCat").value = L.cat;
  const fol = $("layerFollow");
  fol.innerHTML = "";
  const same = document.createElement("option");
  same.value = "same"; same.textContent = "Same finger";
  fol.appendChild(same);
  for (const s of SLOTS) {
    const o = document.createElement("option");
    o.value = s; o.textContent = `${slotName(L.cat, s)} on every hit`;
    fol.appendChild(o);
  }
  fol.value = L.follow;
  $("layerBox").querySelector(".layer-body").classList.toggle("pad-off", !L.on);
  layerPad.renderCorners(); layerPad.draw();
}

/* ------------------------------------------------------------------- size */

const sizeWord = (v) => (v < 0.2 ? "Small" : v < 0.4 ? "Smallish" : v <= 0.6 ? "Medium" : v <= 0.8 ? "Large" : "Huge");
function renderSize() {
  $("size").value = F().size;
  $("sizeOut").textContent = sizeWord(F().size);
}
$("size").addEventListener("input", (e) => { F().size = +e.target.value; $("sizeOut").textContent = sizeWord(F().size); edited(); });

/* ------------------------------------------------------------ finger slots */

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
    el.querySelector(".mini").addEventListener("click", async () => { await initAudio(); applyMixer(); trigger(slot, "center", 0.8); });
    slotEls[slot] = el;
    box.appendChild(el);
  });
}

function renderSlots() {
  const corners = [...new Set(F().main.corners)];
  for (const slot of SLOTS) {
    const el = slotEls[slot];
    el.querySelector(".snd").textContent = slotName(state.cat, slot);
    const withSamples = corners.filter((k) => Samples.count(state.cat, k, slot));
    const src = el.querySelector(".src");
    src.innerHTML = "";
    if (withSamples.length) {
      const b = document.createElement("b");
      b.textContent = `${withSamples.length} of ${corners.length} corners sampled`;
      src.append(b);
    } else src.textContent = "Synth placeholder";
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

/* ------------------------------------------------------------------ mixer */

const STRIPS = [
  { k: "main", name: "Main", pan: true, ms: true },
  { k: "layer", name: "Layer", pan: true, ms: true },
  { k: "room", name: "Room", pan: false, ms: false },
  { k: "master", name: "Master", pan: false, ms: false },
];
const fmtDb = (db) => (db <= -40 ? "−∞ dB" : `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`);
const fmtPan = (p) => (Math.abs(p) < 0.025 ? "C" : (p < 0 ? "L" : "R") + Math.round(Math.abs(p) * 100));
const stripEls = {};

function buildMixer() {
  const box = $("mixer");
  for (const s of STRIPS) {
    const el = document.createElement("div");
    el.className = "strip";
    el.innerHTML = `<span class="sname">${s.name}</span>
      <span class="btns">${s.ms ? `<button type="button" class="ms" data-k="mute" aria-label="Mute ${s.name}">M</button><button type="button" class="ms" data-k="solo" aria-label="Solo ${s.name}">S</button>` : ""}</span>
      <output></output>
      <input class="lvl" type="range" min="-40" max="6" step="0.5" aria-label="${s.name} level">
      ${s.pan ? `<div class="panl"><span>Pan</span><input type="range" min="-1" max="1" step="0.05" aria-label="${s.name} pan"><output></output></div>` : ""}`;
    const ch = () => state.mixer[s.k];
    el.querySelector(".lvl").addEventListener("input", (e) => { ch().db = +e.target.value; renderMixer(); applyMixer(); save(); });
    el.querySelector(".lvl").addEventListener("dblclick", () => { ch().db = DEFAULT_MIXER[s.k].db; renderMixer(); applyMixer(); save(); });
    if (s.pan) {
      const pan = el.querySelector(".panl input");
      pan.addEventListener("input", (e) => { ch().pan = +e.target.value; renderMixer(); applyMixer(); save(); });
      pan.addEventListener("dblclick", () => { ch().pan = 0; renderMixer(); applyMixer(); save(); });
    }
    el.querySelectorAll(".ms").forEach((b) => b.addEventListener("click", () => { ch()[b.dataset.k] = !ch()[b.dataset.k]; renderMixer(); applyMixer(); save(); }));
    stripEls[s.k] = el;
    box.appendChild(el);
  }
}

const anySolo = () => state.mixer.main.solo || state.mixer.layer.solo;
const audible = (k) => { const c = state.mixer[k]; return !c.mute && !(anySolo() && !c.solo) && c.db > -40; };

function renderMixer() {
  for (const s of STRIPS) {
    const el = stripEls[s.k], c = state.mixer[s.k];
    el.querySelector(".lvl").value = c.db;
    el.querySelector(":scope > output").textContent = fmtDb(c.db);
    if (s.pan) { el.querySelector(".panl input").value = c.pan; el.querySelector(".panl output").textContent = fmtPan(c.pan); }
    el.querySelectorAll(".ms").forEach((b) => b.setAttribute("aria-pressed", String(!!c[b.dataset.k])));
    el.classList.toggle("dim", s.ms ? !audible(s.k) || (s.k === "layer" && !F().layer.on) : c.db <= -40);
  }
}

function applyMixer() {
  if (!A.ctx) return;
  const m = state.mixer;
  const gain = (k) => (audible(k) ? dbToGain(m[k].db) : 0);
  setChannel("main", gain("main"), m.main.pan);
  setChannel("layer", gain("layer"), m.layer.pan);
  setRoom(m.room.db <= -40 ? 0 : dbToGain(m.room.db));
  setVolume(m.master.db <= -40 ? 0 : dbToGain(m.master.db));
}

/* ------------------------------------------------------------------ knobs */

function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
const A0 = Math.PI * 0.75, SWEEP = Math.PI * 1.5;
const knobSetters = {};

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
    const set = (v, persist = true) => {
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
      if (persist) save();
    };
    knobSetters[m.k] = set;
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
    set(state.knobs[m.k], false);
    box.appendChild(el);
  }
}

/* -------------------------------------------------------------- templates */

let userTpls = [];
try {
  const raw = JSON.parse(localStorage.getItem("gf-templates") || "[]");
  if (Array.isArray(raw)) userTpls = raw.map(sanitizeTemplate).filter(Boolean);
} catch { /* storage unavailable */ }
const saveUserTpls = () => { try { localStorage.setItem("gf-templates", JSON.stringify(userTpls)); } catch { /* ignore */ } };
const tplNote = (msg) => { $("tplNote").textContent = msg; };

function sanitizeTemplate(t) {
  if (!t || typeof t !== "object" || !FOLDERS[t.cat]) return null;
  const name = String(t.name || "").trim().slice(0, 40);
  if (!name) return null;
  const f = sanitizeFolder(t.cat, t);
  const out = { name, cat: t.cat, main: f.main, layer: f.layer, size: f.size };
  if (t.mixer) out.mixer = sanitizeMixer(t.mixer);
  if (t.knobs) out.knobs = Object.fromEntries(KNOBS.filter((m) => Number.isFinite(+t.knobs[m.k])).map((m) => [m.k, clamp(t.knobs[m.k])]));
  return out;
}

function templateOptions(ck) {
  return [
    { id: "default", name: "Default", group: "Factory" },
    ...FACTORY.filter((t) => t.cat === ck).map((t) => ({ id: "f:" + t.name, name: t.name, group: "Factory" })),
    ...userTpls.filter((t) => t.cat === ck).map((t) => ({ id: "u:" + t.name, name: t.name, group: "My templates" })),
  ];
}

function findTemplate(ck, id) {
  if (id === "default") return { name: "Default", cat: ck, ...defaultFolder(ck), mixer: { layer: { db: DEFAULT_MIXER.layer.db } }, factory: true };
  if (id.startsWith("f:")) { const t = FACTORY.find((t) => t.cat === ck && t.name === id.slice(2)); return t ? { ...t, factory: true } : null; }
  if (id.startsWith("u:")) return userTpls.find((t) => t.cat === ck && t.name === id.slice(2)) || null;
  return null;
}

function renderTemplates() {
  const sel = $("tplSelect"), opts = templateOptions(state.cat), cur = F().template;
  sel.innerHTML = "";
  if (cur === null || !opts.some((o) => o.id === cur)) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "Custom (not saved)"; o.disabled = true;
    sel.appendChild(o);
  }
  const groups = {};
  for (const o of opts) {
    if (!groups[o.group]) { groups[o.group] = document.createElement("optgroup"); groups[o.group].label = o.group; sel.appendChild(groups[o.group]); }
    const el = document.createElement("option");
    el.value = o.id; el.textContent = o.name;
    groups[o.group].appendChild(el);
  }
  sel.value = cur && opts.some((o) => o.id === cur) ? cur : "";
  $("tplDelete").disabled = !(cur || "").startsWith("u:");
}

function applyTemplate(id) {
  const t = findTemplate(state.cat, id);
  if (!t) return;
  const f = sanitizeFolder(state.cat, t);
  f.template = id;
  state.folders[state.cat] = f;
  if (t.factory) {
    // Factory templates set the layer level; everything else in the mixer stays as it is.
    state.mixer.layer.db = t.mixer?.layer?.db ?? DEFAULT_MIXER.layer.db;
  } else if (t.mixer) state.mixer = sanitizeMixer(t.mixer);
  if (t.knobs) for (const [k, v] of Object.entries(t.knobs)) knobSetters[k]?.(v, false);
  renderAll(); renderMixer(); applyMixer(); save();
  tplNote(`Loaded “${t.name}”.`);
}

$("tplSelect").addEventListener("change", (e) => { if (e.target.value) applyTemplate(e.target.value); });
const stepTemplate = (dir) => {
  const opts = templateOptions(state.cat), i = opts.findIndex((o) => o.id === F().template);
  applyTemplate(opts[(i + dir + opts.length) % opts.length].id);
};
$("tplPrev").addEventListener("click", () => stepTemplate(-1));
$("tplNext").addEventListener("click", () => stepTemplate(1));

$("tplSave").addEventListener("click", () => {
  const cur = F().template || "";
  $("tplName").value = cur.startsWith("u:") ? cur.slice(2) : "";
  $("tplSaveRow").hidden = false;
  $("tplName").focus();
});
$("tplSaveCancel").addEventListener("click", () => { $("tplSaveRow").hidden = true; });
$("tplName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("tplSaveOk").click(); if (e.key === "Escape") $("tplSaveCancel").click(); });
$("tplSaveOk").addEventListener("click", () => {
  const name = $("tplName").value.trim().slice(0, 40);
  if (!name) { tplNote("Type a name for the template first."); $("tplName").focus(); return; }
  const t = sanitizeTemplate({ name, cat: state.cat, ...clone(F()), mixer: clone(state.mixer), knobs: { ...state.knobs } });
  const i = userTpls.findIndex((u) => u.cat === state.cat && u.name === name);
  if (i >= 0) userTpls[i] = t; else userTpls.push(t);
  saveUserTpls();
  F().template = "u:" + name;
  $("tplSaveRow").hidden = true;
  renderTemplates(); save();
  tplNote(i >= 0 ? `Updated “${name}”.` : `Saved “${name}” in ${folderName(state.cat)}.`);
});

let deleteArmed = false;
$("tplDelete").addEventListener("click", () => {
  const cur = F().template || "";
  if (!cur.startsWith("u:")) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $("tplDelete").textContent = "Click again to delete";
    setTimeout(() => { deleteArmed = false; $("tplDelete").textContent = "Delete this template"; }, 3000);
    return;
  }
  deleteArmed = false;
  $("tplDelete").textContent = "Delete this template";
  userTpls = userTpls.filter((t) => !(t.cat === state.cat && t.name === cur.slice(2)));
  saveUserTpls();
  F().template = null;
  renderTemplates(); save();
  tplNote(`Deleted “${cur.slice(2)}”.`);
  $("tplDelete").closest("details").open = false;
});

$("tplExport").addEventListener("click", () => {
  if (!userTpls.length) { tplNote("You haven't saved any templates yet."); return; }
  const blob = new Blob([JSON.stringify({ app: "gesture-foley", version: 2, templates: userTpls }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gesture-foley-templates.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  tplNote(`Exported ${userTpls.length} template${userTpls.length > 1 ? "s" : ""}.`);
  $("tplExport").closest("details").open = false;
});
$("tplImport").addEventListener("click", () => { $("tplFile").click(); $("tplImport").closest("details").open = false; });
$("tplFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = (Array.isArray(data) ? data : data.templates || []).map(sanitizeTemplate).filter(Boolean);
    for (const t of list) {
      const i = userTpls.findIndex((u) => u.cat === t.cat && u.name === t.name);
      if (i >= 0) userTpls[i] = t; else userTpls.push(t);
    }
    saveUserTpls();
    renderTemplates();
    tplNote(list.length ? `Imported ${list.length} template${list.length > 1 ? "s" : ""}.` : "That file had no templates this page can read.");
  } catch {
    tplNote("That file isn't a Gesture Foley templates file.");
  }
});

/* ---------------------------------------------------------- sound library */

const note = (msg) => { $("sampleNote").textContent = msg; };
let pendingCell = null;

function renderLibrary() {
  const table = $("libTable"), corners = F().main.corners;
  table.innerHTML = "";
  const head = table.createTHead().insertRow();
  const th0 = document.createElement("th");
  th0.textContent = "Sound";
  head.appendChild(th0);
  for (const slot of SLOTS) {
    const th = document.createElement("th");
    th.innerHTML = `Thumb + ${FINGER[slot]}<span></span>`;
    th.querySelector("span").textContent = slotName(state.cat, slot);
    head.appendChild(th);
  }
  const tbody = table.createTBody();
  let last = "";
  for (const t of textureList(state.cat)) {
    if (t.texName !== last) {
      const gr = tbody.insertRow();
      gr.className = "group";
      const th = document.createElement("th");
      th.colSpan = 5; th.textContent = t.texName;
      gr.appendChild(th);
      last = t.texName;
    }
    const row = tbody.insertRow();
    const th = document.createElement("th");
    th.scope = "row";
    const dot = document.createElement("i");
    const ci = corners.indexOf(t.key);
    if (ci >= 0) { dot.style.background = CORNER_COL[ci]; dot.style.borderColor = CORNER_COL[ci]; dot.title = `${CORNER_POS[ci]} corner`; }
    th.append(dot, t.name);
    row.appendChild(th);
    for (const slot of SLOTS) {
      const td = row.insertCell();
      const items = Samples.list(state.cat, t.key, slot);
      const cell = document.createElement("div");
      cell.className = "cell";
      const add = document.createElement("button");
      add.type = "button";
      add.className = "add" + (items.length ? " has" : "");
      add.textContent = items.length ? `${items.length} sample${items.length > 1 ? "s" : ""}` : "+ Add";
      add.title = items.length ? items.map((s) => s.name).join("\n") : `Add ${slotName(state.cat, slot)} samples for ${t.label}`;
      add.setAttribute("aria-label", `${t.label}, ${slotName(state.cat, slot)}: ${items.length ? items.length + " samples, add more" : "add samples"}`);
      add.addEventListener("click", () => { pendingCell = { key: t.key, slot }; $("cellInput").click(); });
      cell.appendChild(add);
      if (items.length) {
        const x = document.createElement("button");
        x.type = "button"; x.className = "x"; x.textContent = "×";
        x.setAttribute("aria-label", `Remove ${t.label} ${slotName(state.cat, slot)} samples`);
        x.addEventListener("click", async () => {
          await Samples.clearCell(state.cat, t.key, slot);
          note(`Removed ${t.label} · ${slotName(state.cat, slot)} samples.`);
          refreshCounts();
        });
        cell.appendChild(x);
      }
      cell.addEventListener("dragover", (e) => { e.preventDefault(); cell.classList.add("drag"); });
      cell.addEventListener("dragleave", () => cell.classList.remove("drag"));
      cell.addEventListener("drop", async (e) => { e.preventDefault(); cell.classList.remove("drag"); await addToCell(t.key, slot, [...e.dataTransfer.files]); });
      td.appendChild(cell);
    }
  }
}

function refreshCounts() { renderFolders(); renderSlots(); renderLibrary(); }

$("cellInput").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (pendingCell) await addToCell(pendingCell.key, pendingCell.slot, files);
  pendingCell = null;
});

async function addToCell(key, slot, files) {
  if (!files.length) return;
  createAudio();
  note(`Loading ${files.length} file${files.length > 1 ? "s" : ""}…`);
  const { added, failed } = await Samples.addFiles(state.cat, key, slot, files);
  let msg = `Added ${added} sample${added === 1 ? "" : "s"} to ${textureLabel(state.cat, key)} · ${slotName(state.cat, slot)}.`;
  if (failed.length) msg += ` Skipped ${failed.length}: ${failed.slice(0, 2).map((f) => `${f.name} (${f.reason})`).join(", ")}${failed.length > 2 ? "…" : ""}`;
  note(msg);
  refreshCounts();
}

/** Folder, sub-category and finger from a path like "Kit/Footsteps/Wood/Stairs/Step (thumb + index)/a.wav". */
export function route(path) {
  const segs = path.split("/").slice(0, -1).map(norm);
  let cat = null, at = -1;
  segs.forEach((s, i) => { for (const ck of FOLDER_KEYS) if (!cat && META[ck].alias.includes(s)) { cat = ck; at = i; } });
  if (!cat) return null;
  const T = FOLDERS[cat].textures;
  let tex = null;
  for (let i = at + 1; i < segs.length && !tex; i++) {
    for (const [tk, t] of Object.entries(T)) if (!tex && (norm(tk) === segs[i] || norm(t.name) === segs[i])) { tex = tk; at = i; }
  }
  if (!tex) return null;
  // Sub-category folder is optional: without one, files go to the texture's first sub-category.
  let variant = null;
  if (at + 1 < segs.length) {
    for (const [vk, v] of Object.entries(T[tex].variants)) if (!variant && (norm(vk) === segs[at + 1] || norm(v.name) === segs[at + 1])) variant = vk;
  }
  if (variant) at += 1; else variant = Object.keys(T[tex].variants)[0];
  // Exact match beats a contained word, and longer names win ("Long whoosh" over "Whoosh").
  let slot = null, best = 0;
  for (const s of segs.slice(at + 1)) {
    for (const sk of SLOTS) {
      for (const n of [...SLOT_ALIAS[sk], slotName(cat, sk)].map(norm)) {
        let score = 0;
        if (s === n) score = 1000 + n.length;
        else if (/^\d$/.test(n)) score = new RegExp(`(^|\\D)${n}(\\D|$)`).test(s) ? 1 : 0;
        else if (n.length > 2 && s.includes(n)) score = 10 + n.length;
        if (score > best) { best = score; slot = sk; }
      }
    }
  }
  return slot ? { cat, key: `${tex}.${variant}`, slot } : null;
}

$("folderBtn").addEventListener("click", () => $("folderInput").click());
$("folderInput").addEventListener("change", async (e) => {
  const files = [...e.target.files].filter((f) => Samples.AUDIO_EXT.test(f.name));
  e.target.value = "";
  if (!files.length) { note("No audio files found in that folder."); return; }
  createAudio();
  note(`Loading ${files.length} files…`);
  const groups = new Map();
  let unmatched = 0;
  for (const f of files) {
    const r = route(f.webkitRelativePath || f.name);
    if (!r) { unmatched++; continue; }
    const k = `${r.cat}/${r.key}/${r.slot}`;
    if (!groups.has(k)) groups.set(k, { ...r, files: [] });
    groups.get(k).files.push(f);
  }
  let added = 0, failed = 0;
  for (const g of groups.values()) {
    const res = await Samples.addFiles(g.cat, g.key, g.slot, g.files);
    added += res.added; failed += res.failed.length;
  }
  let msg = `Added ${added} samples to ${groups.size} cell${groups.size === 1 ? "" : "s"}.`;
  if (unmatched) msg += ` ${unmatched} files weren't in a matching folder (for example Footsteps/Wood/Stairs/Step).`;
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

/* --------------------------------------------------------------- trigger */

const cueEvents = [];

/** Play one finger sound from one pad: a voice per corner sub-category, mixed by the pad's point. */
function playPad(channel, cat, pad, slot, vel, pan, size) {
  let samples = 0, synth = 0;
  for (const l of layers(pad.corners, pad.x, pad.y)) {
    const o = { vel, pan, variation: state.knobs.variation, gain: l.gain, size, dest: A.ch[channel].g };
    if (Samples.play(cat, l.tex, slot, o)) { samples++; continue; }
    render(cat, slot, makeCtx(o), l.tex);
    synth++;
  }
  return { samples, synth };
}

function trigger(slot, hand, vel) {
  if (!A.ctx) return;
  if (A.ctx.state !== "running") A.ctx.resume();
  const f = F();
  const v = 1 - state.knobs.dynamics * (1 - vel);          // Dynamics 0 = every hit at full level
  const pan = hand === "left" ? -0.25 : hand === "right" ? 0.25 : 0;
  const main = playPad("main", state.cat, f.main, slot, v, pan, f.size);
  let layerText = "";
  if (f.layer.on) {
    const ls = f.layer.follow === "same" ? slot : f.layer.follow;
    playPad("layer", f.layer.cat, f.layer, ls, v * 0.9, pan, f.size);
    layerText = ` + ${folderName(f.layer.cat)} ${slotName(f.layer.cat, ls)}`;
  }
  cueEvents.push({ t: performance.now(), slot, hand, vel });
  lightSlot(slot, hand);
  const top = layers(f.main.corners, f.main.x, f.main.y).map((l) => `${textureLabel(state.cat, l.tex).split(" · ").pop()} ${Math.round(l.w * 100)}%`).join(" · ");
  const name = $("lastName");
  name.textContent = `${slotName(state.cat, slot)} · ${top}`;
  name.className = "big " + (hand === "center" ? "" : hand);
  const who = hand === "center" ? "Test" : hand === "left" ? "Left hand" : "Right hand";
  const src = main.samples ? `${main.samples} sample${main.synth ? ` + ${main.synth} synth` : ""}` : `${main.synth} synth`;
  $("lastMeta").textContent = `${who} · vel ${Math.round(1 + vel * 126)} · ${src}${layerText}`;
}

/* -------------------------------------------------------------- controls */

$("touch").value = state.touch;
$("touchOut").textContent = state.touch.toFixed(2);
$("touch").addEventListener("input", (e) => { state.touch = +e.target.value; $("touchOut").textContent = state.touch.toFixed(2); save(); });
window.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if ((tag === "INPUT" && e.target.type !== "range") || tag === "SELECT") return;
  if (e.target.classList?.contains("knob") || e.target.classList?.contains("pad")) return;
  const i = e.key === "0" ? 9 : e.key >= "1" && e.key <= "9" ? +e.key - 1 : -1;
  if (FOLDER_KEYS[i]) selectCategory(FOLDER_KEYS[i]);
});
window.addEventListener("resize", () => { mainPad.draw(); layerPad.draw(); });
document.addEventListener("click", (e) => {      // close the More menu when clicking elsewhere
  const d = document.querySelector(".more");
  if (d.open && !d.contains(e.target)) d.open = false;
});

/* ----------------------------------------------------------- hand tracker */

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
  await initAudio();
  applyMixer();
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

/* -------------------------------------------------------------- main loop */

const hands = new Map();
const flashes = [];
let lastVideoTime = -1, fps = 0, lastFrame = 0;
const overlay = $("overlay"), octx = overlay.getContext("2d");
const cue = $("cue"), cctx = cue.getContext("2d");
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

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

  // Steering: the palm of the left hand (or the only hand) moves the main pad's point.
  if (state.steer) {
    const hand = hands.get("left") || hands.get("right");
    if (hand?.ready) {
      const P = hand.pts;
      const px = (P[0].x + P[5].x + P[9].x + P[17].x) / 4 / aspect, py = (P[0].y + P[5].y + P[9].y + P[17].y) / 4;
      const tx = clamp((1 - px - 0.2) / 0.6), ty = clamp((py - 0.15) / 0.6);   // middle 60% of the frame covers the pad
      const m = F().main;
      mainPad.set(m.x + 0.35 * (tx - m.x), m.y + 0.35 * (ty - m.y), true);
      if (F().template !== null) edited(); else save();
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
  const span = 8000, padL = 74, padR = 12, top = 8, bottom = 22;
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
    cctx.fillText(slotName(state.cat, slot), 10, y + laneH / 2 + 4, padL - 14);
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

/* ------------------------------------------------------------------- boot */

/** Map samples saved by older versions onto today's sub-categories. */
function normaliseSaved(cat, tex) {
  if (!FOLDERS[cat]) return null;
  if (!tex) return META[cat].corners[0];
  if (hasTexture(cat, tex)) return tex;
  const T = FOLDERS[cat].textures[tex];
  return T ? `${tex}.${Object.keys(T.variants)[0]}` : null;
}

buildSlots();
buildKnobs();
buildMixer();
$("stageCat").textContent = folderName(state.cat);
$("libCat").textContent = folderName(state.cat);
renderAll();
renderMixer();
createAudio();                      // suspended until the first click; lets samples decode now
applyMixer();
Promise.all([Samples.restore(normaliseSaved), Samples.loadBundled()]).then(([mine, bundled]) => {
  if (mine || bundled) {
    note(`${mine ? `${mine} of your samples restored` : ""}${mine && bundled ? ", " : ""}${bundled ? `${bundled} bundled samples loaded` : ""}.`);
    refreshCounts();
  }
});
(function idle(now) { if ($("gate").hidden) return; drawCue(now); requestAnimationFrame(idle); })(performance.now());
