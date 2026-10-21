#!/usr/bin/env python3
"""
Gesture Foley - Stage 1 prototype
==================================

Webcam -> MediaPipe hand tracking -> step detection -> synthesized footsteps.

Tap a hand downward (like a foot landing) and you hear a footstep.
How fast your hand comes down sets the loudness, brightness and
heel-to-toe timing (slow = walking, fast = running).

Stage 2: every step is also sent as a MIDI note to a virtual MIDI port
called "Gesture Foley", so a DAW (e.g. Reaper) can record the performance
as editable notes. Note = surface + foot, velocity = how hard you stepped:

               Left  Right
  concrete      C1    C#1   (36, 37)
  wood          D1    D#1   (38, 39)
  gravel        E1    F1    (40, 41)
  grass         F#1   G1    (42, 43)

Keys (click the video window first):
  1 2 3 4   surface: concrete / wood / gravel / grass
  m         trigger mode: impact (accurate) <-> onset (lower latency)
  + / -     sensitivity up / down
  space     play a test footstep
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

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

SR = 48000
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hand_landmarker.task")
PALM_IDS = (0, 5, 9, 13, 17)  # wrist + finger bases = stable palm centre
rng = np.random.default_rng()


# ---------------------------------------------------------------------------
# Footstep synthesis (simple DSP - replaced by recorded samples in stage 3)
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


def _thump(freq, decay, dur):
    """Low body thud with a quick downward pitch sweep (the 'weight' of a step)."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = freq * (1 + 1.5 * np.exp(-t / 0.012))
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase) * _env(n, 0.001, decay)


def _noise_burst(dur, attack, decay, kind, freq):
    """Filtered noise = the surface texture / scuff."""
    n = int(dur * SR)
    return _filt(rng.standard_normal(n), kind, freq) * _env(n, attack, decay)


def _crunch(dur, density, vel):
    """Granular clicks for gravel / leaves: many tiny bursts clustered early."""
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
}
SURFACE_NAMES = list(SURFACES)


def _contact(s, vel, weight, dur=0.35):
    pitch = rng.uniform(0.92, 1.08)          # no two steps identical
    bright = 0.6 + 0.8 * vel                 # harder steps = brighter
    kind, f = s["noise"]
    f = (f[0] * bright, f[1] * bright) if kind == "band" else f * bright
    x = s["thump_gain"] * _thump(s["thump_f"] * pitch, s["thump_decay"], dur)
    x = x + s["n_gain"] * _noise_burst(dur, s["n_attack"], s["n_decay"] * (0.7 + 0.6 * vel), kind, f)
    if s["crunch"]:
        x = x + 0.5 * _crunch(dur, s["crunch"], vel)
    return x * weight


def render_footstep(surface, vel):
    """Heel + toe. Faster steps shorten the heel-toe gap (walk -> run)."""
    s = SURFACES[surface]
    heel = _contact(s, vel, 1.0)
    toe = _contact(s, vel * 0.7, 0.45)
    gap = int(SR * np.interp(vel, [0, 1], [0.11, 0.035]) * rng.uniform(0.85, 1.15))
    out = np.zeros(gap + len(toe))
    out[:len(heel)] += heel
    out[gap:gap + len(toe)] += toe
    gain = (0.08 + 0.92 * vel ** 1.5) * 10 ** (rng.uniform(-2, 2) / 20)
    out *= 0.9 * gain / (np.max(np.abs(out)) + 1e-9)
    return out.astype(np.float32)


class Mixer:
    """Plays overlapping one-shots from the real-time audio callback."""

    def __init__(self):
        self.q = queue.Queue()
        self.active = []

    def play(self, buf):
        self.q.put(buf)

    def callback(self, outdata, frames, time_info, status):
        while True:
            try:
                self.active.append([self.q.get_nowait(), 0])
            except queue.Empty:
                break
        out = np.zeros(frames, dtype=np.float32)
        still = []
        for v in self.active:
            buf, pos = v
            n = min(frames, len(buf) - pos)
            out[:n] += buf[pos:pos + n]
            v[1] += n
            if v[1] < len(buf):
                still.append(v)
        self.active = still
        np.tanh(out, out=out)  # gentle soft-clip if steps overlap
        outdata[:] = out[:, None]


# ---------------------------------------------------------------------------
# MIDI output (stage 2)
# ---------------------------------------------------------------------------

SURFACE_NOTES = {"concrete": 36, "wood": 38, "gravel": 40, "grass": 42}  # Left foot; Right = +1


class MidiOut:
    """
    Sends each step as a short MIDI note. Note-offs are scheduled and sent
    from the main loop (tick), so nothing ever blocks waiting.
    """

    def __init__(self, port_name=None, virtual_name="Gesture Foley", channel=0, note_len=0.1):
        if port_name:   # connect to an existing port (needed on Windows, e.g. loopMIDI)
            self.port = mido.open_output(port_name)
            self.name = port_name
        else:           # create our own virtual port (macOS / Linux)
            self.port = mido.open_output(virtual_name, virtual=True)
            self.name = virtual_name + " (virtual)"
        self.channel, self.note_len = channel, note_len
        self.pending = []   # [(time_to_release, note)]

    @staticmethod
    def note_for(surface, label):
        return SURFACE_NOTES[surface] + (1 if label.startswith("Right") else 0)

    @staticmethod
    def midi_velocity(vel):
        return int(np.clip(round(1 + vel * 126), 1, 127))

    def step(self, surface, label, vel, t):
        note = self.note_for(surface, label)
        # retrigger cleanly if the same note is still held
        for i, (_, n) in enumerate(self.pending):
            if n == note:
                self.port.send(mido.Message("note_off", note=note, velocity=0, channel=self.channel))
                del self.pending[i]
                break
        self.port.send(mido.Message("note_on", note=note, velocity=self.midi_velocity(vel),
                                    channel=self.channel))
        self.pending.append((t + self.note_len, note))
        return note

    def tick(self, t):
        due = [p for p in self.pending if p[0] <= t]
        for _, note in due:
            self.port.send(mido.Message("note_off", note=note, velocity=0, channel=self.channel))
        self.pending = [p for p in self.pending if p[0] > t]

    def close(self):
        for _, note in self.pending:
            self.port.send(mido.Message("note_off", note=note, velocity=0, channel=self.channel))
        self.pending = []
        self.port.close()


# ---------------------------------------------------------------------------
# Step detection
# ---------------------------------------------------------------------------

class StepDetector:
    """
    Tracks one hand's vertical palm speed (in frame-heights per second).

    ARMED   --fast downward motion-->  FALLING
    FALLING --sudden stop (impact)-->  LANDED   (fires in 'impact' mode)
    LANDED  --hand lifts again----->   ARMED

    'onset' mode fires as soon as the fall starts: lower latency,
    but velocity is estimated earlier so it is less accurate.
    """

    def __init__(self, trig=1.2, vmax=4.0, release=0.3, rearm=-0.2):
        self.trig, self.vmax, self.release, self.rearm = trig, vmax, release, rearm
        self.prev_y = self.prev_t = None
        self.vy = 0.0
        self.state = "ARMED"
        self.peak = 0.0
        self.fall_start = 0.0

    def _vel(self, speed):
        return float(np.clip((speed - self.trig) / (self.vmax - self.trig), 0, 1))

    def update(self, y, t, mode):
        if self.prev_t is None:
            self.prev_y, self.prev_t = y, t
            return None
        dt = t - self.prev_t
        if dt <= 0:
            return None
        raw = (y - self.prev_y) / dt          # +ve = moving down (image y grows downward)
        self.vy = 0.5 * self.vy + 0.5 * raw   # light smoothing against tracking jitter
        self.prev_y, self.prev_t = y, t

        event = None
        if self.state == "ARMED":
            if self.vy > self.trig:
                self.state, self.peak, self.fall_start = "FALLING", self.vy, t
                if mode == "onset":
                    event = self._vel(self.vy * 1.5)  # rough guess of final speed
        elif self.state == "FALLING":
            self.peak = max(self.peak, self.vy)
            if self.vy < self.peak * self.release:
                if mode == "impact":
                    event = self._vel(self.peak)
                self.state = "LANDED"
            elif t - self.fall_start > 0.5:   # slow drift, not a step
                self.state = "LANDED"
        elif self.state == "LANDED":
            if self.vy < self.rearm:
                self.state = "ARMED"
        return event


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def ensure_model():
    if not os.path.exists(MODEL_PATH):
        print("Downloading hand-tracking model (one time, a few MB)...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)


STATE_COLOURS = {"ARMED": (0, 200, 0), "FALLING": (0, 200, 255), "LANDED": (160, 160, 160)}


def main():
    ap = argparse.ArgumentParser(description="Gesture Foley - stage 1")
    ap.add_argument("--camera", type=int, default=0, help="camera index (try 1 for an external webcam)")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=60, help="requested camera fps (camera may give less)")
    ap.add_argument("--no-sound", action="store_true",
                    help="MIDI only - let the DAW's sampler make the sound")
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
            print(f"Audio disabled ({e}). Steps will only be printed.")
            mixer = None
    else:
        print("sounddevice not available - steps will only be printed.")

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

    surface = "concrete"
    mode = "impact"
    trig = 1.2
    detectors, flash_until = {}, {}
    fps, proc_ms = 0.0, 0.0
    t0 = last_t = time.perf_counter()
    last_ts = -1

    def fire(label, vel):
        msg = f"[{time.strftime('%H:%M:%S')}] STEP  {label:<6} vel={vel:.2f}  {surface}"
        if midi:
            note = midi.step(surface, label, vel, time.perf_counter())
            msg += f"  -> MIDI note {note} vel {MidiOut.midi_velocity(vel)}"
        print(msg)
        if mixer:
            mixer.play(render_footstep(surface, vel))

    print("\nReady. Tap a hand downward in front of the camera. Press q to quit.\n")

    with vision.HandLandmarker.create_from_options(options) as landmarker:
        while True:
            ok, frame = cap.read()
            t_cap = time.perf_counter()
            if not ok:
                print("Camera frame failed.")
                break
            frame = cv2.flip(frame, 1)  # mirror view; MediaPipe handedness expects this
            h, w = frame.shape[:2]

            ts = int((t_cap - t0) * 1000)
            ts = max(ts, last_ts + 1)   # timestamps must strictly increase
            last_ts = ts
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts)

            seen = set()
            for lms, hd in zip(result.hand_landmarks, result.handedness):
                label = hd[0].category_name
                if label in seen:
                    label += "2"
                seen.add(label)

                px = float(np.mean([lms[i].x for i in PALM_IDS]))
                py = float(np.mean([lms[i].y for i in PALM_IDS]))
                det = detectors.setdefault(label, StepDetector(trig=trig))
                det.trig = trig
                vel = det.update(py, t_cap, mode)
                if vel is not None:
                    fire(label, vel)
                    flash_until[label] = t_cap + 0.12

                # --- drawing ---
                for lm in lms:
                    cv2.circle(frame, (int(lm.x * w), int(lm.y * h)), 3, (255, 255, 255), -1)
                cx, cy = int(px * w), int(py * h)
                colour = STATE_COLOURS[det.state]
                if flash_until.get(label, 0) > t_cap:
                    cv2.circle(frame, (cx, cy), 45, (0, 0, 255), -1)
                cv2.circle(frame, (cx, cy), 14, colour, -1)
                bar = int(np.clip(det.vy, -2, 5) * 30)   # vertical speed meter
                cv2.rectangle(frame, (cx + 30, cy), (cx + 42, cy + bar), colour, -1)
                cv2.line(frame, (cx + 25, cy + int(trig * 30)), (cx + 47, cy + int(trig * 30)), (0, 0, 255), 2)
                cv2.putText(frame, f"{label} {det.state}", (cx - 40, cy - 25),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2)

            for k in list(detectors):
                if k not in seen:
                    del detectors[k]

            if midi:
                midi.tick(time.perf_counter())

            now = time.perf_counter()
            dt = now - last_t
            last_t = now
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1 / dt)
            proc_ms = 0.9 * proc_ms + 0.1 * (now - t_cap) * 1000

            hud = [f"Surface: {surface}   Mode: {mode}   Sensitivity: {trig:.2f}",
                   f"Camera FPS: {fps:4.1f}   Processing: {proc_ms:4.1f} ms",
                   f"MIDI: {midi.name if midi else 'off'}   Sound: {'on' if mixer else 'off'}"]
            for i, line in enumerate(hud):
                cv2.putText(frame, line, (15, 30 + 28 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
            cv2.putText(frame, "1-4 surface | m mode | +/- sensitivity | space test | q quit",
                        (15, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1)

            cv2.imshow("Gesture Foley - stage 1", frame)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if ord("1") <= key <= ord("4"):
                surface = SURFACE_NAMES[key - ord("1")]
                print(f"Surface -> {surface}")
            elif key == ord("m"):
                mode = "onset" if mode == "impact" else "impact"
                print(f"Mode -> {mode}")
            elif key in (ord("+"), ord("=")):
                trig = max(0.4, trig - 0.1)
            elif key in (ord("-"), ord("_")):
                trig = min(3.0, trig + 0.1)
            elif key == ord(" "):
                fire("test", 0.7)

    cap.release()
    cv2.destroyAllWindows()
    if stream:
        stream.stop()
        stream.close()
    if midi:
        midi.close()


if __name__ == "__main__":
    main()
