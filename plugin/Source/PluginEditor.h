// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#pragma once

#include "PluginProcessor.h"
#include "Theme.h"
#include "XYPad.h"

class GestureFoleyEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit GestureFoleyEditor (GestureFoleyProcessor&);
    ~GestureFoleyEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;
    bool keyPressed (const juce::KeyPress&) override;

private:
    struct Knob
    {
        juce::Slider slider { juce::Slider::RotaryHorizontalVerticalDrag, juce::Slider::TextBoxBelow };
        juce::Label label;
        std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> attach;
    };

    void timerCallback() override;
    void showFolder (int folder);
    void chooseLibrary();
    void fillCornerBox (juce::ComboBox& box, int folder);

    GestureFoleyProcessor& proc;
    gf::theme::LookAndFeel lnf;

    juce::OwnedArray<juce::TextButton> folderButtons;
    std::array<juce::ComboBox, 4> cornerBoxes;
    juce::TextButton resetCorners { "Default corners" };
    XYPad pad;
    std::array<juce::TextButton, gf::numSlots> slotButtons;
    std::array<float, gf::numSlots> slotFlash {};
    std::array<juce::uint32, gf::numSlots> seenHits {};
    juce::Label lastHit;

    std::array<Knob, 5> knobs;
    juce::TextButton loadButton { "Load sample folder..." }, unloadButton { "Unload" };
    juce::Label libraryLabel, midiLabel;
    std::unique_ptr<juce::FileChooser> chooser;

    int shownFolder = -1;
    juce::Rectangle<int> header, foldersCard, padCard, sideCard, samplesCard;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GestureFoleyEditor)
};
