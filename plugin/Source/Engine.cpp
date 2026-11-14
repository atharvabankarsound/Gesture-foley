// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "Engine.h"
#include <cmath>

namespace gf
{
    namespace
    {
        /** Small (0) to Large (1): pitch from +4 to -4 semitones (same as the web demo). */
        float sizePitch (float size) { return std::pow (2.0f, ((0.5f - size) * 8.0f) / 12.0f); }
        float dbToGain (float db) { return std::pow (10.0f, db / 20.0f); }
    }

    Engine::Engine (const Taxonomy& t) : tax (t), cornerCells ((size_t) t.numFolders() * 4)
    {
        for (int f = 0; f < t.numFolders(); ++f)
            for (int c = 0; c < 4; ++c)
                cornerCells[(size_t) (f * 4 + c)].store (juce::jmax (0, t.folder (f).cellIndex (t.folder (f).defaultCorners[(size_t) c])));

        lastPick.assign ((size_t) t.numCells() * numSlots, -1);
        fallbackTake.assign ((size_t) t.numFolders() * numSlots, 0);
        for (auto& h : hitCount) h.store (0);
    }

    void Engine::prepare (double sr, int maxBlockSize)
    {
        sampleRate = sr > 0 ? sr : 48000;
        fallback.prepare (tax, sampleRate);
        roomBuffer.setSize (2, juce::jmax (1, maxBlockSize));
        reverb.setSampleRate (sampleRate);
        juce::Reverb::Parameters p;
        p.roomSize = 0.32f;
        p.damping = 0.55f;
        p.width = 0.9f;
        p.wetLevel = 1.0f;
        p.dryLevel = 0.0f;
        reverb.setParameters (p);
        reverb.reset();
        for (auto& v : voices) v.active = false;
    }

    /* ------------------------------------------------------------ library */

    void Engine::setLibrary (std::shared_ptr<const SampleLibrary> lib)
    {
        {
            const juce::SpinLock::ScopedLockType l (newestLock);
            newest = lib;
        }
        std::shared_ptr<const SampleLibrary> dropped;
        {
            const juce::SpinLock::ScopedLockType l (libLock);
            dropped = std::move (pending);   // a library handed in earlier but never picked up
            pending = std::move (lib);
            hasPending = true;
        }
        // `dropped` is destroyed here, on the message thread
    }

    std::shared_ptr<const SampleLibrary> Engine::library() const
    {
        const juce::SpinLock::ScopedLockType l (newestLock);
        return newest;
    }

    void Engine::releaseRetired()
    {
        std::shared_ptr<const SampleLibrary> old;
        {
            const juce::SpinLock::ScopedLockType l (libLock);
            old = std::move (retired);
        }
    }

    void Engine::adoptPendingLibrary() noexcept
    {
        const juce::SpinLock::ScopedTryLockType l (libLock);
        if (! l.isLocked() || ! hasPending) return;
        if (retired != nullptr) return;   // the message thread hasn't freed the last one yet; try next block

        // Voices may point into the old library's audio, so stop them before letting it go.
        for (auto& v : voices) v.active = false;
        retired = std::move (active);
        active = std::move (pending);
        hasPending = false;
        std::fill (lastPick.begin(), lastPick.end(), -1);
    }

    /* ------------------------------------------------------------ corners */

    void Engine::setCorner (int folder, int corner, int cellIndex)
    {
        if (folder < 0 || folder >= tax.numFolders() || corner < 0 || corner > 3) return;
        if (cellIndex < 0 || cellIndex >= (int) tax.folder (folder).cells.size()) return;
        cornerCells[(size_t) (folder * 4 + corner)].store (cellIndex);
    }

    int Engine::getCorner (int folder, int corner) const
    {
        if (folder < 0 || folder >= tax.numFolders() || corner < 0 || corner > 3) return 0;
        return cornerCells[(size_t) (folder * 4 + corner)].load();
    }

    std::array<int, 4> Engine::corners (int folder) const
    {
        return { getCorner (folder, 0), getCorner (folder, 1), getCorner (folder, 2), getCorner (folder, 3) };
    }

    /* ------------------------------------------------------------ playing */

    Hit Engine::trigger (int slot, float velocity, float pan) noexcept
    {
        Hit hit;
        if (slot < 0 || slot >= numSlots) return hit;
        adoptPendingLibrary();

        const auto& c = controls;
        const int folder = juce::jlimit (0, tax.numFolders() - 1, c.folder);
        const auto& f = tax.folder (folder);
        const float vel = juce::jlimit (0.0f, 1.0f, 1.0f - c.dynamics * (1.0f - juce::jlimit (0.0f, 1.0f, velocity)));
        const float velGain = 0.16f + 0.84f * std::pow (vel, 1.3f);
        const float sizeRate = sizePitch (c.size);
        auto r = [this] { return rng.nextFloat() * 2.0f - 1.0f; };

        for (const auto& layer : blendLayers (corners (folder), c.x, c.y))
        {
            const float varyRate = std::pow (2.0f, (r() * c.variation * 1.5f) / 12.0f);
            const float varyGain = dbToGain (r() * c.variation * 1.5f);
            const float gain = layer.gain * velGain * varyGain;

            const int flat = active != nullptr ? active->index (folder, layer.cell, slot) : -1;
            if (flat >= 0 && ! active->at (flat).empty())
            {
                const auto& items = active->at (flat);
                const auto n = (int) items.size();
                int pick = rng.nextInt (n);
                if (n > 1 && pick == lastPick[(size_t) flat]) pick = (pick + 1) % n;   // never the same take twice in a row
                lastPick[(size_t) flat] = pick;
                const auto& s = *items[(size_t) pick];
                startVoice (s.audio, s.sampleRate, gain, pan, sizeRate * varyRate, vel);
                ++hit.samples;
            }
            else
            {
                auto& take = fallbackTake[(size_t) (folder * numSlots + slot)];
                take = (take + 1) % FallbackSynth::takes;
                if (auto* buf = fallback.get (folder, slot, take))
                {
                    auto [charRate, charBright] = FallbackSynth::character (f.cells[(size_t) layer.cell].key);
                    startVoice (*buf, sampleRate, gain * 0.8f, pan, sizeRate * varyRate * charRate,
                                juce::jlimit (0.0f, 1.0f, vel * charBright));
                    ++hit.synth;
                }
            }
        }

        hitCount[(size_t) slot].fetch_add (1);
        lastSlot.store (slot);
        lastVelocity.store (velocity);
        lastSamples.store (hit.samples);
        lastSynth.store (hit.synth);
        return hit;
    }

    void Engine::startVoice (const juce::AudioBuffer<float>& buf, double bufferRate, float gain, float pan,
                             float rate, float brightness) noexcept
    {
        if (buf.getNumSamples() < 2) return;

        // a free voice, or steal the oldest
        Voice* v = nullptr;
        for (auto& candidate : voices)
            if (! candidate.active) { v = &candidate; break; }
        if (v == nullptr)
        {
            v = &voices[0];
            for (auto& candidate : voices)
                if (candidate.started < v->started) v = &candidate;
        }

        v->left = buf.getReadPointer (0);
        v->right = buf.getReadPointer (buf.getNumChannels() > 1 ? 1 : 0);
        v->length = buf.getNumSamples();
        v->pos = 0;
        v->rate = rate * (bufferRate / sampleRate);

        // equal-power pan, as the web demo's StereoPannerNode does for one channel
        const float x = (juce::jlimit (-1.0f, 1.0f, pan) + 1.0f) * 0.5f;
        const float halfPi = juce::MathConstants<float>::halfPi;
        v->gainL = gain * std::cos (x * halfPi) * juce::MathConstants<float>::sqrt2;
        v->gainR = gain * std::sin (x * halfPi) * juce::MathConstants<float>::sqrt2;

        // softer touches sound darker, like a lighter footfall
        const double cutoff = juce::jmin (sampleRate * 0.45, 1800.0 + 18200.0 * std::pow ((double) brightness, 1.6));
        const auto tone = juce::IIRCoefficients::makeLowPass (sampleRate, cutoff, 0.5);
        // Size: small removes low end, large adds it
        const auto shelf = juce::IIRCoefficients::makeLowShelf (sampleRate, 220.0, 0.7, dbToGain ((controls.size - 0.5f) * 10.0f));
        v->toneL.setCoefficients (tone);  v->toneR.setCoefficients (tone);
        v->shelfL.setCoefficients (shelf); v->shelfR.setCoefficients (shelf);
        v->toneL.reset(); v->toneR.reset(); v->shelfL.reset(); v->shelfR.reset();

        v->started = ++voiceClock;
        v->active = true;
    }

    void Engine::render (juce::AudioBuffer<float>& out, int start, int num) noexcept
    {
        if (num <= 0) return;
        adoptPendingLibrary();

        const int chans = out.getNumChannels();
        if (chans == 0) return;
        auto* outL = out.getWritePointer (0, start);
        auto* outR = chans > 1 ? out.getWritePointer (1, start) : nullptr;

        const int roomNum = juce::jmin (num, roomBuffer.getNumSamples());
        roomBuffer.clear (0, roomNum);
        auto* roomL = roomBuffer.getWritePointer (0);
        auto* roomR = roomBuffer.getWritePointer (1);
        const float level = dbToGain (controls.levelDb);
        const float send = controls.room * controls.room;

        for (auto& v : voices)
        {
            if (! v.active) continue;
            for (int i = 0; i < num; ++i)
            {
                const int i0 = (int) v.pos;
                if (i0 + 1 >= v.length) { v.active = false; break; }
                const float frac = (float) (v.pos - i0);
                float l = v.left[i0] + frac * (v.left[i0 + 1] - v.left[i0]);
                float r = v.right[i0] + frac * (v.right[i0 + 1] - v.right[i0]);
                l = v.shelfL.processSingleSampleRaw (v.toneL.processSingleSampleRaw (l)) * v.gainL * level;
                r = v.shelfR.processSingleSampleRaw (v.toneR.processSingleSampleRaw (r)) * v.gainR * level;

                if (outR != nullptr) { outL[i] += l; outR[i] += r; }
                else outL[i] += 0.5f * (l + r);
                if (i < roomNum) { roomL[i] += l * send; roomR[i] += r * send; }
                v.pos += v.rate;
            }
        }

        if (send > 0.0f)
        {
            reverb.processStereo (roomL, roomR, roomNum);
            if (outR != nullptr) { juce::FloatVectorOperations::add (outL, roomL, roomNum); juce::FloatVectorOperations::add (outR, roomR, roomNum); }
            else { juce::FloatVectorOperations::addWithMultiply (outL, roomL, 0.5f, roomNum); juce::FloatVectorOperations::addWithMultiply (outL, roomR, 0.5f, roomNum); }
        }
        for (int ch = 2; ch < chans; ++ch)   // extra outputs stay silent
            out.clear (ch, start, num);
    }

    void Engine::allNotesOff() noexcept
    {
        for (auto& v : voices) v.active = false;
    }

    int Engine::activeVoices() const noexcept
    {
        int n = 0;
        for (auto& v : voices) n += v.active ? 1 : 0;
        return n;
    }
}
