// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
// Works out where a sample belongs from its folder path, the same way the web demo does:
//
//   Folder / Texture / Sub-category / Sound (finger) / file.wav
//   Footsteps / Wood / Stairs / Step (thumb + index) / step_01.wav
//
// The sub-category folder is optional (files then go to the texture's first sub-category).
// Folder names are matched loosely: case, spaces and punctuation are ignored.
#pragma once

#include "Taxonomy.h"
#include <optional>

namespace gf
{
    struct Route
    {
        int folder = -1;   // index into the taxonomy
        int cell = -1;     // index into that folder's cells
        int slot = -1;     // 0 index, 1 middle, 2 ring, 3 pinky
    };

    /** @param folderSegments the folders above the file, outermost first (no file name). */
    std::optional<Route> route (const Taxonomy& t, const juce::StringArray& folderSegments);

    /** Convenience: route a path such as "Footsteps/Wood/Stairs/Step/a.wav" (last part is the file). */
    std::optional<Route> routePath (const Taxonomy& t, const juce::String& path);
}
