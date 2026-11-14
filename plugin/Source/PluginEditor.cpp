// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "PluginEditor.h"

using namespace gf::theme;

namespace
{
    const char* fingerNames[] { "Thumb + index", "Thumb + middle", "Thumb + ring", "Thumb + pinky" };
    const char* knobIds[] { "size", "variation", "dynamics", "room", "level" };
    const char* knobNames[] { "Size", "Variation", "Dynamics", "Room", "Level" };
}

GestureFoleyEditor::GestureFoleyEditor (GestureFoleyProcessor& p)
    : AudioProcessorEditor (p), proc (p),
      pad (*p.params.getParameter ("padX"), *p.params.getParameter ("padY"))
{
    setLookAndFeel (&lnf);

    // folders
    for (int i = 0; i < proc.taxonomy().numFolders(); ++i)
    {
        auto* b = folderButtons.add (new juce::TextButton (proc.taxonomy().folder (i).name));
        b->setClickingTogglesState (false);
        b->onClick = [this, i]
        {
            if (auto* param = proc.params.getParameter ("folder"))
                param->setValueNotifyingHost (param->convertTo0to1 ((float) i));
        };
        addAndMakeVisible (b);
    }

    // blend pad and its corners
    addAndMakeVisible (pad);
    for (int c = 0; c < 4; ++c)
    {
        auto& box = cornerBoxes[(size_t) c];
        box.setTooltip ("Sound in this corner of the pad");
        box.onChange = [this, c]
        {
            if (auto id = cornerBoxes[(size_t) c].getSelectedId(); id > 0)
                proc.setCorner (proc.currentFolder(), c, id - 1);
        };
        addAndMakeVisible (box);
    }
    resetCorners.onClick = [this] { proc.resetCorners (proc.currentFolder()); shownFolder = -1; };
    addAndMakeVisible (resetCorners);

    // finger pads: click (or press 1-4) to hear them
    for (int s = 0; s < gf::numSlots; ++s)
    {
        auto& b = slotButtons[(size_t) s];
        b.onClick = [this, s] { proc.audition (s, 0.85f); };
        b.setWantsKeyboardFocus (false);
        addAndMakeVisible (b);
        seenHits[(size_t) s] = proc.engine().hitCount[(size_t) s].load();
    }
    lastHit.setJustificationType (juce::Justification::centred);
    lastHit.setColour (juce::Label::textColourId, dim);
    addAndMakeVisible (lastHit);

    // knobs
    for (size_t k = 0; k < knobs.size(); ++k)
    {
        auto& kn = knobs[k];
        kn.slider.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 80, 18);
        kn.slider.setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
        kn.slider.setColour (juce::Slider::textBoxBackgroundColourId, juce::Colours::transparentBlack);
        kn.attach = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (proc.params, knobIds[k], kn.slider);
        if (juce::String (knobIds[k]) == "level") kn.slider.setTextValueSuffix (" dB");
        kn.label.setText (knobNames[k], juce::dontSendNotification);
        kn.label.setJustificationType (juce::Justification::centred);
        kn.label.setColour (juce::Label::textColourId, dim);
        addAndMakeVisible (kn.slider);
        addAndMakeVisible (kn.label);
    }

    // samples
    loadButton.onClick = [this] { chooseLibrary(); };
    unloadButton.onClick = [this] { proc.loadLibrary (juce::File()); };
    addAndMakeVisible (loadButton);
    addAndMakeVisible (unloadButton);
    libraryLabel.setJustificationType (juce::Justification::topLeft);
    libraryLabel.setFont (juce::FontOptions (12.5f));
    addAndMakeVisible (libraryLabel);

    midiLabel.setJustificationType (juce::Justification::topLeft);
    midiLabel.setFont (juce::FontOptions (12.0f));
    midiLabel.setColour (juce::Label::textColourId, dim);
    midiLabel.setText ("MIDI in: notes 36-39 index..pinky (40-43 left hand, 44-47 right hand), "
                       "velocity = touch strength, CC16/17 pad X/Y, CC18 size, program 0-9 folder. "
                       "Keys 1-4 play the fingers.", juce::dontSendNotification);
    addAndMakeVisible (midiLabel);

    setWantsKeyboardFocus (true);
    setResizable (true, true);
    setResizeLimits (880, 560, 1600, 1100);
    setSize (980, 600);
    timerCallback();
    startTimerHz (30);
}

GestureFoleyEditor::~GestureFoleyEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void GestureFoleyEditor::fillCornerBox (juce::ComboBox& box, int folder)
{
    box.clear (juce::dontSendNotification);
    const auto& f = proc.taxonomy().folder (folder);
    int cell = 0;
    for (auto& tex : f.textures)
    {
        box.addSectionHeading (tex.name);
        for (auto& v : tex.variants)
            box.addItem (tex.name + " \xc2\xb7 " + v.name, ++cell);   // id = cell index + 1
    }
}

void GestureFoleyEditor::showFolder (int folder)
{
    shownFolder = folder;
    const auto& f = proc.taxonomy().folder (folder);
    for (int i = 0; i < folderButtons.size(); ++i)
        folderButtons[i]->setToggleState (i == folder, juce::dontSendNotification);

    std::array<juce::String, 4> names;
    for (int c = 0; c < 4; ++c)
    {
        auto& box = cornerBoxes[(size_t) c];
        fillCornerBox (box, folder);
        const int cell = proc.engine().getCorner (folder, c);
        box.setSelectedId (cell + 1, juce::dontSendNotification);
        names[(size_t) c] = f.cells[(size_t) cell].label;
    }
    pad.setCornerNames (names);

    for (int s = 0; s < gf::numSlots; ++s)
        slotButtons[(size_t) s].setButtonText (f.slotNames[(size_t) s] + "\n" + fingerNames[s]);
}

void GestureFoleyEditor::timerCallback()
{
    const int folder = proc.currentFolder();
    bool cornersChanged = false;
    if (folder == shownFolder)
        for (int c = 0; c < 4; ++c)
            cornersChanged |= cornerBoxes[(size_t) c].getSelectedId() != proc.engine().getCorner (folder, c) + 1;
    if (folder != shownFolder || cornersChanged)
        showFolder (folder);

    // flash the finger pads that just played
    float padFlash = 0;
    for (int s = 0; s < gf::numSlots; ++s)
    {
        const auto n = proc.engine().hitCount[(size_t) s].load();
        if (n != seenHits[(size_t) s]) { seenHits[(size_t) s] = n; slotFlash[(size_t) s] = 1.0f; }
        auto& b = slotButtons[(size_t) s];
        b.setToggleState (slotFlash[(size_t) s] > 0.15f, juce::dontSendNotification);
        padFlash = juce::jmax (padFlash, slotFlash[(size_t) s]);
        slotFlash[(size_t) s] *= 0.82f;
    }
    pad.setFlash (padFlash);

    if (const int s = proc.engine().lastSlot.load(); s >= 0)
    {
        const int smp = proc.engine().lastSamples.load(), syn = proc.engine().lastSynth.load();
        juce::String src = smp > 0 ? juce::String (smp) + " sample" + (smp == 1 ? "" : "s") + (syn > 0 ? " + " + juce::String (syn) + " synth" : "")
                                   : juce::String (syn) + " synth";
        lastHit.setText (proc.taxonomy().folder (folder).slotNames[(size_t) s] + "  \xc2\xb7  vel "
                         + juce::String (juce::roundToInt (1 + proc.engine().lastVelocity.load() * 126)) + "  \xc2\xb7  " + src,
                         juce::dontSendNotification);
    }

    auto status = proc.libraryStatus();
    if (auto lib = proc.engine().library())
        status << "\n\nThis folder: " << lib->countFolder (folder) << " samples";
    if (libraryLabel.getText() != status) libraryLabel.setText (status, juce::dontSendNotification);
    loadButton.setEnabled (! proc.isLoadingLibrary());
    unloadButton.setEnabled (proc.engine().library() != nullptr);
}

void GestureFoleyEditor::chooseLibrary()
{
    chooser = std::make_unique<juce::FileChooser> ("Choose your Gesture Foley sample folder", proc.libraryFolder());
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories,
                          [this] (const juce::FileChooser& fc)
                          {
                              auto dir = fc.getResult();
                              if (dir.isDirectory()) proc.loadLibrary (dir);
                          });
}

bool GestureFoleyEditor::keyPressed (const juce::KeyPress& k)
{
    const auto c = k.getTextCharacter();
    if (c >= '1' && c <= '4')
    {
        proc.audition (c - '1', k.getModifiers().isShiftDown() ? 0.4f : 0.85f);
        return true;
    }
    return false;
}

void GestureFoleyEditor::paint (juce::Graphics& g)
{
    g.fillAll (bg);
    // faint colour wash behind the glass cards
    juce::ColourGradient wash (accent.withAlpha (0.10f), 0, 0, right.withAlpha (0.06f), (float) getWidth(), (float) getHeight(), false);
    g.setGradientFill (wash);
    g.fillAll();

    g.setColour (text);
    g.setFont (juce::FontOptions (22.0f).withStyle ("Bold"));
    g.drawText ("Gesture Foley", header.withTrimmedLeft (4).removeFromTop (30), juce::Justification::bottomLeft);
    g.setColour (dim);
    g.setFont (juce::FontOptions (12.5f));
    g.drawText ("A project by Atharva Bankar", header.withTrimmedLeft (4).withTrimmedTop (30), juce::Justification::topLeft);
    g.drawText ("v" + juce::String (JucePlugin_VersionString) + "  \xc2\xb7  \xc2\xa9 2026 Atharva Bankar", header, juce::Justification::centredRight);

    card (g, foldersCard.toFloat(), "Folders");
    card (g, padCard.toFloat(), "Blend pad");
    card (g, sideCard.toFloat(), "Sound");
    card (g, samplesCard.toFloat(), "Your samples");
}

void GestureFoleyEditor::resized()
{
    auto r = getLocalBounds().reduced (16);
    header = r.removeFromTop (52);
    r.removeFromTop (8);

    foldersCard = r.removeFromLeft (180);
    r.removeFromLeft (12);
    auto side = r.removeFromRight (260);
    r.removeFromRight (12);
    padCard = r;

    // folders
    {
        auto f = foldersCard.reduced (12).withTrimmedTop (22);
        const int h = juce::jmin (40, (f.getHeight() - 4 * (folderButtons.size() - 1)) / juce::jmax (1, folderButtons.size()));
        for (auto* b : folderButtons) { b->setBounds (f.removeFromTop (h)); f.removeFromTop (4); }
    }

    // pad card: corner boxes above and below the square pad, finger pads at the bottom
    {
        auto c = padCard.reduced (16).withTrimmedTop (22);
        auto fingers = c.removeFromBottom (58);
        lastHit.setBounds (c.removeFromBottom (24));
        auto top = c.removeFromTop (28);
        c.removeFromTop (8);
        auto bottom = c.removeFromBottom (28);
        c.removeFromBottom (8);

        const int sideLen = juce::jmin (c.getWidth(), c.getHeight());
        auto square = c.withSizeKeepingCentre (sideLen, sideLen);
        pad.setBounds (square);

        auto row = [&] (juce::Rectangle<int> band, juce::ComboBox& a, juce::ComboBox& b)
        {
            band = band.withX (square.getX()).withWidth (square.getWidth());
            const int w = (band.getWidth() - 8) / 2;
            a.setBounds (band.removeFromLeft (w));
            b.setBounds (band.removeFromRight (w));
        };
        row (top, cornerBoxes[0], cornerBoxes[1]);
        row (bottom, cornerBoxes[2], cornerBoxes[3]);
        resetCorners.setBounds (padCard.getRight() - 16 - 120, padCard.getY() + 8, 120, 22);

        const int w = (fingers.getWidth() - 3 * 8) / 4;
        for (auto& b : slotButtons) { b.setBounds (fingers.removeFromLeft (w)); fingers.removeFromLeft (8); }
    }

    // side: knobs, then samples
    sideCard = side.removeFromTop (juce::jmin (300, side.getHeight() / 2 + 20));
    side.removeFromTop (12);
    samplesCard = side;
    {
        auto k = sideCard.reduced (12).withTrimmedTop (22);
        const int cellW = k.getWidth() / 3, cellH = k.getHeight() / 2;
        for (size_t i = 0; i < knobs.size(); ++i)
        {
            auto cell = juce::Rectangle<int> (k.getX() + (int) (i % 3) * cellW, k.getY() + (int) (i / 3) * cellH, cellW, cellH).reduced (2);
            knobs[i].label.setBounds (cell.removeFromTop (16));
            knobs[i].slider.setBounds (cell);
        }
    }
    {
        auto s = samplesCard.reduced (14).withTrimmedTop (22);
        auto buttons = s.removeFromTop (30);
        unloadButton.setBounds (buttons.removeFromRight (72));
        buttons.removeFromRight (6);
        loadButton.setBounds (buttons);
        s.removeFromTop (8);
        midiLabel.setBounds (s.removeFromBottom (78));
        libraryLabel.setBounds (s);
    }
}
