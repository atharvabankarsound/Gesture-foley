// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "XYPad.h"
#include "Blend.h"
#include "Theme.h"

XYPad::XYPad (juce::RangedAudioParameter& px, juce::RangedAudioParameter& py)
    : xAttach (px, [this] (float v) { x = v; repaint(); }),
      yAttach (py, [this] (float v) { y = v; repaint(); })
{
    xAttach.sendInitialUpdate();
    yAttach.sendInitialUpdate();
    setWantsKeyboardFocus (true);
    setTitle ("Blend pad");
    setDescription ("Drag to blend the four corner sounds. Arrow keys move the point, double-click centres it.");
}

void XYPad::setCornerNames (const std::array<juce::String, 4>& n)
{
    names = n;
    repaint();
}

juce::Rectangle<float> XYPad::padArea() const { return getLocalBounds().toFloat().reduced (2); }

void XYPad::paint (juce::Graphics& g)
{
    using namespace gf::theme;
    auto r = padArea();

    g.setColour (panel);
    g.fillRoundedRectangle (r, 14);

    // soft glow toward the point
    const juce::Point<float> dot { r.getX() + x * r.getWidth(), r.getY() + y * r.getHeight() };
    juce::ColourGradient glow (accent.withAlpha (0.20f + 0.25f * flash), dot, accent.withAlpha (0.0f), dot.translated (r.getWidth() * 0.55f, 0), true);
    g.setGradientFill (glow);
    g.fillRoundedRectangle (r, 14);

    // grid
    g.setColour (line);
    for (int i = 1; i < 4; ++i)
    {
        g.drawVerticalLine ((int) (r.getX() + r.getWidth() * (float) i / 4), r.getY() + 6, r.getBottom() - 6);
        g.drawHorizontalLine ((int) (r.getY() + r.getHeight() * (float) i / 4), r.getX() + 6, r.getRight() - 6);
    }
    g.drawRoundedRectangle (r, 14, 1);

    // corner names with their share of the blend
    auto w = gf::cornerWeights (x, y);
    g.setFont (juce::FontOptions (12.5f));
    const auto inner = r.reduced (12, 10);
    const std::array<juce::Justification, 4> just { juce::Justification::topLeft, juce::Justification::topRight,
                                                    juce::Justification::bottomLeft, juce::Justification::bottomRight };
    for (size_t i = 0; i < 4; ++i)
    {
        const float a = 0.45f + 0.55f * w[i];
        g.setColour (text.withAlpha (a));
        auto label = names[i] + "\n" + juce::String (juce::roundToInt (w[i] * 100)) + "%";
        g.drawFittedText (label, inner.toNearestInt(), just[i], 2);
    }

    // the point
    g.setColour (accent.withAlpha (0.35f));
    g.fillEllipse (juce::Rectangle<float> (30, 30).withCentre (dot));
    g.setColour (juce::Colours::white);
    g.fillEllipse (juce::Rectangle<float> (14, 14).withCentre (dot));
    if (hasKeyboardFocus (false))
    {
        g.setColour (accent);
        g.drawRoundedRectangle (r.reduced (1), 14, 2);
    }
}

void XYPad::moveTo (juce::Point<float> p)
{
    auto r = padArea();
    xAttach.setValueAsPartOfGesture (juce::jlimit (0.0f, 1.0f, (p.x - r.getX()) / r.getWidth()));
    yAttach.setValueAsPartOfGesture (juce::jlimit (0.0f, 1.0f, (p.y - r.getY()) / r.getHeight()));
}

void XYPad::mouseDown (const juce::MouseEvent& e)
{
    xAttach.beginGesture();
    yAttach.beginGesture();
    moveTo (e.position);
}

void XYPad::mouseDrag (const juce::MouseEvent& e) { moveTo (e.position); }

void XYPad::mouseUp (const juce::MouseEvent&)
{
    xAttach.endGesture();
    yAttach.endGesture();
}

void XYPad::mouseDoubleClick (const juce::MouseEvent&)
{
    xAttach.setValueAsCompleteGesture (0.5f);
    yAttach.setValueAsCompleteGesture (0.5f);
}

bool XYPad::keyPressed (const juce::KeyPress& k)
{
    const float step = k.getModifiers().isShiftDown() ? 0.1f : 0.02f;
    float nx = x, ny = y;
    if (k == juce::KeyPress::leftKey) nx -= step;
    else if (k == juce::KeyPress::rightKey) nx += step;
    else if (k == juce::KeyPress::upKey) ny -= step;
    else if (k == juce::KeyPress::downKey) ny += step;
    else return false;
    xAttach.setValueAsCompleteGesture (juce::jlimit (0.0f, 1.0f, nx));
    yAttach.setValueAsCompleteGesture (juce::jlimit (0.0f, 1.0f, ny));
    return true;
}
