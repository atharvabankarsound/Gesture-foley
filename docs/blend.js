// XY blend pad maths.
//
// Corners are ordered [top-left, top-right, bottom-left, bottom-right].
// The point (x, y) runs 0..1 left->right and top->bottom.
// Each corner's share is bilinear, so the four shares always add up to 1:
// at a corner you hear only that texture, in the centre all four equally.

export function cornerWeights(x, y) {
  return [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
}

/**
 * The textures to play for one hit.
 * Layers below `min` are dropped (they'd be inaudible) and the rest re-normalised.
 * `gain` is the equal-power level: sqrt(share), so loudness stays even across the
 * pad when two different recordings are mixed.
 * @returns [{tex, w, gain}] sorted loudest first
 */
export function layers(corners, x, y, min = 0.04) {
  const w = cornerWeights(x, y);
  const merged = new Map();
  corners.forEach((tex, i) => merged.set(tex, (merged.get(tex) || 0) + w[i]));   // same texture in two corners
  const kept = [...merged].filter(([, v]) => v >= min);
  const sum = kept.reduce((a, [, v]) => a + v, 0) || 1;
  return kept
    .map(([tex, v]) => ({ tex, w: v / sum, gain: Math.sqrt(v / sum) }))
    .sort((a, b) => b.w - a.w);
}
