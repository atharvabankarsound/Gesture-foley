#!/usr/bin/env python3
# Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
"""
Gesture Foley - hand tracker (Python / MIDI)
============================================

Webcam -> MediaPipe hand tracking -> finger touches -> MIDI for the Gesture Foley plugin.

Same touch engine as the website (docs/gestures.js): touch your thumb to a fingertip.

  Thumb + index     sound 1      Thumb + ring      sound 3
  Thumb + middle    sound 2      Thumb + pinky     sound 4

It fires once per touch, only for the clearly closest finger, never during fast hand
movement, never from a fist, and not in a hand's first 0.3 s in frame. How fast the
fingers close sets the velocity.

MIDI (virtual port "Gesture Foley"), the plugin's map:

  Notes 40-43   left hand  index, middle, ring, pinky
  Notes 44-47   right hand index, middle, ring, pinky
  CC 16 / 17    blend pad X / Y   (when "pad follows hand" is on)
  CC 18         Size, small to large
  Program 0-9   folder

Keys (click the video window first):
  0-9       folder: 1 Footsteps 2 Cloth 3 Movement 4 Impacts 5 Props 6 Guns
            7 Jewellery 8 Elements 9 Creatures 0 Cinematic
  p         pad follows hand on / off (left hand, or the only hand, moves the blend point)
  [ / ]     Size smaller / larger
  + / -     touch distance up / down (raise it if touches are missed)
  space     test touch (index, left hand)
  q / Esc   quit

The built-in preview sound (footsteps only) plays when MIDI is off, or with --sound.
"""

import argparse
import os
import queue
import sys
import time
import urllib.request

import numpy as np
from scipy.signal import butter, lfilter

try:
    import sounddevice as sd
except Exception:  # PortAudio missing etc. -> run without sound
    sd = None

try:
    import mido
except Exception:  # MIDI is optional
    mido = None

SR = 48000
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")
rng = np.random.default_rng()


def clamp(v, lo=0.0, hi=1.0):
    return min(hi, max(lo, v))


# ---------------------------------------------------------------------------
# Touch engine (a direct port of docs/gestures.js)
# ---------------------------------------------------------------------------

SLOTS = ("index", "middle", "ring", "pinky")
TIP = {"index": 8, "middle": 12, "ring": 16, "pinky": 20}
USED = (0, 4, 5, 8, 9, 12, 16, 17, 20)

DEFAULTS = dict(
    touch=0.22,     # touching when the gap is below this (in hand sizes)
    reopen=0.25,    # must open this much further than `touch` to re-arm
    ratio=0.65,     # closest finger must be this much closer than the next one
    max_speed=3.5,  # hand sizes per second; faster than this blocks triggers
    warmup=0.3,     # seconds a new hand is watched before it can fire
    gap=0.1,        # minimum seconds between two sounds from one hand
)

FOLDERS = ("Footsteps", "Cloth", "Movement", "Impacts & body", "Props & objects", "Guns",
           "Jewellery", "Water & elements", "Creatures", "Cinematic")


class OneEuro:
    """Adaptive low-pass: heavy smoothing when still, light smoothing when moving fast."""

    def __init__(self, min_cutoff=2.0, beta=20.0, d_cutoff=1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.x = None
        self.dx = 0.0
        self.t = None

    @staticmethod
    def alpha(cutoff, dt):
        tau = 1.0 / (2 * np.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def filter(self, x, t):
        if self.x is None:
            self.x, self.t = x, t
            return x
        dt = t - self.t
        if dt <= 0:
            return self.x
        self.t = t
        dx = (x - self.x) / dt
        self.dx += self.alpha(self.d_cutoff, dt) * (dx - self.dx)
        cutoff = self.min_cutoff + self.beta * abs(self.dx)
        self.x += self.alpha(cutoff, dt) * (x - self.x)
        return self.x


class Hand:
    """
    Turns 21 hand landmarks into touch events. Distances are divided by the hand's own
    size (wrist -> middle-finger base), so it behaves the same near or far from the camera.
    """

    def __init__(self, t):
        self.born = t
        self.f = {i: (OneEuro(), OneEuro()) for i in USED}
        self.s = {k: dict(armed=False, r=9.0, hist=[]) for k in SLOTS}
        self.last_fire = -1.0
        self.prev_palm = None
        self.last_t = None
        self.speed = 0.0
        self.pts = {}
        self.ready = False

    def palm(self, aspect):
        P = self.pts
        return ((P[0][0] + P[5][0] + P[9][0] + P[17][0]) / 4 / aspect,
                (P[0][1] + P[5][1] + P[9][1] + P[17][1]) / 4)

    def update(self, lms, t, aspect, cfg=None):
        """lms: 21 (x, y) normalised to the image. Returns [{slot, vel, x, y}]."""
        c = {**DEFAULTS, **(cfg or {})}
        P = self.pts
        for i in USED:
            fx, fy = self.f[i]
            P[i] = (fx.filter(lms[i][0] * aspect, t), fy.filter(lms[i][1], t))

        def d(a, b):
            return float(np.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]))

        scale = max(d(0, 9), 1e-3)
        dt = 0.0 if self.last_t is None else t - self.last_t
        self.last_t = t

        # palm speed in hand sizes per second
        px = (P[0][0] + P[5][0] + P[9][0] + P[17][0]) / 4
        py = (P[0][1] + P[5][1] + P[9][1] + P[17][1]) / 4
        if self.prev_palm is not None and dt > 0:
            sp = np.hypot(px - self.prev_palm[0], py - self.prev_palm[1]) / dt / scale
            self.speed = 0.5 * self.speed + 0.5 * sp
        self.prev_palm = (px, py)

        release = c["touch"] + c["reopen"]
        for k in SLOTS:
            s = self.s[k]
            s["r"] = d(4, TIP[k]) / scale
            s["hist"].append((t, s["r"]))
            while len(s["hist"]) > 1 and t - s["hist"][0][0] > 0.15:
                s["hist"].pop(0)
            if s["r"] > release:
                s["armed"] = True

        # Warm-up for new hands. Fingers already touching stay disarmed.
        self.ready = t - self.born >= c["warmup"]
        if not self.ready:
            for k in SLOTS:
                self.s[k]["armed"] = self.s[k]["r"] > release
            return []

        # Fast movement blocks triggers and disarms fingers that are closed.
        if self.speed > c["max_speed"]:
            for k in SLOTS:
                if self.s[k]["r"] < release:
                    self.s[k]["armed"] = False
            return []

        # Only the clearly closest finger.
        order = sorted(((k, self.s[k]["r"]) for k in SLOTS), key=lambda kv: kv[1])
        k, r = order[0]
        s = self.s[k]
        if not s["armed"] or r >= c["touch"] or r >= c["ratio"] * order[1][1] or t - self.last_fire < c["gap"]:
            return []

        # At least two of the other fingers extended (not a fist).
        extended = sum(1 for o in SLOTS if o != k and d(TIP[o], 0) / scale > 1.3)
        if extended < 2:
            s["armed"] = False
            return []

        # Velocity from how fast the gap closed over the last 150 ms.
        r_max, t_max = r, t
        for ht, hr in s["hist"]:
            if hr > r_max:
                r_max, t_max = hr, ht
        closing = (r_max - r) / max(t - t_max, 0.02)
        vel = 0.15 + 0.85 * clamp((closing - 1) / 7)

        s["armed"] = False          # one sound per touch
        self.last_fire = t
        tip, th = P[TIP[k]], P[4]
        return [dict(slot=k, vel=vel, x=(tip[0] + th[0]) / 2 / aspect, y=(tip[1] + th[1]) / 2)]

# ---------------------------------------------------------------------------
# Preview sound (footsteps on wood; the plugin makes the real sound)
# ---------------------------------------------------------------------------

def _filt(x, kind, freq, order=2):
    nyq = SR / 2
    if kind == "band":
        lo, hi = freq
        lo, hi = max(lo, 20), min(hi, nyq * 0.95)
        b, a = butter(order, [lo / nyq, hi / nyq], btype="band")
    else:
        b, a = butter(order, min(max(freq, 20), nyq * 0.95) / nyq, btype=kind)
    return lfilter(b, a, x)


def _env(n, attack, decay):
    t = np.arange(n) / SR
    return np.minimum(t / max(attack, 1e-4), 1.0) * np.exp(-t / decay)


def _thump(freq, decay, dur, sweep=1.5, tau=0.012):
    """Low body thud with a quick downward pitch sweep (the 'weight' of a step)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = freq * (1 + sweep * np.exp(-t / tau))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * _env(n, 0.001, decay)


def _noise_burst(dur, attack, decay, kind, freq):
    """Filtered noise = the surface texture."""
    n = int(dur * SR)
    return _filt(rng.standard_normal(n), kind, freq) * _env(n, attack, decay)


def _crunch(dur, density, vel):
    """Granular clicks for gravel / snow: many tiny bursts clustered early."""
    n = int(dur * SR)
    out = np.zeros(n)
    for _ in range(int(density * (0.4 + vel))):
        start = int(rng.beta(1.3, 3.0) * (n - 200))
        g = min(int(rng.uniform(0.0008, 0.003) * SR), n - start)
        grain = rng.standard_normal(g) * np.exp(-np.arange(g) / (g / 4))
        out[start:start + g] += grain * rng.uniform(0.2, 1.0)
    return _filt(out, "high", 1800)


SURFACES = {
    "concrete": dict(thump_f=85, thump_decay=0.025, thump_gain=0.5,
                     noise=("low", 3500), n_attack=0.0005, n_decay=0.02, n_gain=0.6, crunch=0),
    "wood":     dict(thump_f=150, thump_decay=0.06, thump_gain=0.8,
                     noise=("band", (250, 1400)), n_attack=0.0005, n_decay=0.04, n_gain=0.5, crunch=0),
    "gravel":   dict(thump_f=70, thump_decay=0.03, thump_gain=0.35,
                     noise=("band", (800, 6000)), n_attack=0.002, n_decay=0.05, n_gain=0.25, crunch=60),
    "grass":    dict(thump_f=60, thump_decay=0.03, thump_gain=0.2,
                     noise=("high", 1500), n_attack=0.008, n_decay=0.06, n_gain=0.4, crunch=12),
    "snow":     dict(thump_f=55, thump_decay=0.04, thump_gain=0.3,
                     noise=("band", (1200, 7000)), n_attack=0.006, n_decay=0.07, n_gain=0.35, crunch=110),
}
SURFACE_NAMES = list(SURFACES)
SOUND_NAMES = {"a": "step", "b": "scuff", "c": "squeak", "fist": "stomp", "swipe": "shuffle"}


def _scaled_filter(s, bright):
    kind, f = s["noise"]
    return kind, ((f[0] * bright, f[1] * bright) if kind == "band" else f * bright)


def _contact(s, vel, weight, dur=0.35):
    pitch = rng.uniform(0.92, 1.08)          # no two steps identical
    kind, f = _scaled_filter(s, 0.6 + 0.8 * vel)
    x = s["thump_gain"] * _thump(s["thump_f"] * pitch, s["thump_decay"], dur)
    x = x + s["n_gain"] * _noise_burst(dur, s["n_attack"], s["n_decay"] * (0.7 + 0.6 * vel), kind, f)
    if s["crunch"]:
        x = x + 0.5 * _crunch(dur, s["crunch"], vel)
    return x * weight


def _scuff(s, vel, weight=1.0, dur=0.4):
    kind, f = s["noise"]
    centre = np.sqrt(f[0] * f[1]) if kind == "band" else f
    centre *= (0.6 + 0.8 * vel) * 0.9
    x = 1.1 * _noise_burst(dur, 0.02, 0.09, "band", (centre * 0.6, centre * 1.6))
    if s["crunch"]:
        x = x + 0.4 * _crunch(dur, s["crunch"] * 1.5, vel)
    x = x + 0.2 * _thump(s["thump_f"], 0.03, dur, sweep=0.3)
    return x * weight


def _squeak(vel, dur=0.25):
    """Rubber sole on a hard floor: a bright, rising, slightly rough tone."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = 1500 * rng.uniform(0.85, 1.15)
    f = f0 * (1.35 - 0.35 * np.exp(-t / 0.05))
    phase = np.cumsum(f) / SR
    saw = 2 * (phase % 1.0) - 1
    return _filt(saw, "band", (f0 * 0.8, f0 * 1.8)) * _env(n, 0.01, 0.06) * 0.8


def _mix(parts, length=None):
    """parts: list of (offset_seconds, signal)."""
    total = length or max(int(off * SR) + len(sig) for off, sig in parts)
    out = np.zeros(total)
    for off, sig in parts:
        i = int(off * SR)
        n = min(len(sig), total - i)
        out[i:i + n] += sig[:n]
    return out


def render(kind, surface, vel):
    """Render one gesture's sound for the given surface. Returns float32 mono."""
    s = SURFACES[surface]
    if kind == "a":       # heel + toe; faster touches shorten the gap (walk -> run)
        gap = float(np.interp(vel, [0, 1], [0.11, 0.035])) * rng.uniform(0.85, 1.15)
        out = _mix([(0, _contact(s, vel, 1.0)), (gap, _contact(s, vel * 0.7, 0.45))])
    elif kind == "b":
        out = _scuff(s, vel)
    elif kind == "c":
        out = _squeak(vel)
    elif kind == "fist":  # both feet landing at once, plus a heavy low thud
        out = _mix([(0, _contact(s, 1.0, 1.3)), (0.012, _contact(s, 0.9, 1.0)),
                    (0, 0.9 * _thump(45, 0.14, 0.5, sweep=1.67, tau=0.03))])   # 120 Hz falling to 45 Hz
    elif kind == "swipe":
        out = _mix([(0, _scuff(s, vel, 0.8)), (0.09, _scuff(s, vel, 0.55)), (0.17, _scuff(s, vel, 0.35))])
    else:
        return np.zeros(1, dtype=np.float32)
    gain = (0.08 + 0.92 * vel ** 1.5) * 10 ** (rng.uniform(-2, 2) / 20)
    out *= 0.9 * gain / (np.max(np.abs(out)) + 1e-9)
    return out.astype(np.float32)



class Mixer:
    """Plays overlapping one-shots from the real-time audio callback."""

    def __init__(self):
        self.q = queue.Queue()
        self.active = []

    def play(self, buf, pan=0.0):
        # constant-power pan
        a = (pan + 1) * np.pi / 4
        self.q.put((buf, np.cos(a), np.sin(a)))

    def callback(self, outdata, frames, time_info, status):
        while True:
            try:
                buf, gl, gr = self.q.get_nowait()
                self.active.append([buf, 0, gl, gr])
            except queue.Empty:
                break
        out = np.zeros((frames, 2), dtype=np.float32)
        still = []
        for v in self.active:
            buf, pos, gl, gr = v
            n = min(frames, len(buf) - pos)
            out[:n, 0] += buf[pos:pos + n] * gl
            out[:n, 1] += buf[pos:pos + n] * gr
            v[1] += n
            if v[1] < len(buf):
                still.append(v)
        self.active = still
        np.tanh(out, out=out)   # gentle soft-clip when sounds overlap
        outdata[:] = out


# ---------------------------------------------------------------------------
# MIDI output
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# MIDI output (the Gesture Foley plugin's map)
# ---------------------------------------------------------------------------

NOTE_BASE = {"centre": 36, "left": 40, "right": 44}
CC_X, CC_Y, CC_SIZE = 16, 17, 18
PREVIEW_KIND = {"index": "a", "middle": "b", "ring": "c", "pinky": "fist"}


def note_for(slot, side):
    return NOTE_BASE[side] + SLOTS.index(slot)


def midi_velocity(vel):
    return int(np.clip(round(1 + vel * 126), 1, 127))


class MidiOut:
    """One short note per touch; CCs only sent when their value changes."""

    def __init__(self, port_name=None, virtual_name="Gesture Foley", channel=0, note_len=0.1):
        if port_name:   # connect to an existing port (needed on Windows, e.g. loopMIDI)
            self.port = mido.open_output(port_name)
            self.name = port_name
        else:           # create a virtual port (macOS / Linux)
            self.port = mido.open_output(virtual_name, virtual=True)
            self.name = virtual_name + " (virtual)"
        self.channel, self.note_len = channel, note_len
        self.pending = []   # [(release_time, note)]
        self.cc_last = {}

    def _send(self, msg_type, **kw):
        self.port.send(mido.Message(msg_type, channel=self.channel, **kw))

    def note(self, note, vel, t):
        for i, (_, n) in enumerate(self.pending):     # retrigger cleanly if still held
            if n == note:
                self._send("note_off", note=note, velocity=0)
                del self.pending[i]
                break
        self._send("note_on", note=note, velocity=midi_velocity(vel))
        self.pending.append((t + self.note_len, note))

    def cc(self, control, value01, force=False):
        v = int(round(clamp(value01) * 127))
        if force or self.cc_last.get(control) != v:
            self.cc_last[control] = v
            self._send("control_change", control=control, value=v)

    def program(self, n):
        self._send("program_change", program=n)

    def tick(self, t):
        for _, note in [p for p in self.pending if p[0] <= t]:
            self._send("note_off", note=note, velocity=0)
        self.pending = [p for p in self.pending if p[0] > t]

    def close(self):
        for _, note in self.pending:
            self._send("note_off", note=note, velocity=0)
        self.pending = []
        self.port.close()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def ensure_model():
    if not os.path.exists(MODEL_PATH):
        print("Downloading hand-tracking model (one time, a few MB)...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


BONES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11),
         (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]
COLOURS = {"left": (255, 210, 100), "right": (10, 159, 255)}   # BGR: light blue / orange


def steer_target(palm):
    """Palm position (image coords) -> blend pad point. The middle 60% of the frame covers the pad."""
    px, py = palm
    return clamp((1 - px - 0.2) / 0.6), clamp((py - 0.15) / 0.6)


def main():
    ap = argparse.ArgumentParser(description="Gesture Foley hand tracker - finger touches to MIDI")
    ap.add_argument("--camera", type=int, default=0, help="camera index (try 1 for an external webcam)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=60, help="requested camera fps (camera may give less)")
    ap.add_argument("--sound", action="store_true", help="play the built-in footstep preview even with MIDI on")
    ap.add_argument("--no-midi", action="store_true", help="disable MIDI output (preview sound only)")
    ap.add_argument("--one-channel", action="store_true",
                    help="send both hands on notes 36-39 (no left/right pan in the plugin)")
    ap.add_argument("--midi-port", default=None,
                    help="send to an existing MIDI port instead of creating a virtual one "
                         "(required on Windows, e.g. a loopMIDI port)")
    ap.add_argument("--list-midi", action="store_true", help="list MIDI output ports and exit")
    args = ap.parse_args()

    if args.list_midi:
        if mido is None:
            print("mido is not installed: pip install mido python-rtmidi")
        else:
            print("MIDI outputs:", *mido.get_output_names(), sep="\n  ")
        return

    # Imported here so --list-midi and the tests work without them.
    import cv2
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    midi = None
    if not args.no_midi:
        if mido is None:
            print("MIDI disabled: pip install mido python-rtmidi")
        else:
            try:
                midi = MidiOut(port_name=args.midi_port)
                print(f"MIDI out -> {midi.name}")
            except Exception as e:
                print(f"MIDI disabled ({e}). On Windows, create a loopMIDI port and pass "
                      f"--midi-port \"<name>\" (see --list-midi).")

    ensure_model()

    mixer, stream = None, None
    if midi and not args.sound:
        print("Preview sound off: the plugin makes the sound (add --sound to hear the preview too).")
    elif sd is not None:
        try:
            mixer = Mixer()
            stream = sd.OutputStream(samplerate=SR, channels=2, dtype="float32",
                                     blocksize=256, latency="low", callback=mixer.callback)
            stream.start()
        except Exception as e:
            print(f"Audio disabled ({e}). Touches will only be printed.")
            mixer = None
    else:
        print("sounddevice not available - touches will only be printed.")

    cap = cv2.VideoCapture(args.camera)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    cap.set(cv2.CAP_PROP_FPS, args.fps)
    if not cap.isOpened():
        print("Could not open the camera. On macOS: System Settings > Privacy & Security > "
              "Camera, and allow your Terminal / VS Code.")
        sys.exit(1)

    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL_PATH),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.6,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    cfg = dict(touch=DEFAULTS["touch"])
    folder, size, steer = 0, 0.5, False
    pad = [0.5, 0.5]
    hands, flashes = {}, []
    fps, proc_ms = 0.0, 0.0
    t0 = last_t = time.perf_counter()
    last_ts = -1

    def fire(slot, side, vel, now):
        note = note_for(slot, "centre" if args.one_channel else side)
        msg = f"[{time.strftime('%H:%M:%S')}] {side:<5} thumb+{slot:<6} vel={vel:.2f}  {FOLDERS[folder]}"
        if midi:
            midi.note(note, vel, now)
            msg += f"  -> note {note} vel {midi_velocity(vel)}"
        print(msg)
        if mixer:
            mixer.play(render(PREVIEW_KIND[slot], "wood", vel), pan=-0.25 if side == "left" else 0.25)

    if midi:   # tell the plugin where we start
        midi.program(folder)
        midi.cc(CC_SIZE, size, force=True)
    print("\nReady. Touch your thumb to a fingertip. Press q to quit.\n")

    with vision.HandLandmarker.create_from_options(options) as landmarker:
        while True:
            ok, frame = cap.read()
            t_cap = time.perf_counter()
            if not ok:
                print("Camera frame failed.")
                break
            h, w = frame.shape[:2]
            aspect = w / h

            ts = max(int((t_cap - t0) * 1000), last_ts + 1)   # timestamps must strictly increase
            last_ts = ts
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)

            # Draw on a mirrored view, like a selfie camera.
            view = cv2.flip(frame, 1)
            X = lambda x: int((1 - x) * w)
            Y = lambda y: int(y * h)

            seen = set()
            for lms, hd in zip(result.hand_landmarks, result.handedness):
                # The camera image isn't mirrored, so MediaPipe's "Left" is the performer's right hand.
                side = "right" if hd[0].category_name == "Left" else "left"
                if side in seen:
                    side = "left" if side == "right" else "right"
                seen.add(side)
                hand = hands.get(side) or hands.setdefault(side, Hand(t_cap))
                pts = [(lm.x, lm.y) for lm in lms]
                for e in hand.update(pts, t_cap, aspect, cfg):
                    fire(e["slot"], side, e["vel"], t_cap)
                    flashes.append((e["x"], e["y"], t_cap, side))

                # --- drawing ---
                col = COLOURS[side]
                for a, b in BONES:
                    cv2.line(view, (X(pts[a][0]), Y(pts[a][1])), (X(pts[b][0]), Y(pts[b][1])), (200, 200, 200), 1, cv2.LINE_AA)
                for k in SLOTS:
                    st = hand.s[k]
                    closeness = clamp((0.9 - st["r"]) / (0.9 - cfg["touch"]))
                    if closeness > 0:
                        a, b = pts[4], pts[TIP[k]]
                        cv2.line(view, (X(a[0]), Y(a[1])), (X(b[0]), Y(b[1])), col, 1 + int(3 * closeness), cv2.LINE_AA)
                for k in SLOTS:   # filled = armed (ready to fire), ring = waiting to open again
                    i = TIP[k]
                    cv2.circle(view, (X(pts[i][0]), Y(pts[i][1])), 6, col, -1 if hand.s[k]["armed"] else 1, cv2.LINE_AA)
                cv2.circle(view, (X(pts[4][0]), Y(pts[4][1])), 6, col, -1, cv2.LINE_AA)

            for k in list(hands):
                if k not in seen:
                    del hands[k]

            # Pad follows hand: the left hand (or the only hand) moves the blend point.
            if steer:
                hand = hands.get("left") or hands.get("right")
                if hand and hand.ready:
                    tx, ty = steer_target(hand.palm(aspect))
                    pad[0] += 0.35 * (tx - pad[0])
                    pad[1] += 0.35 * (ty - pad[1])
                    if midi:
                        midi.cc(CC_X, pad[0])
                        midi.cc(CC_Y, pad[1])

            for f in list(flashes):
                x, y, ft, side = f
                age = t_cap - ft
                if age > 0.3:
                    flashes.remove(f)
                    continue
                cv2.circle(view, (X(x), Y(y)), int(12 + age / 0.3 * 30), COLOURS[side], 2, cv2.LINE_AA)

            if midi:
                midi.tick(time.perf_counter())

            now = time.perf_counter()
            dt = now - last_t
            last_t = now
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1 / dt)
            proc_ms = 0.9 * proc_ms + 0.1 * (now - t_cap) * 1000

            hud = [f"Folder: {FOLDERS[folder]}   Size: {size:.1f}   Pad follows hand: {'on' if steer else 'off'}"
                   + (f" ({pad[0]:.2f}, {pad[1]:.2f})" if steer else ""),
                   f"Touch distance: {cfg['touch']:.2f}   Camera FPS: {fps:4.1f}   Processing: {proc_ms:4.1f} ms",
                   f"MIDI: {midi.name if midi else 'off'}   Preview sound: {'on' if mixer else 'off'}"]
            for i, line in enumerate(hud):
                cv2.putText(view, line, (15, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(view, "thumb + index / middle / ring / pinky = sounds 1-4",
                        (15, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (230, 230, 230), 1, cv2.LINE_AA)
            cv2.putText(view, "0-9 folder | p pad follows hand | [ ] size | +/- touch distance | space test | q quit",
                        (15, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (230, 230, 230), 1, cv2.LINE_AA)

            cv2.imshow("Gesture Foley", view)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if ord("0") <= key <= ord("9"):
                folder = (key - ord("1")) % 10     # 1 = first folder ... 0 = tenth
                if midi:
                    midi.program(folder)
                print(f"Folder -> {FOLDERS[folder]}")
            elif key == ord("p"):
                steer = not steer
                print(f"Pad follows hand -> {'on' if steer else 'off'}")
            elif key in (ord("["), ord("]")):
                size = clamp(round(size + (0.1 if key == ord("]") else -0.1), 1))
                if midi:
                    midi.cc(CC_SIZE, size)
                print(f"Size -> {size:.1f}")
            elif key in (ord("+"), ord("=")):
                cfg["touch"] = min(0.45, round(cfg["touch"] + 0.01, 2))
            elif key in (ord("-"), ord("_")):
                cfg["touch"] = max(0.12, round(cfg["touch"] - 0.01, 2))
            elif key == ord(" "):
                fire("index", "left", 0.7, time.perf_counter())

    cap.release()
    cv2.destroyAllWindows()
    if stream:
        stream.stop()
        stream.close()
    if midi:
        midi.close()


if __name__ == "__main__":
    main()
