// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace
{
    juce::AudioProcessorValueTreeState::ParameterLayout makeLayout()
    {
        using namespace juce;
        AudioProcessorValueTreeState::ParameterLayout layout;

        StringArray folders;
        for (auto& f : gf::Taxonomy::builtIn().folders()) folders.add (f.name);

        auto pct = AudioParameterFloatAttributes().withStringFromValueFunction ([] (float v, int) { return String (roundToInt (v * 100)) + "%"; });
        layout.add (std::make_unique<AudioParameterChoice> (ParameterID { "folder", 1 }, "Folder", folders, 0));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "padX", 1 }, "Pad X", NormalisableRange<float> (0, 1), 0.5f, pct));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "padY", 1 }, "Pad Y", NormalisableRange<float> (0, 1), 0.5f, pct));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "size", 1 }, "Size", NormalisableRange<float> (0, 1), 0.5f,
            AudioParameterFloatAttributes().withStringFromValueFunction ([] (float v, int) {
                return v < 0.45f ? "Small " + String (roundToInt ((0.5f - v) * 200)) + "%" : v > 0.55f ? "Large " + String (roundToInt ((v - 0.5f) * 200)) + "%" : String ("Normal"); })));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "variation", 1 }, "Variation", NormalisableRange<float> (0, 1), 0.35f, pct));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "dynamics", 1 }, "Dynamics", NormalisableRange<float> (0, 1), 0.8f, pct));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "room", 1 }, "Room", NormalisableRange<float> (0, 1), 0.15f, pct));
        layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "level", 1 }, "Level", NormalisableRange<float> (-40, 6, 0.1f), -2.0f,
            AudioParameterFloatAttributes().withLabel ("dB")));
        return layout;
    }

    juce::String cornersId (const juce::String& folderKey) { return "corners_" + folderKey; }
}

GestureFoleyProcessor::GestureFoleyProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      Thread ("Gesture Foley sample loader"),
      params (*this, nullptr, "GestureFoley", makeLayout())
{
    for (auto& a : auditionVel) a.store (-1);
    params.state.setProperty ("libraryPath", "", nullptr);
    pushCornersToEngine();
    startTimerHz (30);
}

GestureFoleyProcessor::~GestureFoleyProcessor()
{
    stopTimer();
    stopThread (5000);
}

bool GestureFoleyProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void GestureFoleyProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    eng.prepare (sampleRate, samplesPerBlock);
}

/* ---------------------------------------------------------------- audio */

void GestureFoleyProcessor::handleMidi (const juce::MidiMessage& m)
{
    if (m.isNoteOn())
    {
        const int n = m.getNoteNumber() - firstNote;
        if (n >= 0 && n < 12)
        {
            const float pan = n < 4 ? 0.0f : n < 8 ? -0.25f : 0.25f;
            eng.trigger (n % 4, m.getFloatVelocity(), pan);
        }
    }
    else if (m.isController())
    {
        const float v = (float) m.getControllerValue() / 127.0f;
        auto c = eng.getControls();
        switch (m.getControllerNumber())
        {
            case 16: c.x = v; pendingX.store (v); break;
            case 17: c.y = v; pendingY.store (v); break;
            case 18: c.size = v; pendingSize.store (v); break;
            case 120: case 123: eng.allNotesOff(); break;   // all sound off / all notes off
            default: break;
        }
        eng.setControls (c);
    }
    else if (m.isProgramChange() && m.getProgramChangeNumber() < taxonomy().numFolders())
    {
        auto c = eng.getControls();
        c.folder = m.getProgramChangeNumber();
        pendingFolder.store (c.folder);
        eng.setControls (c);
    }
}

void GestureFoleyProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();

    // Parameters first; a MIDI CC in this block wins over the parameter until the host catches up.
    gf::Controls c;
    c.folder = (int) params.getRawParameterValue ("folder")->load();
    c.x = params.getRawParameterValue ("padX")->load();
    c.y = params.getRawParameterValue ("padY")->load();
    c.size = params.getRawParameterValue ("size")->load();
    c.variation = params.getRawParameterValue ("variation")->load();
    c.dynamics = params.getRawParameterValue ("dynamics")->load();
    c.room = params.getRawParameterValue ("room")->load();
    c.levelDb = params.getRawParameterValue ("level")->load();
    if (pendingX.load() >= 0) c.x = pendingX.load();
    if (pendingY.load() >= 0) c.y = pendingY.load();
    if (pendingSize.load() >= 0) c.size = pendingSize.load();
    if (pendingFolder.load() >= 0) c.folder = pendingFolder.load();
    eng.setControls (c);

    for (int s = 0; s < gf::numSlots; ++s)
        if (auto v = auditionVel[(size_t) s].exchange (-1); v >= 0)
            eng.trigger (s, v);

    // sample-accurate: render up to each MIDI event, then handle it
    int pos = 0;
    const int num = buffer.getNumSamples();
    for (const auto meta : midi)
    {
        const int at = juce::jlimit (0, num, meta.samplePosition);
        eng.render (buffer, pos, at - pos);
        pos = at;
        handleMidi (meta.getMessage());
    }
    eng.render (buffer, pos, num - pos);
}

void GestureFoleyProcessor::audition (int slot, float velocity)
{
    if (slot >= 0 && slot < gf::numSlots)
        auditionVel[(size_t) slot].store (juce::jlimit (0.0f, 1.0f, velocity));
}

/* ---------------------------------------------------------- message thread */

void GestureFoleyProcessor::timerCallback()
{
    eng.releaseRetired();

    // Tell the host about parameters moved by MIDI, so automation and the editor follow.
    auto sync = [this] (std::atomic<float>& pending, const char* id)
    {
        const float v = pending.load();
        if (v < 0) return;
        if (auto* p = params.getParameter (id))
        {
            p->beginChangeGesture();
            p->setValueNotifyingHost (p->convertTo0to1 (v));
            p->endChangeGesture();
        }
        float expected = v;
        pending.compare_exchange_strong (expected, -1.0f);   // keep it if a newer CC arrived meanwhile
    };
    sync (pendingX, "padX");
    sync (pendingY, "padY");
    sync (pendingSize, "size");
    if (const int f = pendingFolder.load(); f >= 0)
    {
        if (auto* p = params.getParameter ("folder"))
            p->setValueNotifyingHost (p->convertTo0to1 ((float) f));
        int expected = f;
        pendingFolder.compare_exchange_strong (expected, -1);
    }
}

int GestureFoleyProcessor::currentFolder() const
{
    return juce::jlimit (0, taxonomy().numFolders() - 1, (int) params.getRawParameterValue ("folder")->load());
}

void GestureFoleyProcessor::setCorner (int folder, int corner, int cellIndex)
{
    const auto& f = taxonomy().folder (folder);
    if (corner < 0 || corner > 3 || cellIndex < 0 || cellIndex >= (int) f.cells.size()) return;
    auto node = params.state.getOrCreateChildWithName (cornersId (f.key), nullptr);
    node.setProperty ("c" + juce::String (corner), f.cells[(size_t) cellIndex].key, nullptr);
    eng.setCorner (folder, corner, cellIndex);
}

void GestureFoleyProcessor::resetCorners (int folder)
{
    const auto& f = taxonomy().folder (folder);
    for (int c = 0; c < 4; ++c)
        setCorner (folder, c, f.cellIndex (f.defaultCorners[(size_t) c]));
}

void GestureFoleyProcessor::pushCornersToEngine()
{
    for (int fi = 0; fi < taxonomy().numFolders(); ++fi)
    {
        const auto& f = taxonomy().folder (fi);
        auto node = params.state.getChildWithName (cornersId (f.key));
        for (int c = 0; c < 4; ++c)
        {
            auto key = node.isValid() ? node.getProperty ("c" + juce::String (c)).toString() : juce::String();
            auto idx = f.cellIndex (key);
            eng.setCorner (fi, c, idx >= 0 ? idx : f.cellIndex (f.defaultCorners[(size_t) c]));
        }
    }
}

/* -------------------------------------------------------------- library */

void GestureFoleyProcessor::loadLibrary (const juce::File& folder)
{
    stopThread (5000);
    params.state.setProperty ("libraryPath", folder.getFullPathName(), nullptr);
    if (folder == juce::File())
    {
        eng.setLibrary (nullptr);
        const juce::ScopedLock l (loadLock);
        loadedFolder = juce::File();
        status = "No samples loaded: playing the built-in placeholder sounds.";
        return;
    }
    {
        const juce::ScopedLock l (loadLock);
        loadRequest = folder;
        status = "Loading " + folder.getFileName() + "...";
    }
    startThread();
}

void GestureFoleyProcessor::run()
{
    juce::File folder;
    {
        const juce::ScopedLock l (loadLock);
        folder = loadRequest;
    }

    gf::LoadReport report;
    std::atomic<bool> stop { false };
    // The loader checks `stop`; mirror threadShouldExit() into it from here.
    struct Watch : juce::Thread::Listener { std::atomic<bool>& s; explicit Watch (std::atomic<bool>& x) : s (x) {} void exitSignalSent() override { s = true; } } watch (stop);
    Thread::addListener (&watch);
    auto lib = gf::SampleLibrary::load (folder, taxonomy(), &stop, report);
    Thread::removeListener (&watch);

    if (threadShouldExit() || report.cancelled) return;

    juce::String text;
    if (! folder.isDirectory()) text = "Can't find " + folder.getFullPathName() + ". Load the folder again.";
    else if (report.added == 0) text = "No usable samples in " + folder.getFileName() + " (" + report.summary() + "). Expected e.g. Footsteps/Wood/Stairs/Step/step_01.wav";
    else text = folder.getFileName() + ": " + report.summary() + ".";

    eng.setLibrary (std::move (lib));
    const juce::ScopedLock l (loadLock);
    loadedFolder = folder;
    status = text;
}

juce::File GestureFoleyProcessor::libraryFolder() const
{
    const juce::ScopedLock l (loadLock);
    return loadedFolder;
}

juce::String GestureFoleyProcessor::libraryStatus() const
{
    const juce::ScopedLock l (loadLock);
    return status;
}

/* ---------------------------------------------------------------- state */

void GestureFoleyProcessor::getStateInformation (juce::MemoryBlock& dest)
{
    if (auto xml = params.copyState().createXml())
        copyXmlToBinary (*xml, dest);
}

void GestureFoleyProcessor::setStateInformation (const void* data, int size)
{
    auto xml = getXmlFromBinary (data, size);
    if (xml == nullptr || ! xml->hasTagName (params.state.getType())) return;
    params.replaceState (juce::ValueTree::fromXml (*xml));
    pushCornersToEngine();

    const auto path = params.state.getProperty ("libraryPath").toString();
    const auto folder = juce::File::isAbsolutePath (path) ? juce::File (path) : juce::File();
    if (folder != libraryFolder())
        loadLibrary (folder);
}

juce::AudioProcessorEditor* GestureFoleyProcessor::createEditor()
{
    return new GestureFoleyEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new GestureFoleyProcessor();
}
