# Bundled samples

Samples in this folder load for everyone who opens the website.
(Samples you drag into the page yourself are saved only in your own browser.)

Put files in `<folder>/<finger>/`, then list them in `manifest.json`:

```
samples/
  manifest.json
  footsteps/
    index/   step_01.wav, step_02.wav, ...   (thumb + index: Step)
    middle/  scuff_01.wav, ...               (thumb + middle: Scuff)
    ring/    squeak_01.wav, ...              (thumb + ring: Squeak)
    pinky/   stomp_01.wav, ...               (thumb + pinky: Stomp)
  cinematic/  guns/  cloth/  movement/  (same four finger folders)
```

```json
{
  "footsteps": {
    "index": ["footsteps/index/step_01.wav", "footsteps/index/step_02.wav"],
    "middle": ["footsteps/middle/scuff_01.wav"]
  }
}
```

Folder keys: `footsteps`, `cinematic`, `guns`, `cloth`, `movement`.
Finger keys: `index`, `middle`, `ring`, `pinky`.

Only add sounds you recorded yourself or that are licensed for redistribution (for example CC0).
Keep files short and trimmed to the sound's start, 48 kHz WAV or MP3, under about 1 MB each.
