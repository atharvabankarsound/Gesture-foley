// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Engine tests: run the GestureFoleyTests app; it prints each check and exits 1 on failure.
#include "Blend.h"
#include "Engine.h"
#include "Router.h"
#include <juce_audio_formats/juce_audio_formats.h>
#include <iostream>

using namespace gf;

static int failures = 0, checks = 0;
#define CHECK(cond, what) do { ++checks; if (! (cond)) { ++failures; std::cout << "FAIL  " << what << "\n"; } else std::cout << "ok    " << what << "\n"; } while (0)

static float rms (const juce::AudioBuffer<float>& b)
{
    double sum = 0;
    for (int c = 0; c < b.getNumChannels(); ++c)
        for (int i = 0; i < b.getNumSamples(); ++i) sum += (double) b.getSample (c, i) * b.getSample (c, i);
    return (float) std::sqrt (sum / juce::jmax (1, b.getNumChannels() * b.getNumSamples()));
}

static juce::AudioBuffer<float> renderSeconds (Engine& e, double seconds, int block = 512)
{
    juce::AudioBuffer<float> out (2, (int) (seconds * 48000)), tmp (2, block);
    for (int pos = 0; pos < out.getNumSamples(); pos += block)
    {
        const int n = juce::jmin (block, out.getNumSamples() - pos);
        tmp.clear();
        e.render (tmp, 0, n);
        for (int c = 0; c < 2; ++c) out.copyFrom (c, pos, tmp, c, 0, n);
    }
    return out;
}

static void writeSine (const juce::File& f, float hz, double seconds)
{
    f.getParentDirectory().createDirectory();
    juce::WavAudioFormat wav;
    std::unique_ptr<juce::OutputStream> stream (f.createOutputStream());
    auto w = wav.createWriterFor (stream, juce::AudioFormatWriterOptions().withSampleRate (44100).withNumChannels (1).withBitsPerSample (16));
    juce::AudioBuffer<float> b (1, (int) (seconds * 44100));
    for (int i = 0; i < b.getNumSamples(); ++i)
        b.setSample (0, i, 0.5f * std::sin (2.0f * juce::MathConstants<float>::pi * hz * (float) i / 44100.0f));
    w->writeFromAudioSampleBuffer (b, 0, b.getNumSamples());
}

static void testTaxonomy()
{
    const auto& t = Taxonomy::builtIn();
    CHECK (t.numFolders() == 10, "10 folders");
    CHECK (t.numCells() == 143, "143 sub-categories, same as the web demo");
    const auto& f = t.folder (t.folderIndex ("footsteps"));
    CHECK (f.slotNames[0] == "Step" && f.slotNames[3] == "Stomp", "footstep finger names");
    CHECK (f.hasCell ("wood.stairs"), "footsteps has wood.stairs");
    for (auto& folder : t.folders())
        for (auto& c : folder.defaultCorners)
            if (! folder.hasCell (c)) CHECK (false, "default corner exists: " + folder.key + "/" + c);
}

static void testBlend()
{
    auto w = cornerWeights (0.3f, 0.8f);
    CHECK (std::abs (w[0] + w[1] + w[2] + w[3] - 1.0f) < 1e-6f, "corner shares add up to 1");

    std::array<int, 4> corners { 0, 1, 2, 3 };
    auto tl = blendLayers (corners, 0, 0);
    CHECK (tl.count == 1 && tl.layers[0].cell == 0 && std::abs (tl.layers[0].gain - 1) < 1e-6f, "top-left corner plays only that sound");

    auto mid = blendLayers (corners, 0.5f, 0.5f);
    CHECK (mid.count == 4 && std::abs (mid.layers[0].share - 0.25f) < 1e-6f && std::abs (mid.layers[0].gain - 0.5f) < 1e-6f,
           "centre plays all four at equal power");

    std::array<int, 4> dup { 7, 7, 2, 3 };
    auto top = blendLayers (dup, 0.5f, 0.0f);
    CHECK (top.count == 1 && top.layers[0].cell == 7, "the same sound in two corners is merged");

    auto near = blendLayers (corners, 0.99f, 0.0f);
    CHECK (near.count == 1 && near.layers[0].cell == 1, "near-silent layers are dropped");
}

static void testRouter()
{
    const auto& t = Taxonomy::builtIn();
    const int fs = t.folderIndex ("footsteps");
    auto expect = [&] (const char* path, int folder, const char* cell, int slot)
    {
        auto r = routePath (t, path);
        bool ok = r && r->folder == folder && t.folder (folder).cells[(size_t) r->cell].key == cell && r->slot == slot;
        CHECK (ok, juce::String ("route ") + path);
    };
    expect ("Gesture Foley Kit/Footsteps/Wood/Stairs/Step (thumb + index)/step_01.wav", fs, "wood.stairs", 0);
    expect ("Gesture Foley Kit/Footsteps/Wood/Stairs/Scuff (thumb + middle)/a.wav", fs, "wood.stairs", 1);
    expect ("Footsteps/Wood/2 - Scuff/a.wav", fs, "wood.floorboard", 1);            // no sub-category folder
    expect ("Footsteps/Gravel/Coarse/finger 4/a.wav", fs, "gravel.coarse", 3);
    expect ("My library/FOOTSTEPS/wood/creaky/STOMP/a.wav", fs, "wood.creaky", 3);  // case doesn't matter
    CHECK (! routePath (t, "Footsteps/Wood/a.wav"), "no finger folder -> not routed");
    CHECK (! routePath (t, "Music/Drums/kick.wav"), "unrelated folders -> not routed");
    CHECK (! routePath (t, "Footsteps/Wood/Stairs/Take 14/a.wav"), "a number inside a longer number isn't a finger");
}

static void testEngineSynth()
{
    Engine e;
    e.prepare (48000, 512);
    Controls c;
    c.room = 0;
    e.setControls (c);

    CHECK (rms (renderSeconds (e, 0.2)) < 1e-9f, "silent until touched");

    auto hit = e.trigger (0, 1.0f);
    CHECK (hit.synth == 4 && hit.samples == 0, "centre of the pad, no samples: 4 synth layers");
    const float loud = rms (renderSeconds (e, 0.5));
    CHECK (loud > 0.01f, "a touch makes sound");
    CHECK (e.activeVoices() == 0, "voices end on their own");

    c.dynamics = 1.0f;
    e.setControls (c);
    e.trigger (0, 0.2f);
    const float soft = rms (renderSeconds (e, 0.5));
    CHECK (soft < loud * 0.6f, "a soft touch is quieter");

    c.x = 0; c.y = 0;
    e.setControls (c);
    CHECK (e.trigger (2, 1).synth == 1, "corner of the pad: one layer");

    bool allFolders = true;
    for (int f = 0; f < e.taxonomy().numFolders(); ++f)
        for (int s = 0; s < numSlots; ++s)
        {
            c.folder = f;
            e.setControls (c);
            e.trigger (s, 1);
            allFolders &= rms (renderSeconds (e, 0.3)) > 0.003f;
        }
    CHECK (allFolders, "every folder and finger makes a sound");

    for (int i = 0; i < 200; ++i) e.trigger (i % 4, 1);
    CHECK (e.activeVoices() <= Engine::maxVoices, "voice stealing keeps polyphony bounded");
    auto out = renderSeconds (e, 0.05);
    CHECK (out.getMagnitude (0, out.getNumSamples()) < 64.0f && ! std::isnan (rms (out)), "a flood of touches stays finite");
}

static void testLibrary()
{
    const auto& t = Taxonomy::builtIn();
    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("gf-test-kit-" + juce::String (juce::Time::currentTimeMillis()));
    auto kit = root.getChildFile ("Gesture Foley Kit");
    writeSine (kit.getChildFile ("Footsteps/Gravel/Fine/Step (thumb + index)/a.wav"), 220, 0.3);
    writeSine (kit.getChildFile ("Footsteps/Gravel/Fine/Step (thumb + index)/b.wav"), 330, 0.3);
    writeSine (kit.getChildFile ("Footsteps/Wood/Floorboard/Stomp (thumb + pinky)/c.wav"), 110, 0.3);
    writeSine (kit.getChildFile ("Unsorted/d.wav"), 440, 0.1);
    kit.getChildFile ("Footsteps/Gravel/Fine/Step (thumb + index)/notes.txt").replaceWithText ("not audio");

    LoadReport report;
    auto lib = SampleLibrary::load (kit, t, nullptr, report);
    const int fs = t.folderIndex ("footsteps");
    const int gravel = t.folder (fs).cellIndex ("gravel.fine");
    CHECK (report.added == 3 && report.cellsFilled == 2 && report.unmatched == 1, "loads a kit folder: " + report.summary());
    CHECK (lib->count (fs, gravel, 0) == 2, "two takes in Gravel/Fine/Step");
    CHECK (lib->countFolder (fs) == 3, "folder count");

    Engine e;
    e.prepare (48000, 512);
    e.setLibrary (lib);
    Controls c;
    c.folder = fs;
    c.x = 0; c.y = 0;   // top-left corner = gravel.fine by default
    c.room = 0;
    e.setControls (c);
    renderSeconds (e, 0.01);   // the audio thread picks up the new library
    auto hit = e.trigger (0, 1);
    CHECK (hit.samples == 1 && hit.synth == 0, "plays your sample when the cell has one");
    CHECK (rms (renderSeconds (e, 0.2)) > 0.05f, "the sample is audible");

    c.x = 1; c.y = 1;   // bottom-right = wood.floorboard
    e.setControls (c);
    CHECK (e.trigger (3, 1).samples == 1, "stomp on wood plays the wood sample");
    CHECK (e.trigger (2, 1).synth == 1, "an empty cell falls back to the synth");

    // swapping the library while sounds play is safe
    e.trigger (0, 1);
    e.setLibrary (nullptr);
    renderSeconds (e, 0.01);
    e.releaseRetired();
    CHECK (e.activeVoices() == 0, "voices on the old library stop when it is replaced");
    c.x = 0; c.y = 0;
    e.setControls (c);
    CHECK (e.trigger (0, 1).synth == 1, "after unloading, the synth plays");

    root.deleteRecursively();
}

int main()
{
    testTaxonomy();
    testBlend();
    testRouter();
    testEngineSynth();
    testLibrary();
    std::cout << "\n" << (checks - failures) << "/" << checks << " checks passed\n";
    return failures == 0 ? 0 : 1;
}
