# Bundled samples

Samples in this folder load for everyone who opens the website.
(Samples you drag into the page yourself are saved only in your own browser.)

Put files in `<folder>/<texture>.<sub-category>/<finger>/`, then list them in `manifest.json`:

```
samples/
  manifest.json
  footsteps/
    wood.stairs/
      index/   step_01.wav, step_02.wav, ...   (thumb + index: Step)
      middle/  scuff_01.wav, ...               (thumb + middle: Scuff)
      ring/    squeak_01.wav, ...              (thumb + ring: Squeak)
      pinky/   stomp_01.wav, ...               (thumb + pinky: Stomp)
    puddle.deep/ ...
```

```json
{
  "footsteps": {
    "wood.stairs": {
      "index": ["footsteps/wood.stairs/index/step_01.wav", "footsteps/wood.stairs/index/step_02.wav"],
      "middle": ["footsteps/wood.stairs/middle/scuff_01.wav"]
    }
  }
}
```

Folder keys: `footsteps`, `cloth`, `movement`, `impacts`, `props`, `guns`, `jewellery`, `elements`, `creatures`, `cinematic`.
Sub-category keys are `texture.variant` from `docs/sounds.js` (for example `wood.stairs`, `heels.marble`, `flesh.face`).
Finger keys: `index`, `middle`, `ring`, `pinky`.

Only add sounds you recorded yourself or that are licensed for redistribution (for example CC0).
Trim each file to the sound's start, and keep it short: 48 kHz WAV or MP3, under about 1 MB.
