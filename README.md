# Gesture Foley

Perform foley with your hands in front of a webcam: touch your thumb to a fingertip to play a sound.
Hand tracking (MediaPipe) → gesture detection → real-time sound **and MIDI into your DAW**.

**Try it in your browser:** https://atharvabankarsound.github.io/Gesture-foley/  
No install needed: allow camera access and touch your thumb to a fingertip.

### Browser version

Touch your thumb to one fingertip, then open your hand again. One touch plays one sound.

| Folder | Thumb + index | Thumb + middle | Thumb + ring | Thumb + pinky | Textures (sub-categories) |
|---|---|---|---|---|---|
| Footsteps | Step | Scuff | Squeak | Stomp | 11 textures, 27 sub-categories (e.g. Wood › Floorboard, Deck, Stairs, Creaky) |
| Cloth | Grab | Snap | Zip | Body fall | 8 textures, 17 (e.g. Leather › Jacket, Belt, Gloves) |
| Movement | Whoosh | Long whoosh | Punch | Body hit | 6 textures, 12 (e.g. Stick › Staff, Whip) |
| Impacts & body | Punch | Slap | Kick | Body fall | Flesh, Wood, Metal, Glass, Ground: 14 |
| Props & objects | Pick up | Put down | Open | Close | Door, Drawer, Paper, Glassware, Plastic, Tools: 14 |
| Guns | Shot | Reload | Shell drop | Burst | 6 weapons, indoor/outdoor and more: 12 |
| Jewellery | Jingle | Shake | Drop | Handful | Keys, Coins, Chain, Bracelet, Beads, Bells: 12 |
| Water & elements | Small | Medium | Movement | Big | Water, Fire, Wind, Rain, Mud: 13 |
| Creatures | Step | Run | Scratch | Wings / land | Horse, Dog, Big creature, Bird: 10 |
| Cinematic | Hit | Braam | Riser | Boom | 6 textures, 12 |

143 sub-categories in total.

**Main pad.** Every folder has an XY pad with a sub-category in each corner. Pick each corner from
the menu or step through with the arrows, then drag the point: each hit mixes the four corners by
how close the point is (equal-power, so loudness stays even). *Steer the main pad with your hand*
moves the point with your palm while you perform.

**Layer pad.** A second pad that plays with every hit, from any folder: clothing under footsteps,
keys and chains under horses, whooshes under cinematic hits. *Plays* chooses which of the layer
folder's sounds it adds (the same finger, or always one sound).

**Size.** Small to Large changes the character's weight: pitch (±4 semitones), low end and brightness,
for samples and synth alike.

**Mixer.** Main and Layer channels with level, pan, mute and solo, plus Room (reverb) and Master.

**Templates.** 22 factory templates (Forest walk, Rainy street, Office heels, Soldier, Bar fight,
Car chase, Storm, Ranch, Trailer and more) set the pads, layer, size and layer level in one click.
Save your own, and export or import them as a file to move them between computers.

**Use your own samples.** The sound library grid has a cell for every texture and finger: drop audio
files on a cell, or use *Load a sample folder* on a whole kit folder.
Cells are per sub-category and finger, laid out like `Footsteps/Wood/Stairs/Step/`. Several samples in one cell play in random order, never the same one twice in a row. Samples are saved in
your browser. Empty cells use a synth placeholder.

**Why it's precise:**
- Fingertips are smoothed with a One Euro filter: steady when your hand is still, responsive when it moves.
- Each touch plays once. A finger re-arms only after it opens again (a filled dot on screen means ready, hollow means open your fingers).
- Only the clearly closest finger can play, so two sounds never fire together.
- A hand entering the frame is ignored for 0.3 s, fast hand movement blocks triggers, and a fist doesn't count.

How fast your fingers close sets the velocity (louder and brighter). *Dynamics* sets how much that matters,
*Variation* adds small random pitch and level changes, and *Reverb* adds space.

Code: `docs/gestures.js` (gesture detection), `docs/blend.js` (blend pad maths), `docs/samples.js` (sample playback),
`docs/sounds.js` (sound catalogue and synth placeholders), `docs/templates.js` (factory templates), `docs/app.js` (interface). Bundled samples for everyone can go in
`docs/samples/` (see the README there).

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

## How to perform (Python version)

The Python script uses the same gesture engine as the website and plays footsteps.

| Gesture | Sound |
|---|---|
| Thumb + index touch | Step (heel + toe) |
| Thumb + middle touch | Scuff |
| Thumb + ring touch | Squeak |
| Fist | Stomp |
| Swipe sideways | Shuffle |
| Move open hand | Continuous motion (MIDI CC 1) |

- How fast your fingers close sets the velocity: a quick touch is a hard, running step.
- Open your fingers again before the next touch; holding them together never repeats.
- Left hand = left foot, right hand = right foot (panned left and right).

On screen, a line from your thumb to each fingertip brightens as they get closer, a dot appears
while they're touching, and a ring flashes when a sound fires.

| Key | Action |
|---|---|
| 1–5 | concrete / wood / gravel / grass / snow |
| + / − | touch distance up / down |
| e | early trigger on / off (fires just before contact) |
| space | test step |
| q / Esc | quit |

Click the video window before pressing keys.

## Stage 2: recording into Reaper

While the script runs it creates a virtual MIDI port called **Gesture Foley**.
Each gesture is its own MIDI note, so a sampler can hold a different sound for each;
velocity = how fast your fingers closed.

| Gesture | Left | Right |
|---|---|---|
| Index touch (step) | 36 | 37 |
| Middle touch (scuff) | 38 | 39 |
| Ring touch (squeak) | 40 | 41 |
| Fist (stomp) | 42 | 43 |
| Swipe (shuffle) | 44 | 45 |

Continuous controls are sent as CCs, so you can record and map them in your DAW:

| CC | Meaning |
|---|---|
| 1 (mod wheel) | Open-hand motion, 0–127 |
| 74 | Hand height, 0–127 |
| 20 | Surface: 0 concrete, 1 wood, 2 gravel, 3 grass, 4 snow |

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
   e.g. 36 for left-foot steps. Untick **Obey note-offs** so the whole sample plays.
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

- Touches missed → press `+` (larger touch distance). Sounds firing before your fingers meet → press `−`.
- Keep your other fingers extended while touching; a curled hand is treated as a fist, not a touch.
- Sit 50–80 cm from the camera with good light. Distance doesn't change sensitivity, because
  everything is measured relative to the size of your hand.
- Check "Camera FPS" in the HUD. 30 fps works; 60 fps feels noticeably tighter.
- Recorded notes land slightly late (camera + tracking delay). Select them in Reaper and nudge
  them earlier, or use the track's MIDI input offset. We'll measure and automate this later.

## Roadmap

1. ~~Stage 1: camera → gestures → synthesized steps~~
2. ~~Stage 2: MIDI out → editable performance in Reaper~~
3. ~~Finger-touch gestures, sound library and glass UI in the browser~~
4. JUCE plugin (VST3/AU) with a sample-based engine; this script becomes the companion app
5. Recorded sample library and a trained gesture classifier
