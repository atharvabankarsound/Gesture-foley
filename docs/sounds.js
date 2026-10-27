// Sound engine and catalogue.
//
// FOLDERS -> textures -> variants (sub-categories), e.g. footsteps / wood / stairs.
// A texture key used everywhere else is "texture.variant", e.g. "wood.stairs".
// Every sound here is synthesized live with the Web Audio API. They are placeholders:
// recorded samples (samples.js) replace them cell by cell.
//
// Signal flow:  layer voices -> size shelf -> pan -> channel (main | layer) -> bus
//               bus -> master  and  bus -> convolution reverb (room) -> master
//               master -> compressor -> speakers

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const fq = (f) => clamp(f, 20, 18000);
export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

export const A = { ctx: null, bus: null, master: null, wet: null, noise: null, ch: {} };

/* ------------------------------------------------------------------ engine */

/** Build the audio graph. Can run before any click (it stays suspended), so samples can be decoded early. */
export function createAudio(volume = 0.8) {
  if (A.ctx) return A.ctx;
  const ctx = (A.ctx = new AudioContext({ latencyHint: "interactive" }));
  const comp = ctx.createDynamicsCompressor();      // glue + protects against clipping
  comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.15;
  A.master = ctx.createGain(); A.master.gain.value = volume;
  A.bus = ctx.createGain();
  const conv = ctx.createConvolver(); conv.buffer = impulse(2.6);
  A.wet = ctx.createGain(); A.wet.gain.value = 0.25;
  A.bus.connect(A.master);
  A.bus.connect(conv).connect(A.wet).connect(A.master);
  A.master.connect(comp).connect(ctx.destination);
  for (const name of ["main", "layer"]) {
    const g = ctx.createGain(), p = ctx.createStereoPanner();
    g.connect(p).connect(A.bus);
    A.ch[name] = { g, p };
  }
  A.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = A.noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Start audio after a click (browsers only allow sound after the user interacts). */
export function initAudio(volume = 0.8) {
  createAudio(volume);
  return A.ctx.resume();
}

function impulse(seconds) {
  // Stereo reverb tail: decaying noise, slightly different per channel for width.
  const ctx = A.ctx, n = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t / (seconds / 6)) * Math.min(1, t / 0.006);
    }
  }
  return buf;
}

const glide = (param, v) => param.setTargetAtTime(v, A.ctx.currentTime, 0.02);
export function setVolume(g) { if (A.master) glide(A.master.gain, g); }
export function setRoom(g) { if (A.wet) glide(A.wet.gain, g); }
export function setChannel(name, gain, pan) {
  const c = A.ch[name];
  if (!c) return;
  glide(c.g.gain, gain);
  glide(c.p.pan, clamp(pan, -1, 1));
}

/* -------------------------------------------------------------------- size */

/** Small (0) to Large (1): pitch from +4 to -4 semitones. */
export const sizePitch = (size) => Math.pow(2, ((0.5 - size) * 8) / 12);
/** Small removes low end, Large adds it. */
export function sizeShelf(size) {
  const f = A.ctx.createBiquadFilter();
  f.type = "lowshelf"; f.frequency.value = 220; f.gain.value = (size - 0.5) * 10;
  return f;
}

/**
 * One voice: gain from velocity, random level variation, size shelf and pan, into `dest`.
 * @param o {vel, pan, variation, size, dest, gain}
 */
export function makeCtx(o) {
  const ctx = A.ctx;
  const out = ctx.createGain();
  out.gain.value = 0.9 * (o.gain ?? 1) * (0.12 + 0.88 * Math.pow(o.vel, 1.4)) * Math.pow(10, (rand(-2, 2) * o.variation * 2) / 20);
  const shelf = sizeShelf(o.size), p = ctx.createStereoPanner();
  p.pan.value = clamp(o.pan, -1, 1);
  out.connect(shelf).connect(p).connect(o.dest || A.bus);
  setTimeout(() => { out.disconnect(); shelf.disconnect(); p.disconnect(); }, 9000);
  return {
    t: ctx.currentTime + 0.003,
    vel: o.vel,
    out,
    bright: (0.6 + 0.8 * o.vel) * (1.15 - 0.3 * o.size),
    pitch: sizePitch(o.size),
    vary: o.variation,
  };
}

// small random variation, scaled by the Variation knob
const rv = (c, amt) => 1 + (Math.random() * 2 - 1) * amt * c.vary * 2;

/* -------------------------------------------------------------- primitives */

function env(param, t, peak, att, dec, hold = 0) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + att);
  if (hold) param.setValueAtTime(peak, t + att + hold);
  param.setTargetAtTime(0, t + att + hold, dec);
}

function noiseSrc(t, dur) {
  const s = A.ctx.createBufferSource();
  s.buffer = A.noise;
  s.start(t, rand(0, 1.4));
  s.stop(t + dur + 0.05);
  return s;
}

/** Filtered noise burst. */
function nz(c, t, o) {
  const ctx = A.ctx, f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = o.type || "bandpass";
  f.frequency.setValueAtTime(fq(o.f), t);
  if (o.fEnd) f.frequency.setTargetAtTime(fq(o.fEnd), t, o.fTau || 0.1);
  f.Q.value = o.q ?? 0.707;
  env(g.gain, t, o.peak, o.att || 0.001, o.dec || 0.05, o.hold || 0);
  noiseSrc(t, o.dur || Math.max(0.4, (o.att || 0) + (o.hold || 0) + (o.dec || 0.05) * 7)).connect(f).connect(g).connect(o.dest || c.out);
}

/** Oscillator with pitch glide and envelope. */
function osc(c, t, o) {
  const ctx = A.ctx, s = ctx.createOscillator(), g = ctx.createGain();
  s.type = o.type || "sine";
  s.frequency.setValueAtTime(fq(o.f), t);
  if (o.fEnd) s.frequency.setTargetAtTime(fq(o.fEnd), t, o.fTau || 0.05);
  env(g.gain, t, o.peak, o.att || 0.001, o.dec || 0.1, o.hold || 0);
  s.connect(g).connect(o.dest || c.out);
  s.start(t);
  s.stop(t + (o.dur || Math.max(0.3, (o.dec || 0.1) * 7 + (o.hold || 0) + (o.att || 0))));
}

const curves = {};
/** tanh saturation stage; returns the node to connect into. */
function drive(c, amount, dest) {
  const key = amount.toFixed(2);
  if (!curves[key]) {
    const n = 1024, cv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; cv[i] = Math.tanh(amount * x) / Math.tanh(amount); }
    curves[key] = cv;
  }
  const ws = A.ctx.createWaveShaper();
  ws.curve = curves[key]; ws.oversample = "2x";
  ws.connect(dest || c.out);
  return ws;
}

/** Granular crackle: many tiny noise grains, clustered near the start. */
function grains(c, t, density, vel, peak, hp, dur = 0.35, spread = 3) {
  const ctx = A.ctx, sr = ctx.sampleRate, n = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const count = Math.min(600, Math.floor(density * (0.4 + vel)));
  for (let i = 0; i < count; i++) {
    const start = Math.floor((1 - Math.pow(Math.random(), 1 / spread)) * (n - 200));
    const g = Math.min(Math.floor(rand(0.0008, 0.003) * sr), n - start);
    const amp = rand(0.2, 1);
    for (let k = 0; k < g; k++) d[start + k] += (Math.random() * 2 - 1) * Math.exp(-k / (g / 4)) * amp;
  }
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = buf; f.type = "highpass"; f.frequency.value = fq(hp); g.gain.value = peak;
  s.connect(f).connect(g).connect(c.out);
  s.start(t);
}

/** Band-passed air movement with a filter sweep and optional pan sweep. */
function whoosh(c, t, o) {
  const ctx = A.ctx, bp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
  const dur = o.dur, F = fq(o.f * c.bright * c.pitch);
  bp.type = "bandpass"; bp.Q.value = o.q;
  bp.frequency.setValueAtTime(fq(F * 0.35), t);
  bp.frequency.exponentialRampToValueAtTime(F, t + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(fq(F * 0.45), t + dur);
  const peak = (o.peak ?? 0.8) * 2.5;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + dur * 0.45);
  g.gain.linearRampToValueAtTime(0, t + dur);
  p.pan.setValueAtTime(o.from || 0, t);
  p.pan.linearRampToValueAtTime(o.to || 0, t + dur);
  noiseSrc(t, dur).connect(bp).connect(g).connect(p).connect(c.out);
}

/** Resonant partials: wood, metal, glass bodies ringing. */
function ring(c, t, partials, dec, peak) {
  partials.forEach((f, i) => osc(c, t, { f: f * c.pitch * rv(c, 0.03), peak: peak / (i + 1), dec: dec / (1 + i * 0.4), dur: Math.max(0.3, dec * 7) }));
}

/** Low body thump with a downward pitch sweep. */
function thump(c, t, f, peak, dec, dest) {
  osc(c, t, { f: f * c.pitch * 2, fEnd: f * c.pitch, fTau: 0.015, peak, dec, dest });
}

function metalClick(c, t, f, peak) {
  nz(c, t, { type: "bandpass", f, q: 10, peak: peak * 3, dec: 0.006, dur: 0.1 });
  osc(c, t, { f: f * 1.31, peak: peak * 0.2, dec: 0.025 });
}

/** Creak: a slow sawtooth through a resonant band-pass (floorboards, leather, hinges). */
function creak(c, t, w, len = 0.15, f0 = 70) {
  const bp = A.ctx.createBiquadFilter();
  bp.type = "bandpass"; bp.frequency.value = 700 * c.pitch; bp.Q.value = 5; bp.connect(c.out);
  osc(c, t, { type: "sawtooth", f: f0 * c.pitch * rv(c, 0.1), fEnd: f0 * 1.6 * c.pitch, fTau: len / 2, peak: 0.4 * w, att: 0.03, dec: len, dest: bp });
}

/** Water: a filtered splash plus a few bubbles (short rising sine chirps). */
function splash(c, t, vel, w) {
  nz(c, t, { type: "bandpass", f: 1800 * c.bright, q: 0.7, peak: 0.9 * w, att: 0.004, dec: 0.08 + 0.05 * vel, dur: 0.6 });
  nz(c, t + 0.02, { type: "highpass", f: 3500, peak: 0.35 * w, att: 0.01, dec: 0.12, dur: 0.6 });
  const n = 3 + Math.floor(vel * 5);
  for (let i = 0; i < n; i++) bubble(c, t + 0.01 + Math.random() * 0.18, rand(0.08, 0.2) * w);
}
function bubble(c, t, peak, lo = 500, hi = 1300) {
  const f = rand(lo, hi) * c.pitch;
  osc(c, t, { f, fEnd: f * rand(1.4, 2.2), fTau: 0.012, peak, dec: rand(0.01, 0.03) });
}

/** Small metal objects: each hit is three inharmonic partials plus a tiny click. */
function tinkle(c, t, n, spread, fr, dec, w) {
  n = Math.min(n, 24);
  for (let i = 0; i < n; i++) {
    const tt = t + Math.pow(Math.random(), 1.6) * spread;
    const f = rand(fr[0], fr[1]) * c.pitch * Math.min(c.bright, 1.4);
    const a = (w * rand(0.4, 1)) / Math.sqrt(n);
    [1, 2.76, 5.4].forEach((m, j) => osc(c, tt, { f: f * m, peak: a / (j + 1.5), dec: dec / (1 + j * 0.6), dur: Math.max(0.2, dec * 8) }));
    nz(c, tt, { type: "highpass", f: 5000, peak: a * 0.5, dec: 0.002, dur: 0.05 });
  }
}

/* --------------------------------------------------------------- footsteps */

function filterOf(s, b) {
  const [type, fr] = s.noise;
  if (type === "bandpass") { const lo = fr[0] * b, hi = fr[1] * b, f = Math.sqrt(lo * hi); return { type, f, q: f / (hi - lo) }; }
  return { type, f: fr * b, q: 0.707 };
}

function footContact(c, t, s, vel, w) {
  const p = c.pitch * rv(c, 0.06);
  osc(c, t, { f: s.thumpF * p * 2.5, fEnd: s.thumpF * p, fTau: 0.012, peak: s.thumpGain * w, dec: s.thumpDecay });
  nz(c, t, { ...filterOf(s, c.bright), peak: s.nGain * w, att: s.nA, dec: s.nD * (0.7 + 0.6 * vel), dur: 0.4 });
  if (s.crunch) grains(c, t, s.crunch, vel, 0.5 * w, 1800);
  if (s.splash) splash(c, t, vel, w * s.splash);
  if (s.ring) ring(c, t, s.ring, 0.12, 0.18 * w);
  if (s.click) osc(c, t, { f: 2600 * c.pitch * rv(c, 0.05), peak: 0.35 * w * s.click, dec: 0.006 });
  if (s.creak) creak(c, t + 0.02, w * s.creak);
}

function scuff(c, t, s, w) {
  const f = filterOf(s, c.bright * 0.9);
  nz(c, t, { type: "bandpass", f: f.f * 0.8, fEnd: f.f * 1.3, fTau: 0.08, q: 1.2, peak: 1.1 * w, att: 0.02, dec: 0.09, dur: 0.4 });
  if (s.crunch) grains(c, t, s.crunch * 1.5, c.vel, 0.4 * w, 1500, 0.3);
  if (s.splash) splash(c, t, c.vel * 0.6, w * s.splash * 0.6);
  osc(c, t, { f: s.thumpF * c.pitch, peak: 0.2 * w, dec: 0.03 });
}

const footsteps = {
  name: "Footsteps",
  slots: { index: "Step", middle: "Scuff", ring: "Squeak", pinky: "Stomp" },
  textures: {
    concrete: { name: "Concrete", p: { thumpF: 85, thumpDecay: 0.025, thumpGain: 0.5, noise: ["lowpass", 3500], nA: 0.0005, nD: 0.02, nGain: 0.6, crunch: 0 },
      variants: { pavement: { name: "Pavement" }, garage: { name: "Garage", mod: { bright: 0.9 }, over: { echo: [0.06, 0.35] } }, tiles: { name: "Tiles", mod: { bright: 1.25 }, over: { nD: 0.012, click: 0.6 } } } },
    wood: { name: "Wood", p: { thumpF: 150, thumpDecay: 0.06, thumpGain: 0.8, noise: ["bandpass", [250, 1400]], nA: 0.0005, nD: 0.04, nGain: 1.2, crunch: 0 },
      variants: { floorboard: { name: "Floorboard" }, deck: { name: "Deck", mod: { pitch: 0.85 }, over: { thumpGain: 1 } }, stairs: { name: "Stairs", over: { ring: [180, 410], thumpGain: 1 } }, creaky: { name: "Creaky", over: { creak: 1 } } } },
    gravel: { name: "Gravel", p: { thumpF: 70, thumpDecay: 0.03, thumpGain: 0.35, noise: ["bandpass", [800, 6000]], nA: 0.002, nD: 0.05, nGain: 0.5, crunch: 60 },
      variants: { fine: { name: "Fine", over: { crunch: 45 }, mod: { bright: 1.1 } }, coarse: { name: "Coarse", mod: { pitch: 0.85 }, over: { crunch: 90 } } } },
    grass: { name: "Grass", p: { thumpF: 60, thumpDecay: 0.03, thumpGain: 0.2, noise: ["highpass", 1500], nA: 0.008, nD: 0.06, nGain: 0.3, crunch: 12 },
      variants: { short: { name: "Short" }, long: { name: "Long", over: { nD: 0.09, crunch: 20 } }, wet: { name: "Wet", over: { splash: 0.35 } } } },
    snow: { name: "Snow", p: { thumpF: 55, thumpDecay: 0.04, thumpGain: 0.3, noise: ["bandpass", [1200, 7000]], nA: 0.006, nD: 0.07, nGain: 0.6, crunch: 110 },
      variants: { fresh: { name: "Fresh" }, packed: { name: "Packed", over: { crunch: 60, nD: 0.04 }, mod: { bright: 0.9 } } } },
    dirt: { name: "Dirt", p: { thumpF: 65, thumpDecay: 0.035, thumpGain: 0.45, noise: ["bandpass", [300, 2500]], nA: 0.003, nD: 0.045, nGain: 0.7, crunch: 25 },
      variants: { dry: { name: "Dry" }, mud: { name: "Mud", over: { splash: 0.5, crunch: 5 }, mod: { bright: 0.7 } } } },
    puddle: { name: "Puddle", p: { thumpF: 70, thumpDecay: 0.03, thumpGain: 0.3, noise: ["bandpass", [600, 3000]], nA: 0.004, nD: 0.06, nGain: 0.35, crunch: 0, splash: 1 },
      variants: { shallow: { name: "Shallow" }, deep: { name: "Deep", over: { splash: 1.7 }, mod: { pitch: 0.8 } } } },
    metal: { name: "Metal", p: { thumpF: 110, thumpDecay: 0.04, thumpGain: 0.5, noise: ["highpass", 2500], nA: 0.0005, nD: 0.015, nGain: 0.4, crunch: 0, ring: [420, 1130, 2210] },
      variants: { grate: { name: "Grate" }, ladder: { name: "Ladder", over: { ring: [620, 1500, 2900] }, mod: { bright: 1.1 } }, catwalk: { name: "Catwalk", over: { ring: [300, 820, 1700], echo: [0.09, 0.3] } } } },
    heels: { name: "Heels", p: { thumpF: 160, thumpDecay: 0.015, thumpGain: 0.25, noise: ["bandpass", [2500, 7000]], nA: 0.0003, nD: 0.008, nGain: 1.1, crunch: 0, click: 1 },
      variants: { marble: { name: "On marble", over: { echo: [0.07, 0.25] } }, wood: { name: "On wood", over: { thumpGain: 0.5 }, mod: { bright: 0.85 } } } },
    boots: { name: "Boots", p: { thumpF: 70, thumpDecay: 0.05, thumpGain: 1.0, noise: ["lowpass", 2200], nA: 0.001, nD: 0.035, nGain: 0.7, crunch: 0 },
      variants: { leather: { name: "Leather", over: { creak: 0.6 } }, combat: { name: "Combat", over: { thumpGain: 1.2 }, mod: { pitch: 0.9 } } } },
    sneakers: { name: "Sneakers", p: { thumpF: 80, thumpDecay: 0.03, thumpGain: 0.45, noise: ["lowpass", 1400], nA: 0.004, nD: 0.03, nGain: 0.35, crunch: 0 },
      variants: { hard: { name: "Hard floor" }, gym: { name: "Gym", mod: { bright: 1.15 }, over: { echo: [0.08, 0.3] } } } },
  },
  play(slot, c, s) {
    const t = c.t;
    if (slot === "index") { footContact(c, t, s, c.vel, 1); footContact(c, t + (0.11 - 0.075 * c.vel) * rv(c, 0.15), s, c.vel * 0.7, 0.45); }
    else if (slot === "middle") scuff(c, t, s, 1);
    else if (slot === "ring") {
      const f = 1500 * c.pitch * rv(c, 0.15), bp = A.ctx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = f * 1.2; bp.Q.value = 4; bp.connect(c.out);
      osc(c, t, { type: "sawtooth", f, fEnd: f * 1.35, fTau: 0.05, peak: 0.5, att: 0.01, dec: 0.06, dest: bp });
    } else {
      footContact(c, t, s, 1, 1.3); footContact(c, t + 0.012, s, 0.9, 1);
      osc(c, t, { f: 120 * c.pitch, fEnd: 45 * c.pitch, fTau: 0.03, peak: 0.9, dec: 0.14 });
    }
  },
};

/* ------------------------------------------------------------------- cloth */

const center = (m) => Math.sqrt(m.lo * m.hi);

function grab(c, t, m, w = 1) {
  const f = center(m) * c.bright;
  nz(c, t, { type: "bandpass", f, q: f / (m.hi - m.lo) + 0.3, peak: 1.6 * w, att: 0.012, dec: m.dec, dur: 0.45 });
  grains(c, t, m.crunch, c.vel, 0.45 * w, m.lo);
  if (m.thump) osc(c, t, { f: 110 * c.pitch, peak: m.thump * w, dec: 0.03 });
  if (m.creak) creak(c, t, 0.9 * w, 0.12, 95);
  if (m.jingle) tinkle(c, t, 6, 0.12, [1800, 4200], 0.04, 0.6 * w);
  if (m.plate) { ring(c, t, [520, 1340, 2600], 0.2, 0.3 * w); thump(c, t, 140, 0.4 * w, 0.03); }
}

function zip(c, t) {
  const n = 22;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    nz(c, t + 0.3 * u + rand(-0.004, 0.004), { type: "bandpass", f: 3000 * c.pitch * (1 + 0.3 * u), q: 5, peak: 1.2, dec: 0.0035, dur: 0.05 });
  }
}

const cloth = {
  name: "Cloth",
  slots: { index: "Grab", middle: "Snap", ring: "Zip", pinky: "Body fall" },
  textures: {
    cotton: { name: "Cotton", p: { lo: 800, hi: 4500, crunch: 25, dec: 0.08 }, variants: { tshirt: { name: "T-shirt" }, shirt: { name: "Shirt", mod: { bright: 1.1 } } } },
    denim: { name: "Denim", p: { lo: 500, hi: 2600, crunch: 45, dec: 0.06, thump: 0.25 }, variants: { jeans: { name: "Jeans" }, jacket: { name: "Jacket", mod: { pitch: 0.9 }, over: { thump: 0.35 } } } },
    leather: { name: "Leather", p: { lo: 300, hi: 1800, crunch: 15, dec: 0.07, creak: true },
      variants: { jacket: { name: "Jacket" }, belt: { name: "Belt", mod: { bright: 1.2 }, over: { crunch: 5 } }, gloves: { name: "Gloves", mod: { bright: 1.3 }, over: { dec: 0.04 } } } },
    nylon: { name: "Nylon", p: { lo: 1800, hi: 9000, crunch: 80, dec: 0.1 }, variants: { windbreaker: { name: "Windbreaker" }, backpack: { name: "Backpack", mod: { bright: 0.9 }, over: { thump: 0.2 } } } },
    silk: { name: "Silk", p: { lo: 2500, hi: 9000, crunch: 5, dec: 0.12 }, variants: { dress: { name: "Dress" }, scarf: { name: "Scarf", mod: { bright: 1.2 }, over: { dec: 0.18 } } } },
    canvas: { name: "Canvas", p: { lo: 600, hi: 3500, crunch: 35, dec: 0.07, thump: 0.15 }, variants: { bag: { name: "Bag" }, tarp: { name: "Tarp", mod: { pitch: 0.85 }, over: { dec: 0.12 } } } },
    wool: { name: "Wool", p: { lo: 300, hi: 1500, crunch: 4, dec: 0.1 }, variants: { jumper: { name: "Jumper" }, coat: { name: "Coat", mod: { pitch: 0.85 }, over: { thump: 0.2 } } } },
    armour: { name: "Armour", p: { lo: 1500, hi: 6000, crunch: 20, dec: 0.06, jingle: true },
      variants: { chainmail: { name: "Chainmail" }, plate: { name: "Plate", over: { jingle: false, plate: true } } } },
  },
  play(slot, c, m) {
    const t = c.t;
    if (slot === "index") grab(c, t, m);
    else if (slot === "middle") {
      nz(c, t, { type: "highpass", f: m.lo * 2 * c.bright, peak: 1.2, dec: 0.022 });
      osc(c, t, { f: 140 * c.pitch, peak: 0.25, dec: 0.02 });
      grains(c, t, m.crunch * 0.6, c.vel, 0.4, m.lo, 0.2);
    } else if (slot === "ring") zip(c, t);
    else {
      osc(c, t, { f: 75 * c.pitch, fEnd: 55 * c.pitch, fTau: 0.04, peak: 1, dec: 0.12 });
      nz(c, t, { type: "lowpass", f: 1500, peak: 0.5, dec: 0.06 });
      grab(c, t + 0.01, { ...m, dec: m.dec * 2.5 }, 0.8);
    }
  },
};

/* ---------------------------------------------------------------- movement */

function swingThud(c, t, w = 1) {
  osc(c, t, { f: 95 * c.pitch, fEnd: 50 * c.pitch, fTau: 0.03, peak: 0.9 * w, dec: 0.08 });
  nz(c, t, { type: "highpass", f: 1800, peak: 0.7 * w, dec: 0.015 });
  nz(c, t, { type: "lowpass", f: 800, peak: 0.5 * w, dec: 0.05 });
}

function bladeRing(c, t) {
  nz(c, t, { type: "highpass", f: 5000, peak: 0.35, att: 0.08, dec: 0.2, dur: 0.8 });
  osc(c, t, { f: 3600 * c.pitch, peak: 0.08, att: 0.05, dec: 0.5, dur: 2.5 });
}

function swing(c, t, m, dur, peak = 0.8) {
  whoosh(c, t, { f: m.f, q: m.q, dur, peak });
  if (m.ring) bladeRing(c, t + dur * 0.3);
  if (m.crack) nz(c, t + dur * 0.9, { type: "highpass", f: 2500 * c.bright, peak: 1.4, dec: 0.006 });
}

const movement = {
  name: "Movement",
  slots: { index: "Whoosh", middle: "Long whoosh", ring: "Punch", pinky: "Body hit" },
  textures: {
    swish: { name: "Swish", p: { f: 1400, q: 1.4 }, variants: { hand: { name: "Hand" }, arm: { name: "Arm", mod: { pitch: 0.85 }, over: { f: 1100 } } } },
    heavy: { name: "Heavy air", p: { f: 600, q: 0.9 }, variants: { swing: { name: "Big swing" }, sweep: { name: "Sweep", over: { q: 0.6 } } } },
    blade: { name: "Blade", p: { f: 2200, q: 2, ring: true }, variants: { sword: { name: "Sword" }, knife: { name: "Knife", mod: { bright: 1.2 }, over: { f: 3000 } } } },
    body: { name: "Body", p: { f: 900, q: 1.1, thud: true }, variants: { spin: { name: "Spin" }, dodge: { name: "Dodge", over: { f: 1100, thud: false } } } },
    cape: { name: "Cape", p: { f: 450, q: 0.8 }, variants: { cloak: { name: "Cloak" }, flag: { name: "Flag", over: { q: 1.2, f: 600 } } } },
    stick: { name: "Stick", p: { f: 2600, q: 3.5 }, variants: { staff: { name: "Staff", over: { f: 1800, q: 2.5 } }, whip: { name: "Whip", over: { f: 3200, q: 4, crack: true } } } },
  },
  play(slot, c, m) {
    const t = c.t;
    if (slot === "index") swing(c, t, m, 0.26);
    else if (slot === "middle") swing(c, t, { ...m, f: m.f * 0.8 }, 0.6, 0.9);
    else if (slot === "ring") { swing(c, t, m, 0.18); swingThud(c, t + 0.16); }
    else { swingThud(c, t, 1.3); osc(c, t, { f: 60 * c.pitch, peak: 0.6, dec: 0.1 }); if (m.thud) swingThud(c, t + 0.05, 0.5); }
  },
};

/* -------------------------------------------------------------------- guns */

function shot(c, t, g, w = 1) {
  const d = drive(c, g.drive);
  if (g.silenced) {
    nz(c, t, { type: "bandpass", f: g.crack * c.bright, q: 1.5, peak: 1.2 * w, dec: 0.025, dest: d });
    nz(c, t, { type: "highpass", f: 3000, peak: 0.3 * w, dec: 0.006, dest: d });
    osc(c, t, { f: g.boom * c.pitch * 1.5, fEnd: g.boom * c.pitch, fTau: 0.01, peak: 0.4 * w, dec: 0.03, dest: d });
    return;
  }
  nz(c, t, { type: "highpass", f: g.crack * c.bright, peak: 1 * w, dec: 0.012, dest: d });
  nz(c, t, { type: "lowpass", f: 1200 * c.bright, peak: 0.9 * w, att: 0.0005, dec: 0.05 * g.body, dest: d });
  osc(c, t, { f: g.boom * c.pitch * 2, fEnd: g.boom * c.pitch * 0.6, fTau: 0.04, peak: 1 * w, dec: 0.11 * g.body, dest: d });
  nz(c, t + 0.012, { type: "bandpass", f: 500, q: 0.8, peak: 0.5 * w, att: 0.01, dec: g.tail * 0.5, dur: g.tail * 4 });
}

function reload(c, t) {
  const p = c.pitch;
  metalClick(c, t, 2800 * p * rv(c, 0.05), 0.8);
  nz(c, t + 0.05, { type: "bandpass", f: 2200 * p, q: 2, peak: 0.6, att: 0.02, dec: 0.03, dur: 0.2 });
  metalClick(c, t + 0.13 * rv(c, 0.1), 3400 * p, 0.9);
  metalClick(c, t + 0.24 * rv(c, 0.1), 2500 * p, 1.0);
}

function casing(c, t) {
  [0, 0.16, 0.27, 0.35, 0.4, 0.435].forEach((g, i) => {
    const tt = t + g * rv(c, 0.08), a = Math.pow(0.68, i), f = (4800 + rand(-300, 300)) * c.pitch;
    osc(c, tt, { f, peak: 0.28 * a, dec: 0.07 });
    osc(c, tt, { f: f * 1.58, peak: 0.12 * a, dec: 0.04 });
    nz(c, tt, { type: "bandpass", f: 6000, q: 6, peak: 0.5 * a, dec: 0.003, dur: 0.05 });
  });
}

const INDOOR = { name: "Indoor", over: { echo: [0.035, 0.35], tailMul: 0.6 } };
const OUTDOOR = { name: "Outdoor", over: { echo: [0.18, 0.22], tailMul: 1.4 } };

const guns = {
  name: "Guns",
  slots: { index: "Shot", middle: "Reload", ring: "Shell drop", pinky: "Burst" },
  textures: {
    pistol: { name: "Pistol", p: { crack: 2600, boom: 95, body: 0.8, tail: 0.35, burst: 2, rate: 0.11, drive: 3 }, variants: { indoor: INDOOR, outdoor: OUTDOOR } },
    rifle: { name: "Rifle", p: { crack: 3400, boom: 75, body: 1, tail: 0.55, burst: 3, rate: 0.075, drive: 3.5 }, variants: { indoor: INDOOR, outdoor: OUTDOOR } },
    shotgun: { name: "Shotgun", p: { crack: 1800, boom: 55, body: 1.4, tail: 0.8, burst: 1, rate: 0.3, drive: 4 },
      variants: { pump: { name: "Pump" }, double: { name: "Double barrel", over: { burst: 2, rate: 0.12 } } } },
    silenced: { name: "Silenced", p: { crack: 900, boom: 140, body: 0.45, tail: 0.08, burst: 3, rate: 0.09, drive: 1.2, silenced: true },
      variants: { pistol: { name: "Pistol" }, rifle: { name: "Rifle", mod: { pitch: 0.85 } } } },
    revolver: { name: "Revolver", p: { crack: 2200, boom: 85, body: 1.1, tail: 0.5, burst: 1, rate: 0.25, drive: 3.5 }, variants: { indoor: INDOOR, outdoor: OUTDOOR } },
    heavy: { name: "Machine gun", p: { crack: 3000, boom: 60, body: 1.2, tail: 0.7, burst: 6, rate: 0.06, drive: 4 },
      variants: { light: { name: "Light", over: { burst: 5, rate: 0.07 } }, heavy: { name: "Heavy", over: { burst: 8, rate: 0.085, boom: 50 } } } },
  },
  play(slot, c, g0) {
    const g = { ...g0, tail: g0.tail * (g0.tailMul || 1) }, t = c.t;
    if (slot === "index") shot(c, t, g);
    else if (slot === "middle") reload(c, t);
    else if (slot === "ring") casing(c, t);
    else for (let i = 0; i < g.burst; i++) shot(c, t + i * g.rate * rv(c, 0.05), g, i ? 0.9 : 1);
  },
};

/* --------------------------------------------------------------- jewellery */

const jewellery = {
  name: "Jewellery",
  slots: { index: "Jingle", middle: "Shake", ring: "Drop", pinky: "Handful" },
  textures: {
    keys: { name: "Keys", p: { f: [2400, 4200], n: 6, spread: 0.16, dec: 0.05 }, variants: { small: { name: "Small ring", over: { n: 4 } }, big: { name: "Big ring", over: { n: 9, f: [2000, 3800] } } } },
    coins: { name: "Coins", p: { f: [3200, 6000], n: 5, spread: 0.22, dec: 0.09 }, variants: { few: { name: "A few", over: { n: 3 } }, pocket: { name: "Pocketful", over: { n: 9 } } } },
    chain: { name: "Chain", p: { f: [1800, 3400], n: 12, spread: 0.28, dec: 0.025 },
      variants: { fine: { name: "Fine", over: { f: [2600, 4800], n: 14, dec: 0.018 } }, heavy: { name: "Heavy", over: { f: [1200, 2600], n: 10, dec: 0.04 } } } },
    bracelet: { name: "Bracelet", p: { f: [2800, 5200], n: 4, spread: 0.1, dec: 0.14 }, variants: { metal: { name: "Metal" }, bangles: { name: "Bangles", over: { n: 7, dec: 0.18 } } } },
    beads: { name: "Beads", p: { f: [1100, 2200], n: 9, spread: 0.2, dec: 0.012 }, variants: { wood: { name: "Wood" }, glass: { name: "Glass", over: { f: [2600, 4200], dec: 0.03 } } } },
    bells: { name: "Bells", p: { f: [1500, 2600], n: 3, spread: 0.14, dec: 0.5 }, variants: { small: { name: "Small" }, sleigh: { name: "Sleigh", over: { n: 10, spread: 0.3, dec: 0.25 } } } },
  },
  play(slot, c, j) {
    const t = c.t;
    if (slot === "index") tinkle(c, t, j.n, j.spread, j.f, j.dec, 1);
    else if (slot === "middle") { tinkle(c, t, j.n, j.spread * 0.7, j.f, j.dec, 0.9); tinkle(c, t + 0.14, j.n, j.spread * 0.7, j.f, j.dec, 0.8); }
    else if (slot === "ring") {
      [0, 0.11, 0.19, 0.245, 0.28].forEach((d, i) => tinkle(c, t + d, Math.max(1, Math.round(j.n / 3)), 0.02, j.f, j.dec, Math.pow(0.65, i)));
      osc(c, t, { f: 180 * c.pitch, peak: 0.2, dec: 0.02 });
    } else tinkle(c, t, Math.round(j.n * 2.2), j.spread * 2, j.f, j.dec * 1.2, 1.3);
  },
};

/* --------------------------------------------------------------- cinematic */

function hit(c, t, s, w = 1, drv = 2) {
  const d = drive(c, drv), p = c.pitch;
  osc(c, t, { f: s.sub * p * 2.2, fEnd: s.sub * p, fTau: 0.06, peak: 1 * w, dec: 0.35 * s.tail, dur: 3.5, dest: d });
  nz(c, t, { type: "lowpass", f: s.noise * c.bright, fEnd: 200, fTau: 0.15, peak: 0.8 * w, dec: 0.18 * s.tail, dur: 2.5, dest: d });
  if (s.metal) [1, 2.76, 5.4, 8.93].forEach((m, i) => osc(c, t, { f: 180 * p * m, peak: (0.14 * w) / (i + 1), dec: 0.9 * s.tail, dur: 4 }));
  if (s.scifi) osc(c, t, { type: "square", f: 900 * p, fEnd: 60 * p, fTau: 0.06, peak: 0.12 * w, dec: 0.25, dur: 1.5 });
  if (s.glitch) for (let i = 0; i < 6; i++) osc(c, t + 0.05 + i * rand(0.03, 0.07), { type: "square", f: rand(300, 2400) * p, peak: 0.08 * w, dec: 0.015 });
}

function braam(c, t, s) {
  const ctx = A.ctx, lp = ctx.createBiquadFilter(), g = ctx.createGain();
  lp.type = "lowpass"; lp.Q.value = 4;
  lp.frequency.setValueAtTime(150, t);
  lp.frequency.exponentialRampToValueAtTime(fq(2400 * c.bright), t + 0.35);
  lp.frequency.setTargetAtTime(250, t + 0.6, 0.6);
  env(g.gain, t, 0.5, 0.06, 0.7, 1.0);
  lp.connect(g).connect(drive(c, 2.5));
  const f = Math.max(s.sub, 45) * c.pitch;
  [[1, 0], [1, 9], [1.5, -6], [2, 4], [0.5, 0]].forEach(([m, dt]) => {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = "sawtooth"; o.frequency.value = f * m; o.detune.value = dt; og.gain.value = 0.18;
    o.connect(og).connect(lp); o.start(t); o.stop(t + 3.5);
  });
}

function riser(c, t, s, dur = 1.4) {
  const ctx = A.ctx, bp = ctx.createBiquadFilter(), g = ctx.createGain();
  bp.type = "bandpass"; bp.Q.value = 2.5;
  bp.frequency.setValueAtTime(200, t);
  bp.frequency.exponentialRampToValueAtTime(fq(7000 * c.bright), t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1.6, t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  noiseSrc(t, dur + 0.1).connect(bp).connect(g).connect(c.out);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.frequency.setValueAtTime(220 * c.pitch, t); o.frequency.exponentialRampToValueAtTime(880 * c.pitch, t + dur);
  og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(0.12, t + dur); og.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  o.connect(og).connect(c.out); o.start(t); o.stop(t + dur + 0.1);
  hit(c, t + dur, s, 0.6);
}

const cinematic = {
  name: "Cinematic",
  slots: { index: "Hit", middle: "Braam", ring: "Riser", pinky: "Boom" },
  textures: {
    epic: { name: "Epic", p: { sub: 55, noise: 2500, tail: 1 }, variants: { hit: { name: "Hit" }, slam: { name: "Slam", mod: { bright: 1.2 }, over: { noise: 3500 } } } },
    deep: { name: "Deep", p: { sub: 38, noise: 900, tail: 1.5 }, variants: { sub: { name: "Sub" }, boom: { name: "Boom", over: { noise: 1500 } } } },
    metal: { name: "Metal", p: { sub: 60, noise: 4000, tail: 1.1, metal: true }, variants: { clang: { name: "Clang" }, resonant: { name: "Resonant", over: { tail: 1.6 } } } },
    scifi: { name: "Sci-Fi", p: { sub: 50, noise: 3000, tail: 0.9, scifi: true }, variants: { laser: { name: "Laser hit" }, glitch: { name: "Glitch", over: { glitch: true } } } },
    taiko: { name: "Taiko", p: { sub: 65, noise: 1500, tail: 0.7 }, variants: { single: { name: "Single" }, ensemble: { name: "Ensemble", over: { ensemble: true } } } },
    thunder: { name: "Thunder", p: { sub: 32, noise: 600, tail: 2.2 }, variants: { crack: { name: "Crack", over: { noise: 5000 } }, rumble: { name: "Rumble", over: { tail: 3, noise: 400 } } } },
  },
  play(slot, c, s) {
    const t = c.t;
    if (slot === "index") {
      hit(c, t, s);
      if (s.ensemble) { hit(c, t + 0.014, { ...s, sub: s.sub * 1.06 }, 0.7); hit(c, t + 0.027, { ...s, sub: s.sub * 0.95 }, 0.6); }
    } else if (slot === "middle") braam(c, t, s);
    else if (slot === "ring") riser(c, t, s);
    else {
      hit(c, t, s, 1.4, 4);
      nz(c, t, { type: "highpass", f: 2500, peak: 0.6, dec: 0.02 });
      osc(c, t, { f: 30 * c.pitch, peak: 0.8, dec: 0.8, dur: 4 });
    }
  },
};

/* ------------------------------------------------------------ impacts & body */

function impact(c, t, p, w, o = {}) {
  const d = drive(c, 2), low = o.low || 1, long = o.long || 1;
  thump(c, t, p.bodyF * low, 0.9 * w, p.bodyDec * long, d);
  nz(c, t, { type: "lowpass", f: p.nF * c.bright, peak: 0.8 * w, dec: p.nDec * long, dest: d });
  if (o.crack) nz(c, t, { type: "highpass", f: 2500 * c.bright, peak: 0.9 * w, dec: 0.008 });
  if (p.ring) ring(c, t, p.ring, p.ringDec, 0.25 * w);
  if (p.shatter) grains(c, t + 0.005, 160 * w, c.vel, 0.6 * w, 3500, 0.7, 2);
  if (p.crunch) grains(c, t, p.crunch, c.vel, 0.4 * w, 1200);
}

const impacts = {
  name: "Impacts & body",
  slots: { index: "Punch", middle: "Slap", ring: "Kick", pinky: "Body fall" },
  textures: {
    flesh: { name: "Flesh", p: { bodyF: 110, bodyDec: 0.06, nF: 1200, nDec: 0.04 },
      variants: { face: { name: "Face", mod: { bright: 1.15 } }, body: { name: "Body" }, gut: { name: "Gut", mod: { pitch: 0.75, bright: 0.7 } } } },
    wood: { name: "Wood", p: { bodyF: 140, bodyDec: 0.05, nF: 2500, nDec: 0.03, ring: [240, 610, 1150], ringDec: 0.08 },
      variants: { plank: { name: "Plank" }, door: { name: "Door", mod: { pitch: 0.85 }, over: { ring: [150, 380, 700] } }, crate: { name: "Crate", over: { ringDec: 0.04, crunch: 20 } } } },
    metal: { name: "Metal", p: { bodyF: 120, bodyDec: 0.05, nF: 4000, nDec: 0.03, ring: [380, 1020, 2210, 3700], ringDec: 0.5 },
      variants: { sheet: { name: "Sheet", over: { ring: [300, 700, 1900, 3300], ringDec: 0.8 } }, pipe: { name: "Pipe", over: { ring: [620, 1700, 3300] } }, car: { name: "Car body", mod: { pitch: 0.8 }, over: { ringDec: 0.3 } } } },
    glass: { name: "Glass", p: { bodyF: 200, bodyDec: 0.03, nF: 6000, nDec: 0.02, ring: [1800, 4200, 6900], ringDec: 0.25, shatter: true },
      variants: { window: { name: "Window" }, bottle: { name: "Bottle", over: { shatter: false, ring: [1300, 3100, 5600] } } } },
    ground: { name: "Ground", p: { bodyF: 70, bodyDec: 0.08, nF: 1500, nDec: 0.05, crunch: 40 },
      variants: { dirt: { name: "Dirt" }, concrete: { name: "Concrete", over: { crunch: 5, nF: 3000 } }, mat: { name: "Gym mat", mod: { bright: 0.7 }, over: { crunch: 0, nF: 900 } } } },
  },
  play(slot, c, p) {
    const t = c.t;
    if (slot === "index") { nz(c, t, { type: "bandpass", f: 1200, q: 1, peak: 0.3, att: 0.02, dec: 0.02 }); impact(c, t + 0.02, p, 1); }
    else if (slot === "middle") impact(c, t, { ...p, nDec: p.nDec * 0.5, bodyDec: p.bodyDec * 0.5 }, 0.6, { crack: true });
    else if (slot === "ring") { whoosh(c, t, { f: 900, q: 1, dur: 0.12, peak: 0.5 }); impact(c, t + 0.1, p, 1.2, { low: 0.8 }); }
    else {
      impact(c, t, p, 1.3, { low: 0.7, long: 2 });
      nz(c, t, { type: "bandpass", f: 1500 * c.bright, q: 0.8, peak: 0.6, att: 0.01, dec: 0.1 });
      impact(c, t + 0.09, p, 0.4, { low: 0.9 });
    }
  },
};

/* ---------------------------------------------------------- props & objects */

function slide(c, t, f, len, w) {
  nz(c, t, { type: "bandpass", f: f * c.bright, fEnd: f * 1.6 * c.bright, fTau: len, q: 1.5, peak: 0.8 * w, att: 0.04, hold: len, dec: 0.04 });
  grains(c, t, 25, c.vel, 0.25 * w, 1500, len + 0.1, 1);
}

const props = {
  name: "Props & objects",
  slots: { index: "Pick up", middle: "Put down", ring: "Open", pinky: "Close" },
  textures: {
    door: { name: "Door", p: { bodyF: 80, handF: 1500, ring: [150, 380], ringDec: 0.12, latch: true, creak: true },
      variants: { wood: { name: "Wood" }, metal: { name: "Metal", over: { ring: [240, 690, 1500], ringDec: 0.5 } }, car: { name: "Car", mod: { bright: 0.8 }, over: { bodyF: 60, creak: false, ring: [200, 520], ringDec: 0.15 } } } },
    drawer: { name: "Drawer", p: { bodyF: 120, handF: 2000, ring: [300, 800], ringDec: 0.06, slide: true },
      variants: { wood: { name: "Wood" }, metal: { name: "Metal", over: { ring: [700, 1700, 3100], ringDec: 0.25 } } } },
    paper: { name: "Paper", p: { bodyF: 150, handF: 3000, crunch: 50 },
      variants: { sheet: { name: "Sheet" }, book: { name: "Book", mod: { pitch: 0.9 }, over: { bodyF: 110, crunch: 15 } }, envelope: { name: "Envelope", mod: { bright: 1.2 }, over: { crunch: 30 } } } },
    glassware: { name: "Glassware", p: { bodyF: 300, handF: 4000, ring: [1600, 3900, 6200], ringDec: 0.25, clink: true },
      variants: { bottle: { name: "Bottle" }, cup: { name: "Cup", over: { ring: [2100, 4800], ringDec: 0.15 } } } },
    plastic: { name: "Plastic", p: { bodyF: 180, handF: 2500, ring: [900], ringDec: 0.03, crunch: 70 },
      variants: { bag: { name: "Bag" }, box: { name: "Box", over: { crunch: 15, ring: [600, 1400], ringDec: 0.05 } } } },
    tools: { name: "Tools", p: { bodyF: 140, handF: 3500, ring: [900, 2400, 4100], ringDec: 0.3, ratchet: true },
      variants: { wrench: { name: "Wrench" }, screwdriver: { name: "Screwdriver", over: { ring: [1500, 3600], ringDec: 0.15 } } } },
  },
  play(slot, c, p) {
    const t = c.t;
    if (slot === "index") {
      nz(c, t, { type: "bandpass", f: p.handF * c.bright, q: 1.5, peak: 0.7, att: 0.01, dec: 0.05 });
      if (p.crunch) grains(c, t, p.crunch * 0.5, c.vel, 0.3, 1500);
      if (p.ring) ring(c, t + 0.01, p.ring.slice(0, 1), Math.min(p.ringDec, 0.08), 0.1);
    } else if (slot === "middle") {
      thump(c, t, p.bodyF, 0.8, 0.04);
      nz(c, t, { type: "lowpass", f: 2000 * c.bright, peak: 0.5, dec: 0.02 });
      if (p.ring) ring(c, t, p.ring, p.ringDec, 0.2);
      if (p.clink) ring(c, t + 0.05, p.ring.slice(1), p.ringDec * 0.5, 0.08);
    } else if (slot === "ring") {
      if (p.latch) metalClick(c, t, 2600 * c.pitch, 0.8);
      if (p.creak) creak(c, t + 0.05, 1, 0.4, 55);
      if (p.slide) slide(c, t, 1500, 0.3, 1);
      if (p.crunch && !p.slide) grains(c, t, p.crunch * 1.5, c.vel, 0.5, 1800, 0.6, 1.5);
      if (p.ratchet) for (let i = 0; i < 6; i++) metalClick(c, t + i * 0.055, 3200 * c.pitch, 0.5);
      if (p.clink) { ring(c, t, p.ring, p.ringDec * 0.6, 0.15); ring(c, t + 0.12, p.ring, p.ringDec * 0.6, 0.1); }
      if (p.bodyF && !p.latch && !p.slide && !p.ratchet && !p.clink && !p.crunch) thump(c, t, p.bodyF, 0.4, 0.03);
    } else {
      if (p.slide) slide(c, t, 1300, 0.12, 0.8);
      const tt = t + (p.slide ? 0.14 : 0);
      thump(c, tt, p.bodyF * 0.8, 1.2, 0.12);
      nz(c, tt, { type: "lowpass", f: 1500 * c.bright, peak: 0.8, dec: 0.05 });
      if (p.ring) ring(c, tt, p.ring, p.ringDec, 0.3);
      if (p.latch) metalClick(c, tt + 0.01, 2400 * c.pitch, 0.7);
      if (p.crunch) grains(c, tt, p.crunch * 0.4, c.vel, 0.3, 1500);
    }
  },
};

/* --------------------------------------------------------- water & elements */

function drops(c, t, n, dur, w) {
  for (let i = 0; i < Math.min(n, 150); i++) {
    const tt = t + Math.random() * dur;
    nz(c, tt, { type: "highpass", f: 2500 * c.bright, peak: rand(0.2, 0.6) * w, dec: 0.004, dur: 0.05 });
    if (Math.random() < 0.3) osc(c, tt, { f: rand(1500, 3500) * c.pitch, peak: 0.05 * w, dec: 0.01 });
  }
}

const elements = {
  name: "Water & elements",
  slots: { index: "Small", middle: "Medium", ring: "Movement", pinky: "Big" },
  textures: {
    water: { name: "Water", p: { kind: "water" },
      variants: { puddle: { name: "Puddle" }, pool: { name: "Pool", mod: { pitch: 0.85 }, over: { echo: [0.05, 0.25] } }, bath: { name: "Bath", mod: { bright: 1.1 }, over: { echo: [0.03, 0.35] } }, sea: { name: "Sea", mod: { pitch: 0.7, bright: 0.8 } } } },
    fire: { name: "Fire", p: { kind: "fire" }, variants: { torch: { name: "Torch" }, campfire: { name: "Campfire", mod: { pitch: 0.85 } }, fireball: { name: "Fireball", mod: { pitch: 0.75 } } } },
    wind: { name: "Wind", p: { kind: "wind", q: 1.2 }, variants: { gust: { name: "Gust" }, whistle: { name: "Whistle", over: { q: 6 } } } },
    rain: { name: "Rain", p: { kind: "rain", density: 1 }, variants: { light: { name: "Light" }, heavy: { name: "Heavy", over: { density: 2.2 } } } },
    mud: { name: "Mud", p: { kind: "mud" }, variants: { squelch: { name: "Squelch" }, suck: { name: "Suction", mod: { pitch: 0.8 } } } },
  },
  play(slot, c, p) {
    const t = c.t;
    const size = { index: 0, middle: 1, ring: 2, pinky: 3 }[slot];
    if (p.kind === "water") {
      if (size === 0) { bubble(c, t, 0.35, 700, 1200); nz(c, t, { type: "highpass", f: 3000, peak: 0.2, dec: 0.004 }); }
      else if (size === 1) splash(c, t, c.vel, 1);
      else if (size === 2) {
        nz(c, t, { type: "bandpass", f: 700 * c.bright, fEnd: 1400 * c.bright, fTau: 0.3, q: 1.2, peak: 0.6, att: 0.2, hold: 0.3, dec: 0.2 });
        for (let i = 0; i < 7; i++) bubble(c, t + rand(0.05, 0.8), rand(0.06, 0.15));
      } else {
        splash(c, t, 1, 1.6);
        thump(c, t, 60, 0.6, 0.15);
        nz(c, t + 0.03, { type: "highpass", f: 4000, peak: 0.4, att: 0.05, dec: 0.35 });
      }
    } else if (p.kind === "fire") {
      if (size === 0) grains(c, t, 25, c.vel, 0.7, 2000, 0.4, 1);
      else if (size === 1) { whoosh(c, t, { f: 700, q: 0.7, dur: 0.5 }); grains(c, t + 0.1, 20, c.vel, 0.4, 2000, 0.5, 1); }
      else if (size === 2) { nz(c, t, { type: "lowpass", f: 400 * c.bright, peak: 1, att: 0.1, hold: 0.4, dec: 0.3 }); grains(c, t, 60, c.vel, 0.4, 1800, 0.9, 1); }
      else { whoosh(c, t, { f: 500, q: 0.6, dur: 0.45, peak: 1 }); thump(c, t + 0.35, 55, 1, 0.3); grains(c, t + 0.35, 50, 1, 0.5, 1500, 0.8, 1.5); }
    } else if (p.kind === "wind") {
      const dur = [0.6, 1.0, 1.6, 1.2][size], peak = [0.6, 0.8, 0.8, 1][size];
      whoosh(c, t, { f: 700, q: p.q, dur, peak, from: size === 2 ? -0.7 : 0, to: size === 2 ? 0.7 : 0 });
      if (size === 3) nz(c, t, { type: "lowpass", f: 150, peak: 0.8, att: 0.2, hold: 0.5, dec: 0.4 });
    } else if (p.kind === "rain") {
      const n = [4, 12, 30, 60][size] * p.density, dur = [0.2, 0.3, 1, 1.2][size];
      drops(c, t, n, dur, 1);
      if (size >= 2) nz(c, t, { type: "bandpass", f: 3000 * c.bright, q: 0.6, peak: 0.15 * size * p.density, att: 0.1, hold: dur * 0.6, dec: 0.3 });
    } else {
      const sq = (tt, w) => {
        nz(c, tt, { type: "lowpass", f: 800 * c.bright, peak: 0.9 * w, att: 0.02, dec: 0.08 });
        for (let i = 0; i < 3; i++) bubble(c, tt + rand(0, 0.08), 0.12 * w, 200, 450);
      };
      if (size === 0) sq(t, 0.8);
      else if (size === 1) sq(t, 1.3);
      else if (size === 2) { sq(t, 1); osc(c, t + 0.2, { f: 180 * c.pitch, fEnd: 500 * c.pitch, fTau: 0.08, peak: 0.25, dec: 0.08 }); sq(t + 0.35, 0.7); }
      else { sq(t, 1.6); thump(c, t, 60, 0.7, 0.1); }
    }
  },
};

/* -------------------------------------------------------------- creatures */

function clop(c, t, p, w) {
  nz(c, t, { type: "bandpass", f: 1200 * c.bright, q: 2, peak: (p.click ?? 1) * w, dec: 0.012 });
  thump(c, t, 120, 0.6 * w, 0.03);
  if (p.crunch) grains(c, t, p.crunch, c.vel, 0.4 * w, 1500);
  if (p.ring) ring(c, t, p.ring, 0.08, 0.15 * w);
}
function paw(c, t, p, w) {
  nz(c, t, { type: "lowpass", f: 900 * c.bright, peak: 0.5 * w, att: 0.003, dec: 0.03 });
  if (p.claws) for (let i = 0; i < 2; i++) nz(c, t + rand(0, 0.02), { type: "bandpass", f: 4500, q: 4, peak: 0.5 * w * p.claws, dec: 0.003 });
  if (p.crunch) grains(c, t, p.crunch, c.vel, 0.3 * w, 1500);
}
function beast(c, t, p, w) {
  thump(c, t, 45, 1.2 * w, 0.25, drive(c, 2));
  nz(c, t, { type: "lowpass", f: 600 * c.bright, peak: 0.8 * w, dec: 0.15 });
  grains(c, t + 0.02, p.crunch || 25, c.vel, 0.35 * w, 800, 0.6, 1.5);
}
function flaps(c, t, n, w) {
  for (let i = 0; i < n; i++) nz(c, t + (i * 0.13) / c.pitch, { type: "bandpass", f: 900 * c.bright, q: 0.8, peak: 0.8 * w, att: 0.02, dec: 0.05 });
}

const creatures = {
  name: "Creatures",
  slots: { index: "Step", middle: "Run", ring: "Scratch", pinky: "Wings / land" },
  textures: {
    horse: { name: "Horse", p: { kind: "hoof" },
      variants: { cobble: { name: "Cobbles", over: { click: 1.2, crunch: 5 } }, dirt: { name: "Dirt", mod: { bright: 0.8 }, over: { click: 0.4, crunch: 35 } }, bridge: { name: "Wooden bridge", over: { ring: [160, 420] } } } },
    dog: { name: "Dog", p: { kind: "paw", claws: 1 },
      variants: { tile: { name: "Tile", mod: { bright: 1.2 } }, wood: { name: "Wood" }, grass: { name: "Grass", over: { claws: 0, crunch: 15 } } } },
    beast: { name: "Big creature", p: { kind: "beast" }, variants: { stone: { name: "Stone" }, dirt: { name: "Dirt", over: { crunch: 45 } } } },
    bird: { name: "Bird", p: { kind: "bird" }, variants: { small: { name: "Small" }, large: { name: "Large", mod: { pitch: 0.6 } } } },
  },
  play(slot, c, p) {
    const t = c.t;
    if (p.kind === "hoof") {
      if (slot === "index") clop(c, t, p, 1);
      else if (slot === "middle") [[0, 1], [0.09, 0.8], [0.17, 0.9], [0.33, 1.1]].forEach(([d, w]) => clop(c, t + d / c.pitch, p, w));
      else if (slot === "ring") { nz(c, t, { type: "bandpass", f: 2500 * c.bright, q: 1.5, peak: 0.7, att: 0.02, hold: 0.1, dec: 0.05 }); if (p.crunch) grains(c, t, p.crunch * 2, c.vel, 0.4, 1500, 0.3); }
      else { clop(c, t, p, 1.4); clop(c, t + 0.04, p, 1.2); thump(c, t, 60, 0.6, 0.12); }
    } else if (p.kind === "paw") {
      if (slot === "index") paw(c, t, p, 1);
      else if (slot === "middle") [0, 0.07, 0.16, 0.23].forEach((d) => paw(c, t + d / c.pitch, p, 0.9));
      else if (slot === "ring") { for (let i = 0; i < 10; i++) nz(c, t + i * 0.025, { type: "bandpass", f: 4000 * c.bright, q: 3, peak: 0.4, dec: 0.004 }); nz(c, t, { type: "bandpass", f: 2000, q: 1, peak: 0.3, att: 0.05, hold: 0.15, dec: 0.05 }); }
      else { paw(c, t, p, 1.5); thump(c, t, 90, 0.7, 0.06); }
    } else if (p.kind === "beast") {
      if (slot === "index") beast(c, t, p, 1);
      else if (slot === "middle") { beast(c, t, p, 1); beast(c, t + 0.35 / c.pitch, p, 0.9); }
      else if (slot === "ring") nz(c, t, { type: "bandpass", f: 800 * c.bright, fEnd: 1400, fTau: 0.2, q: 1.5, peak: 0.9, att: 0.03, hold: 0.3, dec: 0.08 });
      else { beast(c, t, { ...p, crunch: (p.crunch || 25) * 2 }, 1.6); thump(c, t, 30, 0.8, 0.5); }
    } else {
      const tick = (tt, w) => nz(c, tt, { type: "bandpass", f: 5000 * c.bright, q: 3, peak: 0.4 * w, dec: 0.003 });
      if (slot === "index") { tick(t, 1); tick(t + 0.015, 0.7); }
      else if (slot === "middle") [0, 0.12, 0.24].forEach((d) => { tick(t + d, 1); tick(t + d + 0.015, 0.6); });
      else if (slot === "ring") [0, 0.09, 0.18].forEach((d) => { nz(c, t + d, { type: "bandpass", f: 2500, q: 5, peak: 0.6, dec: 0.004 }); osc(c, t + d, { f: 900 * c.pitch, peak: 0.08, dec: 0.01 }); });
      else flaps(c, t, 4, 1);
    }
  },
};

/* ------------------------------------------------------------- catalogue */

export const FOLDERS = { footsteps, cloth, movement, impacts, props, guns, jewellery, elements, creatures, cinematic };
export const FOLDER_KEYS = Object.keys(FOLDERS);

/** Flat list of a folder's sub-categories: [{key: "wood.stairs", tex, texName, name, label}]. */
export function textureList(folder) {
  const out = [];
  for (const [tk, T] of Object.entries(FOLDERS[folder].textures)) {
    for (const [vk, V] of Object.entries(T.variants)) out.push({ key: `${tk}.${vk}`, tex: tk, texName: T.name, name: V.name, label: `${T.name} · ${V.name}` });
  }
  return out;
}
export const hasTexture = (folder, key) => textureList(folder).some((t) => t.key === key);
export const textureLabel = (folder, key) => textureList(folder).find((t) => t.key === key)?.label || key;

function params(folder, key) {
  const [tk, vk] = key.split(".");
  const T = FOLDERS[folder].textures[tk];
  const V = T.variants[vk] || Object.values(T.variants)[0];
  return { p: { ...T.p, ...(V.over || {}) }, mod: V.mod || {} };
}

/** Play the synth version of one finger sound for one sub-category, into the voice `c` from makeCtx. */
export function render(folder, slot, c, key) {
  const F = FOLDERS[folder], { p, mod } = params(folder, key);
  c.pitch *= mod.pitch ?? 1;
  c.bright *= mod.bright ?? 1;
  F.play(slot, c, p);
  if (p.echo) {
    // Room reflection: a quieter, darker copy a few tens of milliseconds later.
    const [delay, level] = p.echo;
    const g = A.ctx.createGain(), lp = A.ctx.createBiquadFilter();
    g.gain.value = level; lp.type = "lowpass"; lp.frequency.value = 2500;
    g.connect(lp).connect(c.out);
    F.play(slot, { ...c, t: c.t + delay, out: g, bright: c.bright * 0.7 }, p);
  }
}
