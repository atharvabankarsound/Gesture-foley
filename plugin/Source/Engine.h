// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// The sound engine: turns a finger touch (slot + velocity) into sound.
//
// For each touch it reads the blend pad (four corner sounds + an XY point), and for every
// corner that is loud enough it plays one of your samples for that sub-category and finger,
// or the placeholder synth if that cell is empty. Then Size, Variation, Dynamics, Room and Level.
//
// Threading: trigger() and render() run on the audio thread and never lock or allocate.
// setLibrary() and releaseRetired() run on the message thread.
#pragma once

#include "Blend.h"
#include "FallbackSynth.h"
#include "SampleLibrary.h"
#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>

namespace gf
{
    struct Controls
    {
        int folder = 0;
        float x = 0.5f, y = 0.5f;   // blend pad point
        float size = 0.5f;          // 0 small .. 1 large
        float variation = 0.35f;    // random pitch and level per hit
        float dynamics = 0.8f;      // 0 = every hit full level, 1 = fully velocity sensitive
        float room = 0.15f;         // reverb send 0..1
        float levelDb = -2.0f;
    };

    struct Hit
    {
        int samples = 0;   // layers played from your samples
        int synth = 0;     // layers played by the placeholder synth
    };

    class Engine
    {
    public:
        static constexpr int maxVoices = 48;

        explicit Engine (const Taxonomy& t = Taxonomy::builtIn());

        void prepare (double sampleRate, int maxBlockSize);

        // ---- message thread
        void setLibrary (std::shared_ptr<const SampleLibrary> lib);
        void releaseRetired();   // frees a replaced library (call regularly, e.g. from a timer)
        std::shared_ptr<const SampleLibrary> library() const;   // the newest library handed in

        // ---- any thread
        void setCorner (int folder, int corner, int cellIndex);
        int getCorner (int folder, int corner) const;
        std::array<int, 4> corners (int folder) const;
        const Taxonomy& taxonomy() const noexcept { return tax; }

        // ---- audio thread
        void setControls (const Controls& c) noexcept { controls = c; }
        const Controls& getControls() const noexcept { return controls; }
        Hit trigger (int slot, float velocity, float pan = 0.0f) noexcept;
        void render (juce::AudioBuffer<float>& out, int start, int num) noexcept;
        void allNotesOff() noexcept;
        int activeVoices() const noexcept;

        // ---- for the editor: what just played
        std::array<std::atomic<juce::uint32>, numSlots> hitCount {};
        std::atomic<float> lastVelocity { 0 };
        std::atomic<int> lastSlot { -1 }, lastSamples { 0 }, lastSynth { 0 };

    private:
        struct Voice
        {
            const float* left = nullptr;
            const float* right = nullptr;
            int length = 0;
            double pos = 0, rate = 1;
            float gainL = 0, gainR = 0;
            juce::IIRFilter toneL, toneR, shelfL, shelfR;
            bool active = false;
            juce::uint64 started = 0;
        };

        void startVoice (const juce::AudioBuffer<float>& buf, double bufferRate, float gain, float pan,
                         float rate, float brightness) noexcept;
        void adoptPendingLibrary() noexcept;

        const Taxonomy& tax;
        double sampleRate = 48000;
        Controls controls;
        FallbackSynth fallback;
        juce::Random rng;
        juce::uint64 voiceClock = 0;
        std::array<Voice, maxVoices> voices;
        juce::AudioBuffer<float> roomBuffer;
        juce::Reverb reverb;

        std::vector<std::atomic<int>> cornerCells;   // [folder * 4 + corner]
        std::vector<int> lastPick;                   // round robin per library cell
        std::vector<int> fallbackTake;               // round robin per folder x finger

        // library hand-over: the audio thread only ever try-locks
        juce::SpinLock libLock;
        std::shared_ptr<const SampleLibrary> active, pending, retired, newest;
        bool hasPending = false;
        mutable juce::SpinLock newestLock;
    };
}
