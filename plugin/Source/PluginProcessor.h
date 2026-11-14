// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// The plugin: MIDI from the gesture tracker in, foley out.
//
// MIDI map (any channel):
//   Notes 36-39   index, middle, ring, pinky touch (centre)
//   Notes 40-43   the same, left hand (panned a little left)
//   Notes 44-47   the same, right hand (panned a little right)
//   Velocity      how hard the fingers met
//   CC 16 / 17    blend pad X / Y
//   CC 18         Size (small .. large)
//   Program 0-9   folder (Footsteps, Cloth, Movement, ...)
#pragma once

#include "Engine.h"
#include <juce_audio_processors/juce_audio_processors.h>

class GestureFoleyProcessor : public juce::AudioProcessor, private juce::Timer, private juce::Thread
{
public:
    GestureFoleyProcessor();
    ~GestureFoleyProcessor() override;

    // ---- AudioProcessor
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Gesture Foley"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 2.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock&) override;
    void setStateInformation (const void*, int) override;

    // ---- for the editor (message thread)
    juce::AudioProcessorValueTreeState params;
    gf::Engine& engine() noexcept { return eng; }
    const gf::Taxonomy& taxonomy() const noexcept { return eng.taxonomy(); }

    int currentFolder() const;
    void setCorner (int folder, int corner, int cellIndex);
    void resetCorners (int folder);

    /** Load a sample folder in the background. Empty file = unload. */
    void loadLibrary (const juce::File& folder);
    juce::File libraryFolder() const;
    juce::String libraryStatus() const;
    bool isLoadingLibrary() const { return isThreadRunning(); }

    /** Play a finger from the editor (mouse or keyboard). Thread-safe. */
    void audition (int slot, float velocity);

    static constexpr int firstNote = 36;

private:
    void timerCallback() override;
    void run() override;   // background library loading
    void handleMidi (const juce::MidiMessage& m);
    void pushCornersToEngine();

    gf::Engine eng;

    // MIDI CC / program changes move parameters; the host is told from the message thread.
    std::atomic<float> pendingX { -1 }, pendingY { -1 }, pendingSize { -1 };
    std::atomic<int> pendingFolder { -1 };
    float ccX = -1, ccY = -1, ccSize = -1;
    int ccFolder = -1;

    // editor auditions, read by the audio thread
    std::array<std::atomic<float>, gf::numSlots> auditionVel {};

    juce::CriticalSection loadLock;
    juce::File loadRequest, loadedFolder;
    juce::String status { "No samples loaded: playing the built-in placeholder sounds." };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GestureFoleyProcessor)
};
