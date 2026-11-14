// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Exports the folder / texture / sub-category list from the web demo (docs/sounds.js)
// into plugin/Resources/taxonomy.json, so the plugin and the website always agree.
//
//   node plugin/tools/export_taxonomy.mjs
//
// Run it again whenever folders or sub-categories change in docs/sounds.js.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FOLDERS, FOLDER_KEYS } from "../../docs/sounds.js";

const here = dirname(fileURLToPath(import.meta.url));

// Folder-name aliases and default pad corners (kept in step with META in docs/app.js).
const META = {
  footsteps: { alias: ["footsteps", "footstep", "steps", "feet"], corners: ["gravel.fine", "puddle.shallow", "sneakers.hard", "wood.floorboard"] },
  cloth: { alias: ["cloth", "clothes", "clothing", "fabric"], corners: ["cotton.tshirt", "leather.jacket", "nylon.windbreaker", "wool.coat"] },
  movement: { alias: ["movement", "movements", "whooshes"], corners: ["swish.hand", "heavy.swing", "blade.sword", "body.spin"] },
  impacts: { alias: ["impacts", "impact", "fights", "punches"], corners: ["flesh.face", "flesh.body", "wood.plank", "ground.dirt"] },
  props: { alias: ["props", "objects"], corners: ["door.wood", "drawer.wood", "paper.sheet", "glassware.bottle"] },
  guns: { alias: ["guns", "gun", "weapons", "firearms"], corners: ["pistol.indoor", "rifle.outdoor", "shotgun.pump", "silenced.pistol"] },
  jewellery: { alias: ["jewellery", "jewelry", "jewels", "trinkets"], corners: ["keys.small", "coins.few", "chain.fine", "bells.small"] },
  elements: { alias: ["elements", "weather"], corners: ["water.puddle", "fire.torch", "wind.gust", "rain.light"] },
  creatures: { alias: ["creatures", "animals", "creatureshorses"], corners: ["horse.cobble", "dog.wood", "beast.stone", "bird.small"] },
  cinematic: { alias: ["cinematic", "cinematics", "trailer"], corners: ["epic.hit", "deep.sub", "metal.clang", "scifi.laser"] },
};

const folders = FOLDER_KEYS.map((key) => {
  const f = FOLDERS[key];
  const textures = Object.entries(f.textures).map(([tk, t]) => ({
    key: tk,
    name: t.name,
    variants: Object.entries(t.variants).map(([vk, v]) => ({ key: vk, name: v.name })),
  }));
  for (const c of META[key].corners) {
    const [t, v] = c.split(".");
    if (!f.textures[t]?.variants[v]) throw new Error(`default corner ${key}/${c} doesn't exist`);
  }
  return { key, name: f.name, slots: f.slots, aliases: META[key].alias, corners: META[key].corners, textures };
});

const out = join(here, "..", "Resources", "taxonomy.json");
writeFileSync(out, JSON.stringify({ version: 1, slots: ["index", "middle", "ring", "pinky"], folders }, null, 1) + "\n");
const subs = folders.reduce((n, f) => n + f.textures.reduce((m, t) => m + t.variants.length, 0), 0);
console.log(`Wrote ${out}: ${folders.length} folders, ${subs} sub-categories`);
