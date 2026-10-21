# Gesture Foley

Perform footstep foley with your hands in front of a webcam.
Hand tracking (MediaPipe) → step detection → real-time footsteps **and MIDI into your DAW**.

**Try it in your browser:** https://atharvabankarsound.github.io/Gesture-foley/  
No install needed: allow camera access and touch your thumb to a fingertip.

### Browser version: gestures

| Gesture | Footsteps | Cinematic | Guns | Cloth | Movement |
|---|---|---|---|---|---|
| Thumb + index | Step | Hit | Shot | Grab | Whoosh |
| Thumb + middle | Scuff | Braam | Reload | Snap | Long whoosh |
| Thumb + ring | Squeak | Riser | Shell drop | Zip | Punch |
| Fist | Stomp | Boom | Burst | Body fall | Body hit |
| Swipe sideways | Shuffle | Whoosh | Whiz-by | Swish | Swing |
| Move open hand | – | Drone | – | Rustle | Air |

How fast your fingers close sets the velocity. Hand height shapes the tone, and the left
hand plays on the left of the stereo field, the right hand on the right. Every folder has
several presets, and the Intensity, Tone, Space, Pitch, Variation and Texture knobs shape the sound.

Code: `docs/gestures.js` (gesture detection), `docs/sounds.js` (sound synthesis), `docs/app.js` (UI).

Listen to the built-in surfaces: [`media/surfaces_demo.wav`](media/surfaces_demo.wav)

## Setup (macOS)

Use Python 3.10–3.12 (MediaPipe can lag behind the newest Python).

```bash
cd gesture-foley
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python gesture_foley.py
```

The first run downloads the hand-tracking model (`hand_landmarker.task`, a few MB).
If the camera doesn't open: **System Settings → Privacy & Security → Camera**
and allow Terminal (or VS Code), then run again.

## How to perform

- Hold a hand palm-down, then **tap it down** like a foot landing (on the desk or in mid-air).
- Lift it again to re-arm. Left hand = left foot, right hand = right foot.
- Faster tap = louder, brighter step and a shorter heel-to-toe gap (walk → run).

On screen, the palm dot is **green** (ready), **orange** (falling) or **grey** (landed),
and flashes red on a step. The bar beside it is your downward speed; the red line is
the trigger threshold.

| Key | Action |
|---|---|
| 1 2 3 4 | concrete / wood / gravel / grass |
| m | impact mode (accurate) ↔ onset mode (lower latency) |
| + / − | more / less sensitive |
| space | test footstep |
| q / Esc | quit |

Click the video window before pressing keys.

## Stage 2: recording into Reaper

While the script runs it creates a virtual MIDI port called **Gesture Foley**.
Each step is one MIDI note; velocity = how hard you stepped.

| Surface | Left | Right |
|---|---|---|
| concrete | 36 (C1) | 37 (C#1) |
| wood | 38 (D1) | 39 (D#1) |
| gravel | 40 (E1) | 41 (F1) |
| grass | 42 (F#1) | 43 (G1) |

*(Reaper names octaves differently by default, so it may show 36 as C2. The numbers are what matter.)*

**1. Start the script first**, then open Reaper (the port only exists while the script is running).

**2. Enable the port:** Reaper → Settings/Preferences → Audio → **MIDI Inputs** → right-click
*Gesture Foley* → **Enable input**. If it's missing, start the script and click
*Reset all MIDI devices* (or restart Reaper).

**3. Make a track:** insert a track, click **record-arm**, set its input to
**MIDI → Gesture Foley → All channels**, and turn **record monitoring** on.

**4. Record:** press record and perform along with your video. Your steps appear as notes.
Open the MIDI editor to nudge a step's timing or change its velocity, just like a foley editor would.

### Option A: quick test (sound from Python)
Run `python gesture_foley.py` as normal. You hear the built-in synth while Reaper records the MIDI.

### Option B: real samples in Reaper (the "proper" setup)
1. Run `python gesture_foley.py --no-sound` so you don't hear two sounds at once.
2. On the track, add **ReaSamplOmatic5000** (FX → Instruments).
3. Drag a footstep sample into it and set **Note range start** and **end** to the same note,
   e.g. 36 for concrete/left. Untick **Obey note-offs** so the whole sample plays.
4. Repeat with more RS5K instances (or duplicates) for 37, 38, ... one sample per note.
5. Use different recordings for left and right feet so it doesn't sound robotic.

Free CC0 footsteps are on freesound.org; better still, record your own.

### Other options
```bash
python gesture_foley.py --list-midi            # show MIDI ports
python gesture_foley.py --no-midi              # sound only
python gesture_foley.py --midi-port "loopMIDI Port"   # Windows (virtual ports aren't supported; use loopMIDI)
```

## Tuning tips

- Steps not firing → press `+`. Phantom steps → press `−`.
- Sit 50–80 cm from the camera with good light; speed is measured in screen heights per second,
  so distance changes sensitivity.
- Check "Camera FPS" in the HUD. 30 fps works; 60 fps feels noticeably tighter.
- Recorded notes land slightly late (camera + tracking delay). Select them in Reaper and nudge
  them earlier, or use the track's MIDI input offset. We'll measure and automate this later.

## Roadmap

1. ~~Stage 1: camera → gestures → synthesized steps~~
2. **Stage 2 (this):** MIDI out → editable performance in Reaper
3. JUCE plugin (VST3/AU) with a sample-based engine; this script becomes the companion app
4. Trained gesture classifier, more surfaces and foley types (cloth, impacts, props)
