// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Your recorded sounds, loaded from a folder on disk and sorted into
// folder / sub-category / finger cells (see Router.h for the folder layout).
//
// A library is built once on a background thread and never changed afterwards,
// so the audio thread can read it without locks.
#pragma once

#include "Taxonomy.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>

namespace gf
{
    struct Sample
    {
        juce::AudioBuffer<float> audio;   // 1 or 2 channels
        double sampleRate = 48000;
        juce::String name;
    };

    struct LoadReport
    {
        int added = 0;          // samples loaded
        int cellsFilled = 0;    // cells with at least one sample
        int unmatched = 0;      // audio files that weren't in a matching folder
        int failed = 0;         // files that couldn't be read
        int skipped = 0;        // over the size or per-cell limits
        bool cancelled = false;
        juce::String summary() const;
    };

    class SampleLibrary
    {
    public:
        static constexpr int maxPerCell = 24;
        static constexpr juce::int64 maxFileBytes = 30 * 1024 * 1024;
        static constexpr double maxSeconds = 20.0;

        explicit SampleLibrary (const Taxonomy& t);

        /** Scan a folder (recursively) and load every audio file that routes to a cell. */
        static std::shared_ptr<SampleLibrary> load (const juce::File& root, const Taxonomy& t,
                                                    const std::atomic<bool>* shouldStop, LoadReport& report);

        /** Flat index of a cell + finger, or -1. */
        int index (int folder, int cell, int slot) const noexcept;
        int numIndices() const noexcept { return (int) cells.size(); }

        const std::vector<std::unique_ptr<Sample>>& at (int flatIndex) const { return cells[(size_t) flatIndex]; }
        int count (int folder, int cell, int slot) const noexcept;
        int countFolder (int folder) const noexcept;
        int total() const noexcept;

        juce::File root;

        /** Add one already-decoded sample (used by load and by the tests). */
        bool add (int folder, int cell, int slot, std::unique_ptr<Sample> s);

    private:
        const Taxonomy& taxonomy;
        std::vector<int> offsets;   // first flat cell of each folder
        std::vector<std::vector<std::unique_ptr<Sample>>> cells;
    };
}
