// Sound library: every sound is synthesized live with the Web Audio API.
// Each category ("folder") has presets, and maps the six gestures to sounds:
//   a = thumb+index, b = thumb+middle, c = thumb+ring, fist, swipe, texture (moving open hand)

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const fq = (f) => clamp(f, 20, 18000);

export const A = { ctx: null, bus: null, master: null, wet: null, noise: null, tex: null };

/* ------------------------------------------------------------------ engine */

/** Start audio after a click (browsers only allow sound after the user interacts). */
export function initAudio(volume = 0.8) {
  createAudio(volume);
  return A.ctx.resume();
}

/** Build the audio graph. Can run before any click (it stays suspended), so samples can be decoded early. */
export function createAudio(volume = 0.8) {
  if (A.ctx) return A.ctx;
  const ctx = (A.ctx = new AudioContext({ latencyHint: "interactive" }));
  const comp = ctx.createDynamicsCompressor();      // glue + protects against clipping
  comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 6;
  comp.attack.value = 0.003; comp.release.value = 0.15;
  A.master = ctx.createGain(); A.master.gain.value = volume;
  A.bus = ctx.createGain();
  const conv = ctx.createConvolver(); conv.buffer = impulse(2.8);
  A.wet = ctx.createGain(); A.wet.gain.value = 0.2;
  A.bus.connect(A.master);
  A.bus.connect(conv).connect(A.wet).connect(A.master);
  A.master.connect(comp).connect(ctx.destination);
  A.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = A.noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
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

export function setVolume(v) { if (A.master) A.master.gain.value = v; }
export function setSpace(space, cat) { if (A.wet) A.wet.gain.value = space * LIB[cat].verb * 2.2; }

/** Per-trigger context: gain, panning, brightness and pitch derived from velocity and macros. */
export function makeCtx(vel, pan, height, m, heightTone) {
  const ctx = A.ctx;
  const intensity = 0.35 + 1.3 * m.intensity;
  const out = ctx.createGain();
  out.gain.value = (0.12 + 0.88 * Math.pow(vel, 1.4)) * intensity * Math.pow(10, (rand(-2, 2) * m.variation * 2) / 20);
  const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
  out.connect(p).connect(A.bus);
  setTimeout(() => { out.disconnect(); p.disconnect(); }, 7000);
  const toneMul = (0.55 + 0.9 * m.tone) * (heightTone ? 0.75 + 0.5 * height : 1);
  return {
    t: ctx.currentTime + 0.003,
    vel,
    out,
    bright: (0.6 + 0.8 * vel) * toneMul,
    pitch: Math.pow(2, Math.round((m.pitch - 0.5) * 24) / 12),
    vary: m.variation,
    dir: 1,
    speed: 0,
  };
}

// small random variation, scaled by the Variation macro
const rv = (c, amt) => 1 + (Math.random() * 2 - 1) * amt * c.vary * 2;

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
  noiseSrc(t, o.dur || 0.5).connect(f).connect(g).connect(o.dest || c.out);
}

/** Oscillator with pitch glide and envelope. */
function osc(c, t, o) {
  const ctx = A.ctx, s = ctx.createOscillator(), g = ctx.createGain();
  s.type = o.type || "sine";
  s.frequency.setValueAtTime(fq(o.f), t);
  if (o.fEnd) s.frequency.setTargetAtTime(fq(o.fEnd), t, o.fTau || 0.05);
  if (o.detune) s.detune.value = o.detune;
  env(g.gain, t, o.peak, o.att || 0.001, o.dec || 0.1, o.hold || 0);
  s.connect(g).connect(o.dest || c.out);
  s.start(t);
  s.stop(t + (o.dur || Math.max(0.3, (o.dec || 0.1) * 7 + (o.hold || 0))));
}

const curves = {};
/** tanh saturation stage, returns the node to connect into. */
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
function grains(c, t, density, vel, peak, hp, dur = 0.35) {
  const ctx = A.ctx, sr = ctx.sampleRate, n = Math.floor(dur * sr);
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const count = Math.floor(density * (0.4 + vel));
  for (let i = 0; i < count; i++) {
    const start = Math.floor((1 - Math.pow(Math.random(), 1 / 3)) * (n - 200));
    const g = Math.min(Math.floor(rand(0.0008, 0.003) * sr), n - start);
    const amp = rand(0.2, 1);
    for (let k = 0; k < g; k++) d[start + k] += (Math.random() * 2 - 1) * Math.exp(-k / (g / 4)) * amp;
  }
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = buf; f.type = "highpass"; f.frequency.value = hp; g.gain.value = peak;
  s.connect(f).connect(g).connect(c.out);
  s.start(t);
}

/** Band-passed air movement with a filter sweep and optional pan sweep. */
function whoosh(c, t, o) {
  const ctx = A.ctx, bp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner();
  const dur = o.dur, F = fq(o.f * c.bright);
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

/* --------------------------------------------------------------- footsteps */

const FOOT = {
  concrete: { thumpF: 85, thumpDecay: 0.025, thumpGain: 0.5, noise: ["lowpass", 3500], nA: 0.0005, nD: 0.02, nGain: 0.6, crunch: 0 },
  wood: { thumpF: 150, thumpDecay: 0.06, thumpGain: 0.8, noise: ["bandpass", [250, 1400]], nA: 0.0005, nD: 0.04, nGain: 1.2, crunch: 0 },
  gravel: { thumpF: 70, thumpDecay: 0.03, thumpGain: 0.35, noise: ["bandpass", [800, 6000]], nA: 0.002, nD: 0.05, nGain: 0.5, crunch: 60 },
  grass: { thumpF: 60, thumpDecay: 0.03, thumpGain: 0.2, noise: ["highpass", 1500], nA: 0.008, nD: 0.06, nGain: 0.3, crunch: 12 },
  snow: { thumpF: 55, thumpDecay: 0.04, thumpGain: 0.3, noise: ["bandpass", [1200, 7000]], nA: 0.006, nD: 0.07, nGain: 0.6, crunch: 110 },
};

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
}

function scuff(c, t, s, w) {
  const f = filterOf(s, c.bright * 0.9);
  nz(c, t, { type: "bandpass", f: f.f * 0.8, fEnd: f.f * 1.3, fTau: 0.08, q: 1.2, peak: 1.1 * w, att: 0.02, dec: 0.09, dur: 0.4 });
  if (s.crunch) grains(c, t, s.crunch * 1.5, c.vel, 0.4 * w, 1500, 0.3);
  osc(c, t, { f: s.thumpF * c.pitch, peak: 0.2 * w, dec: 0.03 });
}

/* ------------------------------------------------------------------- guns */

const GUN = {
  pistol: { crack: 2600, boom: 95, body: 0.8, tail: 0.35, burst: 2, rate: 0.11, drive: 3 },
  rifle: { crack: 3400, boom: 75, body: 1, tail: 0.55, burst: 3, rate: 0.075, drive: 3.5 },
  shotgun: { crack: 1800, boom: 55, body: 1.4, tail: 0.8, burst: 1, rate: 0.3, drive: 4 },
  silenced: { crack: 900, boom: 140, body: 0.45, tail: 0.08, burst: 3, rate: 0.09, drive: 1.2, silenced: true },
};

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

function metalClick(c, t, f, peak) {
  nz(c, t, { type: "bandpass", f, q: 10, peak: peak * 3, dec: 0.006, dur: 0.1 });
  osc(c, t, { f: f * 1.31, peak: peak * 0.2, dec: 0.025 });
}

function reload(c, t) {
  const p = c.pitch;
  metalClick(c, t, 2800 * p * rv(c, 0.05), 0.8);
  nz(c, t + 0.05, { type: "bandpass", f: 2200 * p, q: 2, peak: 0.6, att: 0.02, dec: 0.03, dur: 0.2 });
  metalClick(c, t + 0.13 * rv(c, 0.1), 3400 * p, 0.9);
  metalClick(c, t + 0.24 * rv(c, 0.1), 2500 * p, 1.0);
}

function casing(c, t) {
  const gaps = [0, 0.16, 0.27, 0.35, 0.4, 0.435];
  gaps.forEach((g, i) => {
    const tt = t + g * rv(c, 0.08), a = Math.pow(0.68, i), f = (4800 + rand(-300, 300)) * c.pitch;
    osc(c, tt, { f, peak: 0.28 * a, dec: 0.07 });
    osc(c, tt, { f: f * 1.58, peak: 0.12 * a, dec: 0.04 });
    nz(c, tt, { type: "bandpass", f: 6000, q: 6, peak: 0.5 * a, dec: 0.003, dur: 0.05 });
  });
}

function whizBy(c, t) {
  const p = A.ctx.createStereoPanner();
  p.pan.setValueAtTime(-0.9 * c.dir, t);
  p.pan.linearRampToValueAtTime(0.9 * c.dir, t + 0.35);
  p.connect(c.out);
  nz(c, t, { type: "bandpass", f: 5000 * c.pitch, fEnd: 900 * c.pitch, fTau: 0.12, q: 5, peak: 2.2, att: 0.12, dec: 0.06, dur: 0.5, dest: p });
  osc(c, t, { f: 3000 * c.pitch, fEnd: 700 * c.pitch, fTau: 0.1, peak: 0.08, att: 0.1, dec: 0.08, dest: p });
}

/* -------------------------------------------------------------- cinematic */

const CIN = {
  epic: { sub: 55, noise: 2500, tail: 1 },
  deep: { sub: 38, noise: 900, tail: 1.5 },
  metal: { sub: 60, noise: 4000, tail: 1.1, metal: true },
  scifi: { sub: 50, noise: 3000, tail: 0.9, scifi: true },
};

function hit(c, t, s, w = 1, drv = 2) {
  const d = drive(c, drv), p = c.pitch;
  osc(c, t, { f: s.sub * p * 2.2, fEnd: s.sub * p, fTau: 0.06, peak: 1 * w, dec: 0.35 * s.tail, dur: 3, dest: d });
  nz(c, t, { type: "lowpass", f: s.noise * c.bright, fEnd: 200, fTau: 0.15, peak: 0.8 * w, dec: 0.18 * s.tail, dur: 2, dest: d });
  if (s.metal) [1, 2.76, 5.4, 8.93].forEach((m, i) => osc(c, t, { f: 180 * p * m, peak: (0.14 * w) / (i + 1), dec: 0.9, dur: 4 }));
  if (s.scifi) osc(c, t, { type: "square", f: 900 * p, fEnd: 60 * p, fTau: 0.06, peak: 0.12 * w, dec: 0.25, dur: 1.5 });
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

/* ------------------------------------------------------------------ cloth */

const CLOTH = {
  cotton: { lo: 800, hi: 4500, crunch: 25, dec: 0.08 },
  denim: { lo: 500, hi: 2600, crunch: 45, dec: 0.06, thump: 0.25 },
  leather: { lo: 300, hi: 1800, crunch: 15, dec: 0.07, creak: true },
  nylon: { lo: 1800, hi: 9000, crunch: 80, dec: 0.1 },
};
const center = (m) => Math.sqrt(m.lo * m.hi);

function grab(c, t, m, w = 1) {
  const f = center(m) * c.bright;
  nz(c, t, { type: "bandpass", f, q: f / (m.hi - m.lo) + 0.3, peak: 1.6 * w, att: 0.012, dec: m.dec, dur: 0.45 });
  grains(c, t, m.crunch, c.vel, 0.45 * w, m.lo);
  if (m.thump) osc(c, t, { f: 110 * c.pitch, peak: m.thump * w, dec: 0.03 });
  if (m.creak) {
    const bp = A.ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 6; bp.connect(c.out);
    osc(c, t, { type: "sawtooth", f: 95 * c.pitch, fEnd: 125 * c.pitch, fTau: 0.06, peak: 0.35 * w, att: 0.02, dec: 0.12, dest: bp });
  }
}

function zip(c, t) {
  const n = 22;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    nz(c, t + 0.3 * u + rand(-0.004, 0.004), { type: "bandpass", f: 3000 * c.pitch * (1 + 0.3 * u), q: 5, peak: 1.2, dec: 0.0035, dur: 0.05 });
  }
}

/* --------------------------------------------------------------- movement */

const MOVE = {
  swish: { f: 1400, q: 1.4 },
  heavy: { f: 600, q: 0.9 },
  blade: { f: 2200, q: 2, ring: true },
  body: { f: 900, q: 1.1, thud: true },
};

function thud(c, t, w = 1) {
  osc(c, t, { f: 95 * c.pitch, fEnd: 50 * c.pitch, fTau: 0.03, peak: 0.9 * w, dec: 0.08 });
  nz(c, t, { type: "highpass", f: 1800, peak: 0.7 * w, dec: 0.015 });
  nz(c, t, { type: "lowpass", f: 800, peak: 0.5 * w, dec: 0.05 });
}

function bladeRing(c, t) {
  nz(c, t, { type: "highpass", f: 5000, peak: 0.35, att: 0.08, dec: 0.2, dur: 0.8 });
  osc(c, t, { f: 3600 * c.pitch, peak: 0.08, att: 0.05, dec: 0.5, dur: 2.5 });
}

/* ------------------------------------------------------------ the library */

export const LIB = {
  footsteps: {
    name: "Footsteps", verb: 0.15, texture: null,
    presets: { concrete: "Concrete", wood: "Wood", gravel: "Gravel", grass: "Grass", snow: "Snow" },
    labels: { a: "Step", b: "Scuff", c: "Squeak", fist: "Stomp", swipe: "Shuffle", texture: null },
    play(k, c, p) {
      const s = FOOT[p], t = c.t;
      if (k === "a") { footContact(c, t, s, c.vel, 1); footContact(c, t + (0.11 - 0.075 * c.vel) * rv(c, 0.15), s, c.vel * 0.7, 0.45); }
      else if (k === "b") scuff(c, t, s, 1);
      else if (k === "c") {
        const f = 1500 * c.pitch * rv(c, 0.15), bp = A.ctx.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = f * 1.2; bp.Q.value = 4; bp.connect(c.out);
        osc(c, t, { type: "sawtooth", f, fEnd: f * 1.35, fTau: 0.05, peak: 0.5, att: 0.01, dec: 0.06, dest: bp });
      }
      else if (k === "fist") { footContact(c, t, s, 1, 1.3); footContact(c, t + 0.012, s, 0.9, 1); osc(c, t, { f: 120 * c.pitch, fEnd: 45 * c.pitch, fTau: 0.03, peak: 0.9, dec: 0.14 }); }
      else if (k === "swipe") [[0, 0.8], [0.09, 0.55], [0.17, 0.35]].forEach(([d, w]) => scuff(c, t + d, s, w));
    },
  },
  cinematic: {
    name: "Cinematic", verb: 0.6, texture: "drone",
    presets: { epic: "Epic Hit", deep: "Deep Boom", metal: "Metal Impact", scifi: "Sci-Fi" },
    labels: { a: "Hit", b: "Braam", c: "Riser", fist: "Boom", swipe: "Whoosh", texture: "Drone" },
    play(k, c, p) {
      const s = CIN[p], t = c.t;
      if (k === "a") hit(c, t, s);
      else if (k === "b") braam(c, t, s);
      else if (k === "c") riser(c, t, s);
      else if (k === "fist") {
        hit(c, t, s, 1.4, 4);
        nz(c, t, { type: "highpass", f: 2500, peak: 0.6, dec: 0.02 });
        osc(c, t, { f: 30 * c.pitch, peak: 0.8, dec: 0.8, dur: 4 });
      } else if (k === "swipe") {
        whoosh(c, t, { f: 900, q: 1.2, dur: 0.7, from: -0.6 * c.dir, to: 0.6 * c.dir });
        osc(c, t, { f: 300 * c.pitch, fEnd: 80 * c.pitch, fTau: 0.2, peak: 0.15, att: 0.3, dec: 0.2 });
      }
    },
  },
  guns: {
    name: "Guns", verb: 0.35, texture: null,
    presets: { pistol: "Pistol", rifle: "Rifle", shotgun: "Shotgun", silenced: "Silenced" },
    labels: { a: "Shot", b: "Reload", c: "Shell drop", fist: "Burst", swipe: "Whiz-by", texture: null },
    play(k, c, p) {
      const g = GUN[p], t = c.t;
      if (k === "a") shot(c, t, g);
      else if (k === "b") reload(c, t);
      else if (k === "c") casing(c, t);
      else if (k === "fist") for (let i = 0; i < g.burst; i++) shot(c, t + i * g.rate * rv(c, 0.05), g, i ? 0.9 : 1);
      else if (k === "swipe") whizBy(c, t);
    },
  },
  cloth: {
    name: "Cloth", verb: 0.1, texture: "rustle",
    presets: { cotton: "Cotton", denim: "Denim", leather: "Leather", nylon: "Nylon Jacket" },
    labels: { a: "Grab", b: "Snap", c: "Zip", fist: "Body fall", swipe: "Swish", texture: "Rustle" },
    play(k, c, p) {
      const m = CLOTH[p], t = c.t;
      if (k === "a") grab(c, t, m);
      else if (k === "b") {
        nz(c, t, { type: "highpass", f: m.lo * 2 * c.bright, peak: 1.2, dec: 0.022 });
        osc(c, t, { f: 140 * c.pitch, peak: 0.25, dec: 0.02 });
        grains(c, t, m.crunch * 0.6, c.vel, 0.4, m.lo, 0.2);
      } else if (k === "c") zip(c, t);
      else if (k === "fist") {
        osc(c, t, { f: 75 * c.pitch, fEnd: 55 * c.pitch, fTau: 0.04, peak: 1, dec: 0.12 });
        nz(c, t, { type: "lowpass", f: 1500, peak: 0.5, dec: 0.06 });
        grab(c, t + 0.01, { ...m, dec: m.dec * 2.5 }, 0.8);
      } else if (k === "swipe") whoosh(c, t, { f: center(m) * 1.2, q: 1, dur: 0.32, peak: 0.9, from: -0.4 * c.dir, to: 0.4 * c.dir });
    },
  },
  movement: {
    name: "Movement", verb: 0.2, texture: "air",
    presets: { swish: "Swish", heavy: "Heavy Air", blade: "Blade", body: "Body" },
    labels: { a: "Whoosh", b: "Long whoosh", c: "Punch", fist: "Body hit", swipe: "Swing", texture: "Air" },
    play(k, c, p) {
      const m = MOVE[p], t = c.t;
      if (k === "a") { whoosh(c, t, { f: m.f, q: m.q, dur: 0.26 }); if (m.ring) bladeRing(c, t + 0.05); }
      else if (k === "b") whoosh(c, t, { f: m.f * 0.8, q: m.q, dur: 0.6, peak: 0.9 });
      else if (k === "c") { whoosh(c, t, { f: m.f, q: m.q, dur: 0.18 }); thud(c, t + 0.16); }
      else if (k === "fist") { thud(c, t, 1.3); osc(c, t, { f: 60 * c.pitch, peak: 0.6, dec: 0.1 }); }
      else if (k === "swipe") {
        const dur = clamp(0.62 - c.speed * 0.07, 0.18, 0.6);
        whoosh(c, t, { f: m.f, q: m.q, dur, peak: 0.9, from: -0.7 * c.dir, to: 0.7 * c.dir });
        if (m.ring) bladeRing(c, t + dur * 0.4);
        if (m.thud) thud(c, t + dur * 0.8, 0.7);
      }
    },
  },
};

/* --------------------------------------------- texture (continuous layer) */

export function setTexture(cat, preset, pitchMacro) {
  if (!A.ctx) return;
  const ctx = A.ctx;
  if (A.tex) {
    const old = A.tex;
    old.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    setTimeout(() => old.nodes.forEach((n) => { try { n.stop?.(); } catch {} n.disconnect(); }), 400);
    A.tex = null;
  }
  const kind = LIB[cat].texture;
  if (!kind) return;
  const g = ctx.createGain(); g.gain.value = 0;
  const filt = ctx.createBiquadFilter();
  const nodes = [g, filt];
  let base;
  if (kind === "drone") {
    const f = CIN[preset].sub * Math.pow(2, Math.round((pitchMacro - 0.5) * 24) / 12);
    filt.type = "lowpass"; filt.Q.value = 2; base = 500;
    [[1, 0], [1, 7], [2, -5]].forEach(([m, dt]) => {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f * m; o.detune.value = dt;
      const og = ctx.createGain(); og.gain.value = 0.25;
      o.connect(og).connect(filt); o.start(); nodes.push(o, og);
    });
  } else {
    const s = ctx.createBufferSource(); s.buffer = A.noise; s.loop = true; s.start(); nodes.push(s);
    if (kind === "rustle") { filt.type = "bandpass"; filt.Q.value = 0.9; base = center(CLOTH[preset]); }
    else { filt.type = "lowpass"; filt.Q.value = 0.5; base = MOVE[preset].f * 0.7; }
    s.connect(filt);
  }
  filt.connect(g).connect(A.bus);
  A.tex = { kind, g, filt, base, nodes };
}

/** Called every video frame with the open hand's motion (0..1) and height (0..1). */
export function textureFrame(level, height) {
  if (!A.tex) return;
  const now = A.ctx.currentTime, k = A.tex.kind;
  const target = k === "rustle" ? level * rand(0.4, 1) * 2.2 : k === "drone" ? level * 0.5 : level * 2;
  A.tex.g.gain.setTargetAtTime(target, now, k === "drone" ? 0.25 : 0.03);
  A.tex.filt.frequency.setTargetAtTime(fq(A.tex.base * (0.5 + 1.2 * height)), now, 0.08);
}
