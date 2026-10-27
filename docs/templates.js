// Factory templates: ready-made setups for each folder.
// A template sets the main pad, the layer pad, the size and (optionally) mixer levels.
// Texture keys are "texture.variant" from sounds.js.

const L = (cat, corners, x = 0.5, y = 0.5, follow = "index") => ({ on: true, cat, corners, x, y, follow });

export const FACTORY = [
  { cat: "footsteps", name: "Forest walk", size: 0.55, main: { corners: ["dirt.dry", "grass.long", "gravel.coarse", "wood.deck"], x: 0.3, y: 0.35 },
    layer: L("cloth", ["canvas.bag", "wool.coat", "denim.jeans", "leather.jacket"]) },
  { cat: "footsteps", name: "Rainy street", size: 0.5, main: { corners: ["puddle.shallow", "concrete.pavement", "puddle.deep", "dirt.mud"], x: 0.45, y: 0.3 },
    layer: L("cloth", ["nylon.windbreaker", "nylon.backpack", "denim.jeans", "cotton.tshirt"], 0.3, 0.3) },
  { cat: "footsteps", name: "Office heels", size: 0.35, main: { corners: ["heels.marble", "heels.wood", "concrete.tiles", "wood.floorboard"], x: 0.2, y: 0.2 },
    layer: L("cloth", ["silk.dress", "cotton.shirt", "wool.coat", "silk.scarf"], 0.3, 0.3) },
  { cat: "footsteps", name: "Soldier", size: 0.7, main: { corners: ["boots.combat", "gravel.coarse", "dirt.mud", "metal.catwalk"], x: 0.3, y: 0.3 },
    layer: L("cloth", ["armour.chainmail", "canvas.bag", "leather.belt", "armour.plate"], 0.4, 0.3) },

  { cat: "cloth", name: "Casual", size: 0.5, main: { corners: ["cotton.tshirt", "denim.jeans", "nylon.windbreaker", "wool.jumper"], x: 0.4, y: 0.4 },
    layer: { on: false, cat: "jewellery", corners: ["keys.small", "coins.few", "chain.fine", "bells.small"], x: 0.5, y: 0.5, follow: "index" } },
  { cat: "cloth", name: "Adventurer", size: 0.6, main: { corners: ["leather.jacket", "canvas.bag", "wool.coat", "armour.chainmail"], x: 0.35, y: 0.4 },
    layer: L("jewellery", ["keys.big", "coins.pocket", "chain.heavy", "bells.small"], 0.4, 0.4) },

  { cat: "movement", name: "Sword fight", size: 0.55, main: { corners: ["blade.sword", "blade.knife", "swish.arm", "heavy.swing"], x: 0.25, y: 0.3 },
    layer: L("cloth", ["leather.jacket", "armour.chainmail", "canvas.tarp", "wool.coat"], 0.3, 0.4) },
  { cat: "movement", name: "Martial arts", size: 0.45, main: { corners: ["swish.hand", "body.spin", "body.dodge", "stick.staff"], x: 0.35, y: 0.35 },
    layer: L("cloth", ["cotton.tshirt", "cotton.shirt", "silk.dress", "denim.jeans"], 0.2, 0.3) },

  { cat: "impacts", name: "Bar fight", size: 0.55, main: { corners: ["flesh.face", "flesh.body", "wood.crate", "glass.bottle"], x: 0.3, y: 0.3 },
    layer: L("cloth", ["leather.jacket", "denim.jacket", "cotton.tshirt", "wool.jumper"], 0.4, 0.4) },
  { cat: "impacts", name: "Car chase", size: 0.65, main: { corners: ["metal.car", "glass.window", "ground.concrete", "metal.sheet"], x: 0.35, y: 0.35 },
    layer: { on: false, cat: "cloth", corners: ["leather.jacket", "denim.jacket", "cotton.tshirt", "wool.jumper"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "props", name: "Kitchen", size: 0.45, main: { corners: ["drawer.wood", "glassware.cup", "glassware.bottle", "plastic.box"], x: 0.4, y: 0.4 },
    layer: { on: false, cat: "cloth", corners: ["cotton.tshirt", "leather.jacket", "denim.jeans", "nylon.windbreaker"], x: 0.5, y: 0.5, follow: "index" } },
  { cat: "props", name: "Office", size: 0.5, main: { corners: ["paper.sheet", "paper.book", "drawer.metal", "door.wood"], x: 0.3, y: 0.3 },
    layer: { on: false, cat: "cloth", corners: ["cotton.shirt", "wool.jumper", "silk.dress", "denim.jeans"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "guns", name: "Indoor firefight", size: 0.5, main: { corners: ["pistol.indoor", "rifle.indoor", "shotgun.pump", "revolver.indoor"], x: 0.3, y: 0.3 },
    layer: { on: false, cat: "movement", corners: ["swish.hand", "swish.arm", "body.dodge", "body.spin"], x: 0.5, y: 0.5, follow: "index" } },
  { cat: "guns", name: "Outdoor range", size: 0.55, main: { corners: ["pistol.outdoor", "rifle.outdoor", "heavy.light", "revolver.outdoor"], x: 0.35, y: 0.35 },
    layer: { on: false, cat: "movement", corners: ["swish.hand", "swish.arm", "body.dodge", "body.spin"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "jewellery", name: "Pocket", size: 0.5, main: { corners: ["keys.small", "coins.pocket", "keys.big", "coins.few"], x: 0.4, y: 0.4 },
    layer: L("cloth", ["denim.jeans", "cotton.tshirt", "leather.jacket", "wool.coat"], 0.3, 0.3) },
  { cat: "jewellery", name: "Bling", size: 0.4, main: { corners: ["chain.fine", "bracelet.bangles", "beads.glass", "bells.small"], x: 0.4, y: 0.4 },
    layer: { on: false, cat: "cloth", corners: ["silk.dress", "cotton.shirt", "silk.scarf", "leather.gloves"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "elements", name: "Storm", size: 0.6, main: { corners: ["rain.heavy", "wind.gust", "water.sea", "wind.whistle"], x: 0.35, y: 0.35 },
    layer: { on: false, cat: "cloth", corners: ["nylon.windbreaker", "canvas.tarp", "nylon.backpack", "wool.coat"], x: 0.5, y: 0.5, follow: "index" } },
  { cat: "elements", name: "Campfire", size: 0.5, main: { corners: ["fire.campfire", "fire.torch", "water.puddle", "mud.squelch"], x: 0.3, y: 0.3 },
    layer: { on: false, cat: "cloth", corners: ["wool.coat", "canvas.bag", "leather.jacket", "cotton.tshirt"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "creatures", name: "Ranch", size: 0.55, main: { corners: ["horse.cobble", "horse.dirt", "dog.wood", "dog.grass"], x: 0.3, y: 0.3 },
    layer: L("jewellery", ["chain.heavy", "bells.small", "keys.small", "chain.fine"], 0.3, 0.3), mixer: { layer: { db: -12 } } },
  { cat: "creatures", name: "Dragon", size: 0.9, main: { corners: ["beast.stone", "beast.dirt", "bird.large", "horse.bridge"], x: 0.3, y: 0.3 },
    layer: { on: false, cat: "movement", corners: ["heavy.swing", "heavy.sweep", "cape.cloak", "cape.flag"], x: 0.5, y: 0.5, follow: "index" } },

  { cat: "cinematic", name: "Trailer", size: 0.6, main: { corners: ["epic.hit", "deep.boom", "metal.clang", "taiko.ensemble"], x: 0.35, y: 0.35 },
    layer: L("movement", ["heavy.swing", "heavy.sweep", "swish.arm", "cape.cloak"], 0.3, 0.3, "middle"), mixer: { layer: { db: -10 } } },
  { cat: "cinematic", name: "Sci-Fi", size: 0.5, main: { corners: ["scifi.laser", "scifi.glitch", "deep.sub", "metal.resonant"], x: 0.3, y: 0.3 },
    layer: { on: false, cat: "movement", corners: ["heavy.swing", "heavy.sweep", "swish.arm", "cape.cloak"], x: 0.5, y: 0.5, follow: "index" } },
];
