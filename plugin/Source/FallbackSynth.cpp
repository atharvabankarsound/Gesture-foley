// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "FallbackSynth.h"
#include <cmath>

namespace gf
{
    namespace
    {
        // One hit: a filtered noise burst, an optional low "thump", an optional ringing
        // tone and optional crackle, under an attack/decay envelope.
        struct Recipe
        {
            float noiseHz = 1000, noiseQ = 0.8f, noiseGain = 1;
            float attack = 0.002f, decay = 0.08f, length = 0.35f;
            float thumpHz = 0, thumpGain = 0, thumpDecay = 0.06f;
            float ringHz = 0, ringGain = 0, ringDecay = 0.1f;
            float crackle = 0;    // 0..1 density of little clicks
            float sweep = 0;      // noise filter moves up (+) or down (-) by this many octaves
        };

        Recipe baseRecipe (const juce::String& folder)
        {
            Recipe r;
            if (folder == "footsteps") { r.noiseHz = 900; r.decay = 0.06f; r.thumpHz = 95; r.thumpGain = 0.8f; }
            else if (folder == "cloth") { r.noiseHz = 3200; r.noiseQ = 0.5f; r.attack = 0.04f; r.decay = 0.12f; r.crackle = 0.25f; r.noiseGain = 0.6f; }
            else if (folder == "movement") { r.noiseHz = 700; r.noiseQ = 1.4f; r.attack = 0.12f; r.decay = 0.16f; r.length = 0.6f; r.sweep = 1.2f; }
            else if (folder == "impacts") { r.noiseHz = 1500; r.decay = 0.04f; r.thumpHz = 80; r.thumpGain = 1; r.thumpDecay = 0.08f; }
            else if (folder == "props") { r.noiseHz = 2200; r.decay = 0.03f; r.ringHz = 620; r.ringGain = 0.5f; r.ringDecay = 0.09f; }
            else if (folder == "guns") { r.noiseHz = 1500; r.noiseQ = 0.5f; r.decay = 0.22f; r.thumpHz = 55; r.thumpGain = 1; r.thumpDecay = 0.15f; r.crackle = 0.15f; r.length = 0.8f; }
            else if (folder == "jewellery") { r.noiseHz = 6000; r.noiseGain = 0.25f; r.decay = 0.02f; r.ringHz = 3400; r.ringGain = 0.35f; r.ringDecay = 0.18f; r.crackle = 0.4f; }
            else if (folder == "elements") { r.noiseHz = 1800; r.noiseQ = 0.4f; r.attack = 0.05f; r.decay = 0.3f; r.length = 0.9f; r.crackle = 0.5f; r.noiseGain = 0.6f; }
            else if (folder == "creatures") { r.noiseHz = 700; r.decay = 0.07f; r.thumpHz = 120; r.thumpGain = 0.8f; r.thumpDecay = 0.07f; }
            else if (folder == "cinematic") { r.noiseHz = 400; r.decay = 0.5f; r.thumpHz = 42; r.thumpGain = 1; r.thumpDecay = 0.6f; r.length = 1.6f; r.sweep = -1.5f; }
            return r;
        }

        // The four fingers: main hit, a longer/brighter drag, a higher/tonal one, a heavy one.
        Recipe forSlot (Recipe r, int slot)
        {
            switch (slot)
            {
                case 1: r.noiseHz *= 1.8f; r.attack = juce::jmax (r.attack, 0.03f); r.decay *= 2.2f; r.length *= 1.3f; r.thumpGain *= 0.3f; break;
                case 2: r.noiseHz *= 2.4f; r.decay *= 0.8f; r.ringHz = r.ringHz > 0 ? r.ringHz * 1.6f : 1700; r.ringGain = juce::jmax (r.ringGain, 0.3f); break;
                case 3:
                    r.noiseHz *= 0.6f; r.decay *= 1.4f; r.length *= 1.2f;
                    r.thumpHz = r.thumpHz > 0 ? r.thumpHz * 0.75f : 70;
                    r.thumpGain = juce::jmax (r.thumpGain * 1.3f, 0.6f);
                    r.thumpDecay *= 1.5f;
                    break;
                default: break;
            }
            return r;
        }

        void render (juce::AudioBuffer<float>& out, const Recipe& r, double sr, juce::Random& rng)
        {
            const int n = (int) std::ceil (r.length * sr);
            out.setSize (1, n);
            out.clear();
            auto* d = out.getWritePointer (0);

            // per-take variation
            const float vary = 1.0f + (rng.nextFloat() - 0.5f) * 0.15f;
            const float noiseHz = r.noiseHz * vary;

            // state-variable band-pass for the noise
            float low = 0, band = 0;
            double thumpPhase = 0, ringPhase = 0;
            const float pi = juce::MathConstants<float>::pi;

            for (int i = 0; i < n; ++i)
            {
                const float t = (float) (i / sr);
                const float env = t < r.attack ? t / r.attack : std::exp (-(t - r.attack) / r.decay);

                const float hz = juce::jlimit (40.0f, (float) sr * 0.45f, noiseHz * std::pow (2.0f, r.sweep * juce::jmin (1.0f, t / r.length)));
                const float f = 2.0f * std::sin (pi * hz / (float) sr);
                const float q = 1.0f / juce::jmax (0.3f, r.noiseQ);
                const float x = rng.nextFloat() * 2 - 1;
                low += f * band;
                const float high = x - low - q * band;
                band += f * high;
                float s = band * r.noiseGain * env;

                if (r.thumpGain > 0)
                {
                    const float pitchDrop = 1.0f + 1.5f * std::exp (-t / 0.015f);
                    thumpPhase += r.thumpHz * pitchDrop / sr;
                    s += (float) std::sin (2 * juce::MathConstants<double>::pi * thumpPhase) * r.thumpGain * std::exp (-t / r.thumpDecay);
                }
                if (r.ringGain > 0)
                {
                    ringPhase += r.ringHz * vary / sr;
                    const double ph = 2 * juce::MathConstants<double>::pi * ringPhase;
                    s += (float) (std::sin (ph) + 0.4 * std::sin (2.76 * ph)) * r.ringGain * std::exp (-t / r.ringDecay);
                }
                if (r.crackle > 0 && rng.nextFloat() < r.crackle * 0.004f)
                    s += (rng.nextFloat() * 2 - 1) * 0.6f * env;

                d[i] = s;
            }

            // short fade-out and normalise to -3 dBFS so every folder sits at a similar level
            const int fade = juce::jmin (n, (int) (0.01 * sr));
            out.applyGainRamp (0, n - fade, fade, 1.0f, 0.0f);
            if (auto peak = out.getMagnitude (0, n); peak > 0)
                out.applyGain (0.707f / peak);
        }
    }

    void FallbackSynth::prepare (const Taxonomy& t, double sampleRate)
    {
        numFolders = t.numFolders();
        buffers.assign ((size_t) numFolders * numSlots * takes, {});
        juce::Random rng (20261114);   // fixed seed: the placeholders sound the same every time
        for (int f = 0; f < numFolders; ++f)
            for (int s = 0; s < numSlots; ++s)
            {
                auto recipe = forSlot (baseRecipe (t.folder (f).key), s);
                for (int k = 0; k < takes; ++k)
                    render (buffers[(size_t) ((f * numSlots + s) * takes + k)], recipe, sampleRate, rng);
            }
    }

    const juce::AudioBuffer<float>* FallbackSynth::get (int folder, int slot, int take) const
    {
        if (folder < 0 || folder >= numFolders || slot < 0 || slot >= numSlots) return nullptr;
        return &buffers[(size_t) ((folder * numSlots + slot) * takes + (take % takes))];
    }

    std::pair<float, float> FallbackSynth::character (const juce::String& cellKey)
    {
        auto h = (juce::uint32) cellKey.hashCode();
        const float a = (float) (h & 0xffff) / 65535.0f;
        const float b = (float) ((h >> 16) & 0xffff) / 65535.0f;
        return { std::pow (2.0f, (a - 0.5f) * 0.6f),     // about +-1.8 semitones
                 0.55f + 0.9f * b };                     // darker .. brighter
    }
}
