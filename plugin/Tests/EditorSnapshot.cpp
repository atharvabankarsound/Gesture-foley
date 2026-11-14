// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Renders the plugin window to a PNG (for docs and visual checks).
//   GestureFoleySnapshot out.png [folderIndex] [padX] [padY]
#include "PluginProcessor.h"
#include <juce_gui_basics/juce_gui_basics.h>

int main (int argc, char** argv)
{
    if (argc < 2) return 2;
    juce::ScopedJuceInitialiser_GUI gui;
    GestureFoleyProcessor proc;
    proc.setPlayConfigDetails (0, 2, 48000, 512);
    proc.prepareToPlay (48000, 512);
    auto set = [&] (const char* id, float v) { if (auto* p = proc.params.getParameter (id)) p->setValueNotifyingHost (p->convertTo0to1 (v)); };
    if (argc > 2) set ("folder", (float) juce::String (argv[2]).getIntValue());
    set ("padX", argc > 3 ? juce::String (argv[3]).getFloatValue() : 0.32f);
    set ("padY", argc > 4 ? juce::String (argv[4]).getFloatValue() : 0.4f);

    std::unique_ptr<juce::AudioProcessorEditor> ed (proc.createEditor());
    // play a touch so a finger pad and the last-hit line light up
    juce::AudioBuffer<float> buf (2, 512);
    juce::MidiBuffer midi;
    midi.addEvent (juce::MidiMessage::noteOn (1, 36, (juce::uint8) 110), 0);
    proc.processBlock (buf, midi);
    juce::MessageManager::getInstance()->runDispatchLoopUntil (120);

    auto img = ed->createComponentSnapshot (ed->getLocalBounds(), true, 2.0f);
    juce::File out (juce::File::getCurrentWorkingDirectory().getChildFile (juce::String::fromUTF8 (argv[1])));
    out.deleteFile();
    juce::FileOutputStream os (out);
    return juce::PNGImageFormat().writeImageToStream (img, os) ? 0 : 1;
}
