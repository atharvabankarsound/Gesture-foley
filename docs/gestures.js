// Gesture engine: thumb-to-fingertip touches only.
//
//   index   thumb tip touches index tip
//   middle  thumb tip touches middle tip
//   ring    thumb tip touches ring tip
//   pinky   thumb tip touches pinky tip
//
// Rules that keep it precise:
//  1. Landmarks are smoothed with a One Euro filter: heavy smoothing when the hand
//     is still (kills tracking jitter), light smoothing when it moves fast (low lag).
//  2. A finger fires once per touch. It re-arms only after it has clearly opened again.
//  3. Only the clearly closest finger can fire, never two at once.
//  4. A new hand is ignored for its first 0.3 s, so a hand entering the frame
//     (or the tracker swapping hands) can't fire by accident.
//  5. During fast hand movement nothing fires; touched fingers must open again first.
//  6. The other fingers must be mostly extended, so making a fist doesn't trigger.
//
// Distances are divided by the hand's own size (wrist -> middle-finger base),
// so it behaves the same near or far from the camera.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

export const SLOTS = ["index", "middle", "ring", "pinky"];
export const TIP = { index: 8, middle: 12, ring: 16, pinky: 20 };
const USED = [0, 4, 5, 8, 9, 12, 16, 17, 20];

export const DEFAULTS = {
  touch: 0.22,      // touching when the gap is below this (in hand sizes)
  reopen: 0.25,     // must open this much further than `touch` to re-arm
  ratio: 0.65,      // closest finger must be this much closer than the next one
  maxSpeed: 3.5,    // hand sizes per second; faster than this blocks triggers
  warmup: 0.3,      // seconds a new hand is watched before it can fire
  gap: 0.1,         // minimum seconds between two sounds from one hand
};

class OneEuro {
  constructor(minCutoff = 2.0, beta = 20, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = t - this.t;
    if (dt <= 0) return this.x;
    this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

export class Hand {
  constructor(t) {
    this.born = t;
    this.f = {};
    for (const i of USED) this.f[i] = [new OneEuro(), new OneEuro()];
    this.s = {};
    for (const k of SLOTS) this.s[k] = { armed: false, r: 9, hist: [] };
    this.lastFire = -1;
    this.prevPalm = null;
    this.lastT = null;
    this.speed = 0;
    this.pts = {};
    this.ready = false;
  }

  /**
   * @param lms    21 landmarks {x, y}, normalised to the camera image
   * @param t      time in seconds
   * @param aspect image width / height
   * @param cfg    overrides for DEFAULTS
   * @returns array of {slot, vel, x, y}
   */
  update(lms, t, aspect, cfg = {}) {
    const c = { ...DEFAULTS, ...cfg };
    const P = this.pts;
    for (const i of USED) {
      P[i] = { x: this.f[i][0].filter(lms[i].x * aspect, t), y: this.f[i][1].filter(lms[i].y, t) };
    }
    const d = (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y);
    const scale = Math.max(d(0, 9), 1e-3);
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;

    // palm speed in hand sizes per second
    const px = (P[0].x + P[5].x + P[9].x + P[17].x) / 4, py = (P[0].y + P[5].y + P[9].y + P[17].y) / 4;
    if (this.prevPalm && dt > 0) {
      const sp = Math.hypot(px - this.prevPalm.x, py - this.prevPalm.y) / dt / scale;
      this.speed = 0.5 * this.speed + 0.5 * sp;
    }
    this.prevPalm = { x: px, y: py };

    const release = c.touch + c.reopen;
    for (const k of SLOTS) {
      const s = this.s[k];
      s.r = d(4, TIP[k]) / scale;
      s.hist.push([t, s.r]);
      while (s.hist.length > 1 && t - s.hist[0][0] > 0.15) s.hist.shift();
      if (s.r > release) s.armed = true;
    }

    // Rule 4: warm-up for new hands. Fingers already touching stay disarmed.
    this.ready = t - this.born >= c.warmup;
    if (!this.ready) {
      for (const k of SLOTS) this.s[k].armed = this.s[k].r > release;
      return [];
    }

    // Rule 5: fast movement blocks triggers and disarms fingers that are closed.
    if (this.speed > c.maxSpeed) {
      for (const k of SLOTS) if (this.s[k].r < release) this.s[k].armed = false;
      return [];
    }

    // Rule 3: only the clearly closest finger.
    const order = SLOTS.map((k) => [k, this.s[k].r]).sort((a, b) => a[1] - b[1]);
    const [k, r] = order[0];
    const s = this.s[k];
    if (!s.armed || r >= c.touch || r >= c.ratio * order[1][1] || t - this.lastFire < c.gap) return [];

    // Rule 6: at least two of the other fingers extended (not a fist).
    const extended = SLOTS.filter((o) => o !== k && d(TIP[o], 0) / scale > 1.3).length;
    if (extended < 2) { s.armed = false; return []; }

    // Velocity from how fast the gap closed over the last 150 ms.
    let rMax = r, tMax = t;
    for (const [ht, hr] of s.hist) if (hr > rMax) { rMax = hr; tMax = ht; }
    const closing = (rMax - r) / Math.max(t - tMax, 0.02);
    const vel = 0.15 + 0.85 * clamp((closing - 1) / 7);

    s.armed = false;           // Rule 2: one sound per touch
    this.lastFire = t;
    const tip = P[TIP[k]], th = P[4];
    return [{ slot: k, vel, x: (tip.x + th.x) / 2 / aspect, y: (tip.y + th.y) / 2 }];
  }
}
