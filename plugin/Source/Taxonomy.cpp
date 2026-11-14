// Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#include "Taxonomy.h"
#include "BinaryData.h"
#include <stdexcept>

namespace gf
{
    juce::String norm (const juce::String& s)
    {
        juce::String out;
        for (auto c : s.toLowerCase())
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
                out += c;
        return out;
    }

    bool Folder::hasCell (const juce::String& cellKey) const { return cellIndex (cellKey) >= 0; }

    int Folder::cellIndex (const juce::String& cellKey) const
    {
        for (size_t i = 0; i < cells.size(); ++i)
            if (cells[i].key == cellKey)
                return (int) i;
        return -1;
    }

    static juce::String need (const juce::var& v, const char* field)
    {
        auto s = v[field].toString();
        if (s.isEmpty())
            throw std::runtime_error (std::string ("taxonomy: missing ") + field);
        return s;
    }

    Taxonomy Taxonomy::fromJson (const juce::String& json)
    {
        auto root = juce::JSON::parse (json);
        auto* folders = root["folders"].getArray();
        if (folders == nullptr || folders->isEmpty())
            throw std::runtime_error ("taxonomy: no folders");

        Taxonomy t;
        for (auto& fv : *folders)
        {
            Folder f;
            f.key = need (fv, "key");
            f.name = need (fv, "name");
            for (int s = 0; s < numSlots; ++s)
                f.slotNames[(size_t) s] = fv["slots"][slotKeys[(size_t) s].toRawUTF8()].toString();

            if (auto* a = fv["aliases"].getArray())
                for (auto& alias : *a)
                    f.aliases.add (norm (alias.toString()));
            f.aliases.addIfNotAlreadyThere (norm (f.name));

            auto* textures = fv["textures"].getArray();
            if (textures == nullptr || textures->isEmpty())
                throw std::runtime_error ("taxonomy: folder without textures");

            for (auto& tv : *textures)
            {
                Texture tex { need (tv, "key"), need (tv, "name"), {} };
                if (auto* vs = tv["variants"].getArray())
                    for (auto& vv : *vs)
                        tex.variants.push_back ({ need (vv, "key"), need (vv, "name") });
                if (tex.variants.empty())
                    throw std::runtime_error ("taxonomy: texture without sub-categories");
                for (auto& v : tex.variants)
                    f.cells.push_back ({ tex.key + "." + v.key, tex.name + " \xc2\xb7 " + v.name });
                f.textures.push_back (std::move (tex));
            }

            auto* corners = fv["corners"].getArray();
            for (int c = 0; c < numSlots; ++c)
            {
                auto key = (corners != nullptr && c < corners->size()) ? (*corners)[c].toString() : juce::String();
                f.defaultCorners[(size_t) c] = f.hasCell (key) ? key : f.cells[(size_t) c % f.cells.size()].key;
            }
            t.list.push_back (std::move (f));
        }
        return t;
    }

    const Taxonomy& Taxonomy::builtIn()
    {
        static const Taxonomy t = fromJson (juce::String::fromUTF8 (BinaryData::taxonomy_json, BinaryData::taxonomy_jsonSize));
        return t;
    }

    int Taxonomy::folderIndex (const juce::String& key) const
    {
        for (size_t i = 0; i < list.size(); ++i)
            if (list[i].key == key)
                return (int) i;
        return -1;
    }

    int Taxonomy::numCells() const
    {
        int n = 0;
        for (auto& f : list)
            n += (int) f.cells.size();
        return n;
    }
}
