// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// XY blend pad maths (same as docs/blend.js).
//
// Corners are ordered [top-left, top-right, bottom-left, bottom-right].
// The point (x, y) runs 0..1 left->right and top->bottom.
// Each corner's share is bilinear, so the four shares always add up to 1:
// at a corner you hear only that sound, in the centre all four equally.
//
// No allocation, so it is safe to call on the audio thread.
#pragma once

#include <juce_core/juce_core.h>
#include <array>
#include <cmath>

namespace gf
{
    inline std::array<float, 4> cornerWeights (float x, float y)
    {
        x = juce::jlimit (0.0f, 1.0f, x);
        y = juce::jlimit (0.0f, 1.0f, y);
        return { (1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y };
    }

    template <typename Key>
    struct Layer
    {
        Key cell {};
        float share = 0;   // 0..1, all layers add up to 1
        float gain = 0;    // equal-power level: sqrt(share)
    };

    template <typename Key>
    struct Blend
    {
        std::array<Layer<Key>, 4> layers {};
        int count = 0;
        const Layer<Key>* begin() const { return layers.data(); }
        const Layer<Key>* end() const { return layers.data() + count; }
    };

    /**
     * The sounds to play for one hit, loudest first.
     * The same sound in two corners is merged; layers below minShare are dropped
     * (they'd be inaudible) and the rest re-normalised.
     */
    template <typename Key>
    Blend<Key> blendLayers (const std::array<Key, 4>& corners, float x, float y, float minShare = 0.04f)
    {
        auto w = cornerWeights (x, y);
        Blend<Key> b;
        for (size_t i = 0; i < 4; ++i)
        {
            int found = -1;
            for (int j = 0; j < b.count; ++j)
                if (b.layers[(size_t) j].cell == corners[i]) found = j;
            if (found >= 0) b.layers[(size_t) found].share += w[i];
            else b.layers[(size_t) b.count++] = { corners[i], w[i], 0 };
        }

        int kept = 0;
        float sum = 0;
        for (int j = 0; j < b.count; ++j)
            if (b.layers[(size_t) j].share >= minShare)
            {
                b.layers[(size_t) kept++] = b.layers[(size_t) j];
                sum += b.layers[(size_t) j].share;
            }
        b.count = kept;
        if (sum <= 0) sum = 1;

        for (int j = 0; j < b.count; ++j)
        {
            auto& l = b.layers[(size_t) j];
            l.share /= sum;
            l.gain = std::sqrt (l.share);
        }
        // insertion sort, loudest first (stable: equal shares keep corner order)
        for (int i = 1; i < b.count; ++i)
            for (int j = i; j > 0 && b.layers[(size_t) j].share > b.layers[(size_t) j - 1].share; --j)
                std::swap (b.layers[(size_t) j], b.layers[(size_t) j - 1]);
        return b;
    }
}
