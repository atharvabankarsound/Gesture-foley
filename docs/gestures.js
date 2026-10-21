// Gesture engine: turns MediaPipe hand landmarks into performance events.
//
// Gestures (per hand):
//   a      thumb tip touches index tip
//   b      thumb tip touches middle tip
//   c      thumb tip touches ring tip
//   fist   hand closes quickly into a fist
//   swipe  fast sideways movement of an open hand
//   motion continuous 0..1, how much an open hand is moving (drives textures)
//
// All distances are divided by the hand's own size (wrist -> middle-finger base),
// so it behaves the same near or far from the camera.

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const TIPS = [8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];
const PINCH_TIPS = { a: 8, b: 12, c: 16 };

export class Hand {
  constructor() {
    this.pinch = {};
    for (const k in PINCH_TIPS) {
      this.pinch[k] = { tip: PINCH_TIPS[k], down: false, hist: [], last: -1, r: 9, cs: 0 };
    }
    this.openHist = [];
    this.fistArmed = true;
    this.swipeArmed = true;
    this.prevPalm = null;
    this.lastT = null;
    this.vx = 0;
    this.vy = 0;
    this.motion = 0;
    this.openness = 2;
    this.height = 0.5;
    this.palm = { x: 0.5, y: 0.5 };
  }

  /**
   * @param lms     21 landmarks {x, y} normalised to the camera image
   * @param t       time in seconds
   * @param aspect  image width / height (makes x and y distances comparable)
   * @param cfg     {touch, early, gest:{a,b,c,fist,swipe}}
   * @returns array of events {kind, vel, x, y, dir?, speed?}
   */
  update(lms, t, aspect, cfg) {
    const P = (i) => ({ x: lms[i].x * aspect, y: lms[i].y });
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const wrist = P(0);
    const scale = Math.max(dist(wrist, P(9)), 1e-3);
    const ext = {};
    for (const i of TIPS) ext[i] = dist(P(i), wrist) / scale;
    const openness = (ext[8] + ext[12] + ext[16] + ext[20]) / 4;
    this.openness = openness;
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    const events = [];

    // ---- finger contact (pinches) ----
    const press = cfg.touch;            // touching below this
    const release = cfg.touch + 0.17;   // must open past this to re-arm (hysteresis)
    const thumb = P(4);
    let best = null;
    for (const k in this.pinch) {
      const pn = this.pinch[k];
      const tip = P(pn.tip);
      const r = dist(thumb, tip) / scale;
      pn.r = r;
      pn.hist.push([t, r]);
      while (pn.hist.length > 1 && t - pn.hist[0][0] > 0.12) pn.hist.shift();
      const [t0, r0] = pn.hist[0];
      pn.cs = t > t0 ? (r0 - r) / (t - t0) : 0;   // closing speed, hand-sizes per second

      // The other fingers must stay out, so a closing fist doesn't count as a touch.
      const othersOut = TIPS.filter((i) => i !== pn.tip && ext[i] > 1.45).length >= 2;
      let touching = r < press;
      if (!touching && cfg.early && !pn.down && pn.cs > 3 && dt > 0 && r - pn.cs * dt < press) {
        touching = true;   // predicted to touch before the next frame
      }
      if (!pn.down && touching) {
        pn.down = true;
        if (othersOut && cfg.gest[k] && t - pn.last > 0.06 && (!best || r < best.r)) {
          best = { k, r, cs: pn.cs, x: (thumb.x + tip.x) / 2 / aspect, y: (thumb.y + tip.y) / 2 };
        }
      } else if (pn.down && r > release) {
        pn.down = false;
      }
    }
    if (best) {
      this.pinch[best.k].last = t;
      const vel = 0.15 + 0.85 * clamp((best.cs - 1) / 7);
      events.push({ kind: best.k, vel, x: best.x, y: best.y });
    }

    // ---- palm position and speed ----
    let px = 0, py = 0;
    for (const i of PALM) { const p = P(i); px += p.x; py += p.y; }
    px /= PALM.length; py /= PALM.length;
    if (this.prevPalm && dt > 0) {
      const rvx = (px - this.prevPalm.x) / dt, rvy = (py - this.prevPalm.y) / dt;
      this.vx = 0.6 * this.vx + 0.4 * rvx;
      this.vy = 0.6 * this.vy + 0.4 * rvy;
    }
    this.prevPalm = { x: px, y: py };
    this.palm = { x: px / aspect, y: py };
    this.height = clamp(1 - py);
    const open = openness > 1.35;

    // ---- fist ----
    this.openHist.push([t, openness]);
    while (this.openHist.length > 1 && t - this.openHist[0][0] > 0.35) this.openHist.shift();
    let maxO = -1, tMax = t;
    for (const [ht, o] of this.openHist) if (o > maxO) { maxO = o; tMax = ht; }
    if (this.fistArmed && openness < 1.15 && maxO > 1.5) {
      this.fistArmed = false;
      const rate = (maxO - openness) / Math.max(t - tMax, 0.03);
      if (cfg.gest.fist) events.push({ kind: "fist", vel: 0.2 + 0.8 * clamp((rate - 1) / 6), x: this.palm.x, y: this.palm.y });
    } else if (!this.fistArmed && openness > 1.45) {
      this.fistArmed = true;
    }

    // ---- swipe (screen heights per second) ----
    const thr = 2.0;
    const ax = Math.abs(this.vx);
    if (this.swipeArmed && open && ax > thr && ax > 1.5 * Math.abs(this.vy)) {
      this.swipeArmed = false;
      // The image is mirrored on screen: x growing in the camera image means moving left on screen.
      const dir = this.vx > 0 ? -1 : 1;
      if (cfg.gest.swipe) events.push({ kind: "swipe", vel: 0.2 + 0.8 * clamp((ax - thr) / 4), dir, speed: ax, x: this.palm.x, y: this.palm.y });
    } else if (!this.swipeArmed && ax < 0.6) {
      this.swipeArmed = true;
    }

    // ---- continuous motion of an open hand ----
    const sp = Math.hypot(this.vx, this.vy);
    this.motion = 0.85 * this.motion + 0.15 * (open ? clamp((sp - 0.08) / 1.2) : 0);

    return events;
  }
}
