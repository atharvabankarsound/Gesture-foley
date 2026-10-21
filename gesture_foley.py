#!/usr/bin/env python3
"""
Gesture Foley - Python / MIDI version
=====================================

Webcam -> MediaPipe hand tracking -> gesture detection -> footstep synthesis + MIDI out.

Uses the same gesture engine as the browser version (docs/gestures.js):

  Thumb + index touch    step          (heel + toe)
  Thumb + middle touch   scuff
  Thumb + ring touch     squeak        (sneaker on a hard floor)
  Fist                   stomp         (landing / jump)
  Swipe sideways         shuffle
  Move open hand         continuous motion, sent as MIDI CC 1

How fast your fingers close sets the velocity. Your left hand plays the
left foot, your right hand the right foot.

MIDI (virtual port "Gesture Foley"): one note per gesture and hand, so a
sampler in your DAW can hold a different sample for each.

                   Left   Right
  index (step)      36     37
  middle (scuff)    38     39
  ring (squeak)     40     41
  fist (stomp)      42     43
  swipe (shuffle)   44     45

  CC 1   open-hand motion (0-127)      CC 74  hand height (0-127)
  CC 20  surface (0 concrete, 1 wood, 2 gravel, 3 grass, 4 snow)

Keys (click the video window first):
  1-5       surface: concrete / wood / gravel / grass / snow
  + / -     touch distance up / down (raise if touches are missed)
  e         early trigger on / off (fires just before contact)
  space     play a test step
  q / Esc   quit
"""

import argparse
import os
import queue
import sys
import time
import urllib.request

import cv2
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
# Gesture engine (a direct port of docs/gestures.js)
# ---------------------------------------------------------------------------

TIPS = (8, 12, 16, 20)
PALM = (0, 5, 9, 13, 17)
PINCH_TIPS = {"a": 8, "b": 12, "c": 16}
GESTURES = ("a", "b", "c", "fist", "swipe")


class Hand:
    """
    Turns 21 hand landmarks into events. Distances are divided by the hand's
    own size (wrist -> middle-finger base), so it works at any distance.

      a / b / c  thumb tip touches index / middle / ring tip
      fist       hand closes quickly
      swipe      fast sideways movement of an open hand
      motion     0..1, how much an open hand is moving (continuous)
    """

    def __init__(self):
        self.pinch = {k: dict(tip=t, down=False, hist=[], last=-1.0, r=9.0, cs=0.0) for k, t in PINCH_TIPS.items()}
        self.open_hist = []
        self.fist_armed = True
        self.swipe_armed = True
        self.prev_palm = None
        self.last_t = None
        self.vx = self.vy = 0.0
        self.motion = 0.0
        self.openness = 2.0
        self.height = 0.5
        self.palm = (0.5, 0.5)

    def update(self, lms, t, aspect, cfg):
        """lms: 21 (x, y) in normalised image coords. Returns a list of event dicts."""
        P = [(x * aspect, y) for x, y in lms]

        def dist(i, j):
            return float(np.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]))

        scale = max(dist(0, 9), 1e-3)
        ext = {i: dist(i, 0) / scale for i in TIPS}
        openness = sum(ext.values()) / 4
        self.openness = openness
        dt = 0.0 if self.last_t is None else t - self.last_t
        self.last_t = t
        events = []

        # ---- finger contact ----
        press = cfg["touch"]
        release = cfg["touch"] + 0.17          # hysteresis: must open past this to re-arm
        best = None
        for k, pn in self.pinch.items():
            r = dist(4, pn["tip"]) / scale
            pn["r"] = r
            pn["hist"].append((t, r))
            while len(pn["hist"]) > 1 and t - pn["hist"][0][0] > 0.12:
                pn["hist"].pop(0)
            t0, r0 = pn["hist"][0]
            pn["cs"] = (r0 - r) / (t - t0) if t > t0 else 0.0   # closing speed, hand-sizes/s

            # Other fingers must stay out, so a closing fist doesn't count as a touch.
            others_out = sum(1 for i in TIPS if i != pn["tip"] and ext[i] > 1.45) >= 2
            touching = r < press
            if (not touching and cfg["early"] and not pn["down"] and pn["cs"] > 3
                    and dt > 0 and r - pn["cs"] * dt < press):
                touching = True                  # predicted to touch before the next frame
            if not pn["down"] and touching:
                pn["down"] = True
                if (others_out and cfg["gest"][k] and t - pn["last"] > 0.06
                        and (best is None or r < best["r"])):
                    best = dict(k=k, r=r, cs=pn["cs"],
                                x=(P[4][0] + P[pn["tip"]][0]) / 2 / aspect,
                                y=(P[4][1] + P[pn["tip"]][1]) / 2)
            elif pn["down"] and r > release:
                pn["down"] = False
        if best:
            self.pinch[best["k"]]["last"] = t
            vel = 0.15 + 0.85 * clamp((best["cs"] - 1) / 7)
            events.append(dict(kind=best["k"], vel=vel, x=best["x"], y=best["y"]))

        # ---- palm position and speed ----
        px = sum(P[i][0] for i in PALM) / len(PALM)
        py = sum(P[i][1] for i in PALM) / len(PALM)
        if self.prev_palm is not None and dt > 0:
            self.vx = 0.6 * self.vx + 0.4 * (px - self.prev_palm[0]) / dt
            self.vy = 0.6 * self.vy + 0.4 * (py - self.prev_palm[1]) / dt
        self.prev_palm = (px, py)
        self.palm = (px / aspect, py)
        self.height = clamp(1 - py)
        is_open = openness > 1.35

        # ---- fist ----
        self.open_hist.append((t, openness))
        while len(self.open_hist) > 1 and t - self.open_hist[0][0] > 0.35:
            self.open_hist.pop(0)
        t_max, max_o = max(self.open_hist, key=lambda h: h[1])
        if self.fist_armed and openness < 1.15 and max_o > 1.5:
            self.fist_armed = False
            rate = (max_o - openness) / max(t - t_max, 0.03)
            if cfg["gest"]["fist"]:
                events.append(dict(kind="fist", vel=0.2 + 0.8 * clamp((rate - 1) / 6), x=self.palm[0], y=self.palm[1]))
        elif not self.fist_armed and openness > 1.45:
            self.fist_armed = True

        # ---- swipe (screen heights per second) ----
        thr, ax = 2.0, abs(self.vx)
        if self.swipe_armed and is_open and ax > thr and ax > 1.5 * abs(self.vy):
            self.swipe_armed = False
            if cfg["gest"]["swipe"]:
                # The view is mirrored: x growing in the camera image = moving left on screen.
                events.append(dict(kind="swipe", vel=0.2 + 0.8 * clamp((ax - thr) / 4),
                                   dir=-1 if self.vx > 0 else 1, x=self.palm[0], y=self.palm[1]))
        elif not self.swipe_armed and ax < 0.6:
            self.swipe_armed = True

        # ---- continuous motion of an open hand ----
        sp = float(np.hypot(self.vx, self.vy))
        self.motion = 0.85 * self.motion + 0.15 * (clamp((sp - 0.08) / 1.2) if is_open else 0.0)
        return events


# ---------------------------------------------------------------------------
# Footstep synthesis
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

GESTURE_NOTES = {"a": 36, "b": 38, "c": 40, "fist": 42, "swipe": 44}   # left hand; right = +1
CC_MOTION, CC_HEIGHT, CC_SURFACE = 1, 74, 20


class MidiOut:
    """One short note per gesture event; continuous controls as CCs (only sent when they change)."""

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

    @staticmethod
    def note_for(kind, hand):
        return GESTURE_NOTES[kind] + (1 if hand == "right" else 0)

    @staticmethod
    def midi_velocity(vel):
        return int(np.clip(round(1 + vel * 126), 1, 127))

    def _send(self, msg_type, **kw):
        self.port.send(mido.Message(msg_type, channel=self.channel, **kw))

    def note(self, kind, hand, vel, t):
        note = self.note_for(kind, hand)
        for i, (_, n) in enumerate(self.pending):     # retrigger cleanly if still held
            if n == note:
                self._send("note_off", note=note, velocity=0)
                del self.pending[i]
                break
        self._send("note_on", note=note, velocity=self.midi_velocity(vel))
        self.pending.append((t + self.note_len, note))
        return note

    def cc(self, control, value01):
        v = int(round(clamp(value01) * 127))
        if self.cc_last.get(control) != v:
            self.cc_last[control] = v
            self._send("control_change", control=control, value=v)

    def surface(self, index):
        self.cc_last.pop(CC_SURFACE, None)
        self._send("control_change", control=CC_SURFACE, value=index)
        self.cc_last[CC_SURFACE] = index

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


def main():
    ap = argparse.ArgumentParser(description="Gesture Foley - finger-touch foley with MIDI out")
    ap.add_argument("--camera", type=int, default=0, help="camera index (try 1 for an external webcam)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=60, help="requested camera fps (camera may give less)")
    ap.add_argument("--no-sound", action="store_true", help="MIDI only - let the DAW's sampler make the sound")
    ap.add_argument("--no-midi", action="store_true", help="disable MIDI output")
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

    # Imported here so --list-midi works without them.
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
    if args.no_sound:
        print("Built-in sound off (--no-sound).")
    elif sd is not None:
        try:
            mixer = Mixer()
            stream = sd.OutputStream(samplerate=SR, channels=2, dtype="float32",
                                     blocksize=256, latency="low", callback=mixer.callback)
            stream.start()
        except Exception as e:
            print(f"Audio disabled ({e}). Events will only be printed.")
            mixer = None
    else:
        print("sounddevice not available - events will only be printed.")

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

    cfg = dict(touch=0.25, early=False, gest={g: True for g in GESTURES})
    surface = "concrete"
    hands, flashes = {}, []
    fps, proc_ms = 0.0, 0.0
    t0 = last_t = time.perf_counter()
    last_ts = -1

    def fire(kind, hand, vel, now):
        msg = f"[{time.strftime('%H:%M:%S')}] {SOUND_NAMES[kind]:<8} {hand:<5} vel={vel:.2f}  {surface}"
        if midi:
            note = midi.note(kind, hand, vel, now)
            msg += f"  -> MIDI note {note} vel {MidiOut.midi_velocity(vel)}"
        print(msg)
        if mixer:
            mixer.play(render(kind, surface, vel), pan=-0.25 if hand == "left" else 0.25)

    if midi:
        midi.surface(0)
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
            best_motion, best_height = 0.0, 0.5
            for lms, hd in zip(result.hand_landmarks, result.handedness):
                # The camera image isn't mirrored, so MediaPipe's "Left" is the performer's right hand.
                side = "right" if hd[0].category_name == "Left" else "left"
                if side in seen:
                    side = "left" if side == "right" else "right"
                seen.add(side)
                hand = hands.setdefault(side, Hand())
                pts = [(lm.x, lm.y) for lm in lms]
                for e in hand.update(pts, t_cap, aspect, cfg):
                    fire(e["kind"], side, e["vel"], t_cap)
                    flashes.append((e["x"], e["y"], t_cap, side, e["kind"] in ("fist", "swipe")))
                if hand.motion > best_motion:
                    best_motion, best_height = hand.motion, hand.height

                # --- drawing ---
                col = COLOURS[side]
                for a, b in BONES:
                    cv2.line(view, (X(pts[a][0]), Y(pts[a][1])), (X(pts[b][0]), Y(pts[b][1])), (200, 200, 200), 1, cv2.LINE_AA)
                for k, pn in hand.pinch.items():
                    closeness = clamp((0.9 - pn["r"]) / (0.9 - cfg["touch"]))
                    if closeness > 0:
                        a, b = pts[4], pts[pn["tip"]]
                        cv2.line(view, (X(a[0]), Y(a[1])), (X(b[0]), Y(b[1])), col, 1 + int(3 * closeness), cv2.LINE_AA)
                        if pn["down"]:
                            cv2.circle(view, (X((a[0] + b[0]) / 2), Y((a[1] + b[1]) / 2)), 7, col, -1, cv2.LINE_AA)
                for i in (4, 8, 12, 16):
                    cv2.circle(view, (X(pts[i][0]), Y(pts[i][1])), 5, col, -1, cv2.LINE_AA)

            for k in list(hands):
                if k not in seen:
                    del hands[k]

            for f in list(flashes):
                x, y, ft, side, big = f
                age = t_cap - ft
                if age > 0.3:
                    flashes.remove(f)
                    continue
                radius = int((30 if big else 12) + age / 0.3 * (50 if big else 30))
                cv2.circle(view, (X(x), Y(y)), radius, COLOURS[side], 2, cv2.LINE_AA)

            if midi:
                midi.cc(CC_MOTION, best_motion)
                if seen:
                    midi.cc(CC_HEIGHT, best_height)
                midi.tick(time.perf_counter())

            now = time.perf_counter()
            dt = now - last_t
            last_t = now
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1 / dt)
            proc_ms = 0.9 * proc_ms + 0.1 * (now - t_cap) * 1000

            hud = [f"Surface: {surface}   Touch distance: {cfg['touch']:.2f}   Early: {'on' if cfg['early'] else 'off'}",
                   f"Camera FPS: {fps:4.1f}   Processing: {proc_ms:4.1f} ms   Motion: {best_motion:.2f}",
                   f"MIDI: {midi.name if midi else 'off'}   Sound: {'on' if mixer else 'off'}"]
            for i, line in enumerate(hud):
                cv2.putText(view, line, (15, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(view, "thumb+index step | +middle scuff | +ring squeak | fist stomp | swipe shuffle",
                        (15, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (230, 230, 230), 1, cv2.LINE_AA)
            cv2.putText(view, "1-5 surface | +/- touch distance | e early | space test | q quit",
                        (15, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (230, 230, 230), 1, cv2.LINE_AA)

            cv2.imshow("Gesture Foley", view)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if ord("1") <= key <= ord("5"):
                surface = SURFACE_NAMES[key - ord("1")]
                if midi:
                    midi.surface(key - ord("1"))
                print(f"Surface -> {surface}")
            elif key in (ord("+"), ord("=")):
                cfg["touch"] = min(0.45, round(cfg["touch"] + 0.01, 2))
            elif key in (ord("-"), ord("_")):
                cfg["touch"] = max(0.12, round(cfg["touch"] - 0.01, 2))
            elif key == ord("e"):
                cfg["early"] = not cfg["early"]
                print(f"Early trigger -> {'on' if cfg['early'] else 'off'}")
            elif key == ord(" "):
                fire("a", "left", 0.7, time.perf_counter())

    cap.release()
    cv2.destroyAllWindows()
    if stream:
        stream.stop()
        stream.close()
    if midi:
        midi.close()


if __name__ == "__main__":
    main()
