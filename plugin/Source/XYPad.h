// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// The blend pad: drag the point between four corner sounds.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

class XYPad : public juce::Component
{
public:
    XYPad (juce::RangedAudioParameter& x, juce::RangedAudioParameter& y);

    /** Names shown in the corners: top-left, top-right, bottom-left, bottom-right. */
    void setCornerNames (const std::array<juce::String, 4>& names);
    void setFlash (float amount) { flash = amount; repaint(); }

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;
    void mouseUp (const juce::MouseEvent&) override;
    void mouseDoubleClick (const juce::MouseEvent&) override;
    bool keyPressed (const juce::KeyPress&) override;

private:
    juce::Rectangle<float> padArea() const;
    void moveTo (juce::Point<float> p);

    juce::ParameterAttachment xAttach, yAttach;
    float x = 0.5f, y = 0.5f, flash = 0;
    std::array<juce::String, 4> names;
};
