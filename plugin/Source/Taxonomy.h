// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// The folder / texture / sub-category list, shared with the web demo
// (generated into Resources/taxonomy.json by tools/export_taxonomy.mjs).
#pragma once

#include <juce_core/juce_core.h>
#include <array>

namespace gf
{
    constexpr int numSlots = 4;   // index, middle, ring, pinky (each touched with the thumb)
    inline const std::array<juce::String, numSlots> slotKeys { "index", "middle", "ring", "pinky" };

    struct Variant { juce::String key, name; };

    struct Texture
    {
        juce::String key, name;
        std::vector<Variant> variants;
    };

    /** A sound on the pad: texture + sub-category, e.g. "wood.stairs". */
    struct Cell
    {
        juce::String key;     // "wood.stairs"
        juce::String label;   // "Wood · Stairs"
    };

    struct Folder
    {
        juce::String key, name;
        std::array<juce::String, numSlots> slotNames;   // "Step", "Scuff", ...
        juce::StringArray aliases;                      // folder names accepted on disk
        std::array<juce::String, numSlots> defaultCorners;
        std::vector<Texture> textures;
        std::vector<Cell> cells;                        // every texture.variant, in order

        bool hasCell (const juce::String& cellKey) const;
        int cellIndex (const juce::String& cellKey) const;   // -1 if missing
    };

    class Taxonomy
    {
    public:
        /** The list built into the plugin. */
        static const Taxonomy& builtIn();

        /** Parse taxonomy JSON. Throws std::runtime_error on bad data. */
        static Taxonomy fromJson (const juce::String& json);

        const std::vector<Folder>& folders() const noexcept { return list; }
        int numFolders() const noexcept { return (int) list.size(); }
        const Folder& folder (int index) const { return list.at ((size_t) juce::jlimit (0, numFolders() - 1, index)); }
        int folderIndex (const juce::String& key) const;     // -1 if missing
        int numCells() const;

    private:
        std::vector<Folder> list;
    };

    /** Lower-case letters and digits only, as the web demo does ("2 - Scuff" -> "2scuff"). */
    juce::String norm (const juce::String& s);
}
