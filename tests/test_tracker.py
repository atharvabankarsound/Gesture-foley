# Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
"""
Checks the Python touch engine against the website's (docs/gestures.js) on the same
synthetic hand movements, and checks the MIDI map against the plugin's.

    python tests/test_tracker.py      (needs numpy and scipy; node for the comparison)
"""
import json
import math
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import gesture_foley as gf  # noqa: E402

FPS = 30
ASPECT = 16 / 9


def open_hand(cx=0.5, cy=0.6, size=0.12):
    """21 landmarks of an open right hand, fingers up. size = wrist -> middle base (image height units)."""
    s = size
    p = [(0.0, 0.0)] * 21
    p[0] = (cx, cy)
    bases = {5: -0.35, 9: -0.1, 13: 0.12, 17: 0.32}    # x offsets of the finger bases
    for b, dx in bases.items():
        p[b] = (cx + dx * s / ASPECT, cy - s)
        for j in range(1, 4):                          # straight fingers, tip 1.0 hand sizes above base
            p[b + j] = (cx + dx * s / ASPECT, cy - s - j * 0.33 * s)
    for j, (dx, dy) in enumerate([(-0.3, -0.25), (-0.55, -0.45), (-0.75, -0.6), (-0.9, -0.75)], start=1):
        p[j] = (cx + dx * s / ASPECT, cy + dy * s)     # thumb out to the side
    return p


def with_touch(p, tip, amount, size=0.12):
    """Move the thumb tip towards `tip` (amount 0 = open, 1 = touching)."""
    p = list(p)
    tx, ty = p[4]
    fx, fy = p[tip]
    p[4] = (tx + (fx - tx) * amount, ty + (fy - ty) * amount)
    return p


def curl(p, fingers, size=0.12):
    """Fold the given finger tips down onto the palm (a fist)."""
    p = list(p)
    for tip in fingers:
        base = tip - 3
        p[tip] = (p[base][0], p[base][1] + 0.3 * size)
    return p


def scenario():
    frames = []
    t = 0.0

    def add(lms, n=1):
        nonlocal t
        for _ in range(n):
            frames.append({"t": round(t, 6), "lms": [{"x": x, "y": y} for x, y in lms]})
            t += 1 / FPS

    base = open_hand()
    add(base, 15)                                       # warm-up
    for tip in (8, 12, 16, 20):                         # each finger: close fast, hold, open
        for a in (0.3, 0.6, 0.9, 1.0):
            add(with_touch(base, tip, a))
        add(with_touch(base, tip, 1.0), 4)
        for a in (0.6, 0.2, 0.0):
            add(with_touch(base, tip, a))
        add(base, 6)
    for a in (0.2, 0.5, 0.7, 0.85, 0.95, 1.0):          # slow touch: quieter
        add(with_touch(base, 8, a), 2)
    add(base, 8)
    fist = curl(base, (12, 16, 20))                     # fist with index touch: must not fire
    add(fist, 5)
    for a in (0.5, 1.0):
        add(with_touch(fist, 8, a), 2)
    add(base, 10)
    for i in range(12):                                 # fast swipe while touching: must not fire
        add(with_touch(open_hand(cx=0.2 + i * 0.05), 8, min(1.0, i / 4)))
    add(open_hand(cx=0.8), 10)
    return frames


def run_python(frames):
    hand = gf.Hand(frames[0]["t"])
    out = []
    for f in frames:
        for e in hand.update([(p["x"], p["y"]) for p in f["lms"]], f["t"], ASPECT):
            out.append({"t": f["t"], "slot": e["slot"], "vel": round(e["vel"], 4)})
    return out


JS = """
import { Hand } from '%s';
let data = '';
process.stdin.on('data', (c) => data += c).on('end', () => {
  const frames = JSON.parse(data);
  const hand = new Hand(frames[0].t);
  const out = [];
  for (const f of frames) for (const e of hand.update(f.lms, f.t, %r))
    out.push({ t: f.t, slot: e.slot, vel: Math.round(e.vel * 1e4) / 1e4 });
  console.log(JSON.stringify(out));
});
"""


def run_js(frames):
    path = os.path.join(ROOT, "docs", "gestures.js")
    script = JS % ("file://" + path, ASPECT)
    r = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(frames),
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def main():
    ok = True

    def check(cond, msg):
        nonlocal ok
        ok &= bool(cond)
        print(("ok    " if cond else "FAIL  ") + msg)

    frames = scenario()
    py = run_python(frames)
    slots = [e["slot"] for e in py]
    check(slots[:4] == ["index", "middle", "ring", "pinky"], f"each finger fires once, in order: {slots[:4]}")
    check(len(py) == 5, f"5 touches in total (4 fingers + 1 slow), no fist or swipe touches: got {len(py)}")
    if len(py) >= 5:
        check(py[4]["vel"] < py[0]["vel"], f"slow touch is softer ({py[4]['vel']:.2f} < {py[0]['vel']:.2f})")

    if shutil.which("node"):
        js = run_js(frames)
        same = len(js) == len(py) and all(a["slot"] == b["slot"] and abs(a["t"] - b["t"]) < 1e-6
                                          and abs(a["vel"] - b["vel"]) < 1e-3 for a, b in zip(py, js))
        check(same, f"Python and website engines agree ({len(py)} vs {len(js)} touches)")
    else:
        print("skip  node not found: website comparison")

    # MIDI map = the plugin's (plugin/README.md)
    check([gf.note_for(s, "centre") for s in gf.SLOTS] == [36, 37, 38, 39], "centre notes 36-39")
    check([gf.note_for(s, "left") for s in gf.SLOTS] == [40, 41, 42, 43], "left hand notes 40-43")
    check([gf.note_for(s, "right") for s in gf.SLOTS] == [44, 45, 46, 47], "right hand notes 44-47")
    check((gf.CC_X, gf.CC_Y, gf.CC_SIZE) == (16, 17, 18), "CC 16/17 pad, CC 18 size")
    check(gf.midi_velocity(0) == 1 and gf.midi_velocity(1) == 127, "velocity 1-127")
    check(all(abs(v - 0.5) < 1e-9 for v in gf.steer_target((0.5, 0.45))), "centre of the frame = centre of the pad")
    check(len(gf.FOLDERS) == 10, "10 folders")

    print("\nall passed" if ok else "\nFAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
