// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Simple synthesised placeholder sounds, so every pad makes a sound before you
// load samples. They are deliberately plain: real recordings are what make it sound good.
#pragma once

#include "Taxonomy.h"
#include <juce_audio_basics/juce_audio_basics.h>

namespace gf
{
    class FallbackSynth
    {
    public:
        static constexpr int takes = 3;   // different renders per sound, played in turn

        /** Render every folder x finger x take at this sample rate. Call off the audio thread. */
        void prepare (const Taxonomy& t, double sampleRate);

        const juce::AudioBuffer<float>* get (int folder, int slot, int take) const;

        /** A stable per-sub-category character: playback-rate and brightness multipliers. */
        static std::pair<float, float> character (const juce::String& cellKey);

    private:
        std::vector<juce::AudioBuffer<float>> buffers;   // [folder][slot][take]
        int numFolders = 0;
    };
}
