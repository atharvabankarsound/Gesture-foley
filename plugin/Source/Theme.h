// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Colours and drawing for the dark "glass" look shared with the web demo.
#pragma once

#include <juce_gui_basics/juce_gui_basics.h>

namespace gf::theme
{
    inline const juce::Colour bg { 0xff0b0d12 };
    inline const juce::Colour panel { 0xff151922 };
    inline const juce::Colour panelHi { 0xff1d2230 };
    inline const juce::Colour line { 0x22ffffff };
    inline const juce::Colour text { 0xffeef1f7 };
    inline const juce::Colour dim { 0xff8d95a8 };
    inline const juce::Colour accent { 0xff7aa7ff };
    inline const juce::Colour left { 0xff6ee7b7 };    // left hand
    inline const juce::Colour right { 0xfff9a8d4 };   // right hand

    class LookAndFeel : public juce::LookAndFeel_V4
    {
    public:
        LookAndFeel()
        {
            setColour (juce::ResizableWindow::backgroundColourId, bg);
            setColour (juce::Label::textColourId, text);
            setColour (juce::TextButton::buttonColourId, panelHi);
            setColour (juce::TextButton::buttonOnColourId, accent.withAlpha (0.85f));
            setColour (juce::TextButton::textColourOffId, text);
            setColour (juce::TextButton::textColourOnId, juce::Colours::white);
            setColour (juce::ComboBox::backgroundColourId, panelHi);
            setColour (juce::ComboBox::textColourId, text);
            setColour (juce::ComboBox::outlineColourId, line);
            setColour (juce::ComboBox::arrowColourId, dim);
            setColour (juce::PopupMenu::backgroundColourId, panel);
            setColour (juce::PopupMenu::textColourId, text);
            setColour (juce::PopupMenu::headerTextColourId, dim);
            setColour (juce::PopupMenu::highlightedBackgroundColourId, accent.withAlpha (0.35f));
            setColour (juce::Slider::textBoxTextColourId, text);
            setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
            setColour (juce::Slider::rotarySliderFillColourId, accent);
            setColour (juce::Slider::rotarySliderOutlineColourId, line);
        }

        void drawRotarySlider (juce::Graphics& g, int x, int y, int w, int h, float pos, float start, float end, juce::Slider&) override
        {
            auto r = juce::Rectangle<float> ((float) x, (float) y, (float) w, (float) h).reduced (6);
            const float size = juce::jmin (r.getWidth(), r.getHeight());
            r = r.withSizeKeepingCentre (size, size);
            const auto c = r.getCentre();
            const float radius = size * 0.5f, thick = 4.0f;
            const float angle = start + pos * (end - start);

            juce::Path track, value;
            track.addCentredArc (c.x, c.y, radius - thick, radius - thick, 0, start, end, true);
            value.addCentredArc (c.x, c.y, radius - thick, radius - thick, 0, start, angle, true);
            g.setColour (line);
            g.strokePath (track, juce::PathStrokeType (thick, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
            g.setColour (accent);
            g.strokePath (value, juce::PathStrokeType (thick, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

            g.setColour (panelHi);
            g.fillEllipse (r.reduced (thick * 2.5f));
            const juce::Point<float> tip (c.x + (radius - thick * 3.5f) * std::sin (angle), c.y - (radius - thick * 3.5f) * std::cos (angle));
            g.setColour (text);
            g.drawLine ({ c.getPointOnCircumference (radius * 0.12f, angle), tip }, 2.0f);
        }

        void drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour&, bool over, bool down) override
        {
            auto r = b.getLocalBounds().toFloat().reduced (0.5f);
            auto col = b.getToggleState() ? accent.withAlpha (0.28f) : panelHi;
            if (over) col = col.brighter (0.08f);
            if (down) col = col.brighter (0.15f);
            g.setColour (col);
            g.fillRoundedRectangle (r, 9);
            g.setColour (b.getToggleState() ? accent.withAlpha (0.8f) : line);
            g.drawRoundedRectangle (r, 9, 1);
        }

        juce::Font getTextButtonFont (juce::TextButton&, int h) override { return juce::FontOptions (juce::jmin (14.0f, (float) h * 0.5f)); }
        juce::Font getComboBoxFont (juce::ComboBox&) override { return juce::FontOptions (13.5f); }
        juce::Font getPopupMenuFont() override { return juce::FontOptions (14.0f); }
    };

    /** A rounded glass card. */
    inline void card (juce::Graphics& g, juce::Rectangle<float> r, const juce::String& title = {})
    {
        g.setColour (panel.withAlpha (0.92f));
        g.fillRoundedRectangle (r, 16);
        g.setColour (line);
        g.drawRoundedRectangle (r, 16, 1);
        if (title.isNotEmpty())
        {
            g.setColour (dim);
            g.setFont (juce::FontOptions (11.5f).withStyle ("Bold"));
            g.drawText (title.toUpperCase(), r.reduced (16, 10).removeFromTop (16), juce::Justification::left);
        }
    }
}
