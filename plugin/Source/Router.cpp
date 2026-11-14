// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "Router.h"

namespace gf
{
    static const std::array<juce::StringArray, numSlots> slotAliases {
        juce::StringArray { "index", "1", "first" },
        juce::StringArray { "middle", "2", "second" },
        juce::StringArray { "ring", "3", "third" },
        juce::StringArray { "pinky", "little", "4", "fourth" },
    };

    // A lone digit only counts when it isn't part of a longer number: "finger 4" yes, "14" no.
    static bool containsLoneDigit (const juce::String& s, juce::juce_wchar d)
    {
        for (int i = 0; i < s.length(); ++i)
            if (s[i] == d)
            {
                bool before = i == 0 || ! juce::CharacterFunctions::isDigit (s[i - 1]);
                bool after = i == s.length() - 1 || ! juce::CharacterFunctions::isDigit (s[i + 1]);
                if (before && after) return true;
            }
        return false;
    }

    std::optional<Route> route (const Taxonomy& t, const juce::StringArray& folderSegments)
    {
        juce::StringArray segs;
        for (auto& s : folderSegments)
            segs.add (norm (s));

        // 1. the folder: the first segment that names one
        Route r;
        int at = -1;
        for (int i = 0; i < segs.size() && r.folder < 0; ++i)
            for (int f = 0; f < t.numFolders() && r.folder < 0; ++f)
                if (t.folder (f).aliases.contains (segs[i]))
                {
                    r.folder = f;
                    at = i;
                }
        if (r.folder < 0) return std::nullopt;
        const auto& folder = t.folder (r.folder);

        // 2. the texture: a later segment that names one
        const Texture* tex = nullptr;
        for (int i = at + 1; i < segs.size() && tex == nullptr; ++i)
            for (auto& candidate : folder.textures)
                if (tex == nullptr && (norm (candidate.key) == segs[i] || norm (candidate.name) == segs[i]))
                {
                    tex = &candidate;
                    at = i;
                }
        if (tex == nullptr) return std::nullopt;

        // 3. the sub-category: only the very next segment, otherwise the first one
        const Variant* variant = nullptr;
        if (at + 1 < segs.size())
            for (auto& v : tex->variants)
                if (variant == nullptr && (norm (v.key) == segs[at + 1] || norm (v.name) == segs[at + 1]))
                    variant = &v;
        if (variant != nullptr) ++at;
        else variant = &tex->variants.front();
        r.cell = folder.cellIndex (tex->key + "." + variant->key);

        // 4. the finger: exact names beat contained words, and longer names win
        int best = 0;
        for (int i = at + 1; i < segs.size(); ++i)
        {
            const auto& s = segs[i];
            for (int slot = 0; slot < numSlots; ++slot)
            {
                juce::StringArray names (slotAliases[(size_t) slot]);
                names.add (norm (folder.slotNames[(size_t) slot]));
                for (auto& n : names)
                {
                    int score = 0;
                    if (s == n) score = 1000 + n.length();
                    else if (n.length() == 1 && juce::CharacterFunctions::isDigit (n[0])) score = containsLoneDigit (s, n[0]) ? 1 : 0;
                    else if (n.length() > 2 && s.contains (n)) score = 10 + n.length();
                    if (score > best)
                    {
                        best = score;
                        r.slot = slot;
                    }
                }
            }
        }
        if (r.slot < 0 || r.cell < 0) return std::nullopt;
        return r;
    }

    std::optional<Route> routePath (const Taxonomy& t, const juce::String& path)
    {
        auto parts = juce::StringArray::fromTokens (path.replaceCharacter ('\\', '/'), "/", "");
        parts.removeEmptyStrings();
        if (parts.size() < 2) return std::nullopt;
        parts.remove (parts.size() - 1);
        return route (t, parts);
    }
}
