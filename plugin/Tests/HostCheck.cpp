// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Loads the built VST3 the way a DAW does and checks it: plays MIDI, saves and restores
// state, and renders the editor to a PNG.
//
//   GestureFoleyHostCheck "<path to Gesture Foley.vst3>" [editor.png]
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <iostream>

static int failures = 0;
#define CHECK(cond, what) do { if (! (cond)) { ++failures; std::cout << "FAIL  " << what << "\n"; } else std::cout << "ok    " << what << "\n"; } while (0)

static float renderNote (juce::AudioPluginInstance& p, int note, int velocity, int blocks = 40)
{
    juce::AudioBuffer<float> buf (2, 512);
    double sum = 0;
    for (int b = 0; b < blocks; ++b)
    {
        juce::MidiBuffer midi;
        if (b == 0 && note >= 0) midi.addEvent (juce::MidiMessage::noteOn (1, note, (juce::uint8) velocity), 10);
        buf.clear();
        p.processBlock (buf, midi);
        for (int c = 0; c < 2; ++c)
            for (int i = 0; i < buf.getNumSamples(); ++i) sum += (double) buf.getSample (c, i) * buf.getSample (c, i);
    }
    return (float) std::sqrt (sum / (blocks * 1024.0));
}

int main (int argc, char** argv)
{
    if (argc < 2) { std::cout << "usage: GestureFoleyHostCheck <plugin.vst3> [editor.png]\n"; return 2; }
    juce::ScopedJuceInitialiser_GUI gui;

    juce::VST3PluginFormat vst3;
    juce::OwnedArray<juce::PluginDescription> found;
    vst3.findAllTypesForFile (found, juce::File (juce::String::fromUTF8 (argv[1])).getFullPathName());
    CHECK (found.size() == 1, "the VST3 describes one plugin");
    if (found.isEmpty()) return 1;
    const auto& d = *found[0];
    std::cout << "      " << d.name << " by " << d.manufacturerName << ", " << d.category << ", instrument=" << (int) d.isInstrument << "\n";
    CHECK (d.isInstrument, "it is an instrument");

    juce::String err;
    auto p = vst3.createInstanceFromDescription (d, 48000, 512, err);
    CHECK (p != nullptr, "the host can create it " + err);
    if (p == nullptr) return 1;

    p->setPlayConfigDetails (0, 2, 48000, 512);
    p->prepareToPlay (48000, 512);
    CHECK (p->acceptsMidi(), "accepts MIDI");
    CHECK (p->getParameters().size() >= 8, "exposes its parameters (" + juce::String (p->getParameters().size()) + ")");

    CHECK (renderNote (*p, -1, 0) < 1e-9f, "silent without MIDI");
    const float loud = renderNote (*p, 36, 127);
    CHECK (loud > 0.005f, "note 36 (thumb + index) makes sound, rms " + juce::String (loud, 4));
    for (int n : { 37, 38, 39, 40, 47 })
        CHECK (renderNote (*p, n, 100) > 0.002f, "note " + juce::String (n) + " makes sound");
    renderNote (*p, -1, 0, 400);   // let the last notes and the room ring out
    CHECK (renderNote (*p, 60, 127) < 1e-6f, "note 60 isn't mapped, stays silent");

    // state round trip: change a parameter, save, change it back, restore
    auto* size = p->getParameters()[3];
    size->setValueNotifyingHost (0.9f);
    juce::MemoryBlock state;
    p->getStateInformation (state);
    size->setValueNotifyingHost (0.1f);
    p->setStateInformation (state.getData(), (int) state.getSize());
    CHECK (std::abs (size->getValue() - 0.9f) < 0.01f, "saves and restores its settings (" + size->getName (20) + ")");

    if (auto* ed = p->createEditorIfNeeded())
    {
        CHECK (ed->getWidth() >= 880 && ed->getHeight() >= 560, "editor opens at " + juce::String (ed->getWidth()) + "x" + juce::String (ed->getHeight()));
        if (argc > 2)
        {
            renderNote (*p, 36, 120, 2);   // light up a finger pad
            for (int i = 0; i < 3; ++i) juce::MessageManager::getInstance()->runDispatchLoopUntil (40);
            auto img = ed->createComponentSnapshot (ed->getLocalBounds(), true, 2.0f);
            juce::File out (juce::String::fromUTF8 (argv[2]));
            out.deleteFile();
            juce::FileOutputStream os (out);
            juce::PNGImageFormat png;
            CHECK (png.writeImageToStream (img, os), "editor snapshot written to " + out.getFileName());
        }
        delete ed;
    }
    else CHECK (false, "editor opens");

    p->releaseResources();
    p.reset();
    std::cout << (failures == 0 ? "\nall host checks passed\n" : "\nhost checks FAILED\n");
    return failures == 0 ? 0 : 1;
}
