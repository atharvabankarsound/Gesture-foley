// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "SampleLibrary.h"
#include "Router.h"

namespace gf
{
    juce::String LoadReport::summary() const
    {
        if (cancelled) return "Loading cancelled.";
        juce::String s;
        s << added << " sample" << (added == 1 ? "" : "s") << " in " << cellsFilled << " cell" << (cellsFilled == 1 ? "" : "s");
        if (unmatched > 0) s << ", " << unmatched << " not in a matching folder";
        if (failed > 0) s << ", " << failed << " unreadable";
        if (skipped > 0) s << ", " << skipped << " skipped (too long or cell full)";
        return s;
    }

    SampleLibrary::SampleLibrary (const Taxonomy& t) : taxonomy (t)
    {
        int n = 0;
        for (auto& f : t.folders())
        {
            offsets.push_back (n);
            n += (int) f.cells.size();
        }
        cells.resize ((size_t) n * numSlots);
    }

    int SampleLibrary::index (int folder, int cell, int slot) const noexcept
    {
        if (folder < 0 || folder >= (int) offsets.size() || slot < 0 || slot >= numSlots) return -1;
        if (cell < 0 || cell >= (int) taxonomy.folder (folder).cells.size()) return -1;
        return (offsets[(size_t) folder] + cell) * numSlots + slot;
    }

    int SampleLibrary::count (int folder, int cell, int slot) const noexcept
    {
        auto i = index (folder, cell, slot);
        return i < 0 ? 0 : (int) cells[(size_t) i].size();
    }

    int SampleLibrary::countFolder (int folder) const noexcept
    {
        int n = 0;
        auto numCells = (int) taxonomy.folder (folder).cells.size();
        for (int c = 0; c < numCells; ++c)
            for (int s = 0; s < numSlots; ++s)
                n += count (folder, c, s);
        return n;
    }

    int SampleLibrary::total() const noexcept
    {
        int n = 0;
        for (auto& c : cells) n += (int) c.size();
        return n;
    }

    bool SampleLibrary::add (int folder, int cell, int slot, std::unique_ptr<Sample> s)
    {
        auto i = index (folder, cell, slot);
        if (i < 0 || s == nullptr || (int) cells[(size_t) i].size() >= maxPerCell) return false;
        cells[(size_t) i].push_back (std::move (s));
        return true;
    }

    std::shared_ptr<SampleLibrary> SampleLibrary::load (const juce::File& root, const Taxonomy& t,
                                                        const std::atomic<bool>* shouldStop, LoadReport& report)
    {
        report = {};
        auto lib = std::make_shared<SampleLibrary> (t);
        lib->root = root;
        if (! root.isDirectory()) return lib;

        juce::AudioFormatManager formats;
        formats.registerBasicFormats();   // WAV, AIFF, FLAC, Ogg, MP3 (and CoreAudio formats on Mac)

        auto stop = [&] { return shouldStop != nullptr && shouldStop->load(); };

        for (const auto& entry : juce::RangedDirectoryIterator (root, true, "*", juce::File::findFiles))
        {
            if (stop()) { report.cancelled = true; return lib; }

            auto file = entry.getFile();
            if (file.getFileName().startsWithChar ('.')) continue;
            if (formats.findFormatForFileExtension (file.getFileExtension()) == nullptr) continue;

            auto r = routePath (t, file.getRelativePathFrom (root.getParentDirectory()));
            if (! r) { ++report.unmatched; continue; }

            if (file.getSize() > maxFileBytes || lib->count (r->folder, r->cell, r->slot) >= maxPerCell)
            {
                ++report.skipped;
                continue;
            }

            std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));
            if (reader == nullptr || reader->sampleRate <= 0 || reader->lengthInSamples <= 0)
            {
                ++report.failed;
                continue;
            }
            if ((double) reader->lengthInSamples / reader->sampleRate > maxSeconds)
            {
                ++report.skipped;
                continue;
            }

            auto s = std::make_unique<Sample>();
            auto channels = (int) juce::jlimit (1u, 2u, reader->numChannels);
            s->audio.setSize (channels, (int) reader->lengthInSamples);
            if (! reader->read (&s->audio, 0, (int) reader->lengthInSamples, 0, true, channels > 1))
            {
                ++report.failed;
                continue;
            }
            s->sampleRate = reader->sampleRate;
            s->name = file.getFileName();

            bool wasEmpty = lib->count (r->folder, r->cell, r->slot) == 0;
            if (lib->add (r->folder, r->cell, r->slot, std::move (s)))
            {
                ++report.added;
                if (wasEmpty) ++report.cellsFilled;
            }
        }
        return lib;
    }
}
