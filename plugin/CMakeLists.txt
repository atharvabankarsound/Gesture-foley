# Gesture Foley · Copyright (c) 2026 Atharva Bankar. All rights reserved. See LICENSE.
#
# Builds the Gesture Foley plugin (AU, VST3 and a Standalone app) and its tests.
#
#   cmake -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build --config Release
#
# JUCE is downloaded automatically. To use a copy you already have:
#   cmake -B build -DGF_JUCE_DIR=/path/to/JUCE

cmake_minimum_required(VERSION 3.22)
project(GestureFoley VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Oldest macOS version supported")
if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Universal binary" FORCE)
endif()

set(GF_JUCE_DIR "" CACHE PATH "Use this JUCE folder instead of downloading it")
option(GF_BUILD_TESTS "Build the engine tests" ON)
option(GF_COPY_AFTER_BUILD "Copy the AU/VST3 into your plugin folders after building" OFF)
# Linux build machines without the full set of X11/ALSA dev packages (used for CI only).
option(GF_LINUX_MINIMAL "Linux: build without ALSA, JACK, XRandR, Xinerama, Xcursor and XInput" OFF)

if(GF_JUCE_DIR)
    add_subdirectory(${GF_JUCE_DIR} ${CMAKE_BINARY_DIR}/JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 9.0.5
        GIT_SHALLOW ON)
    FetchContent_MakeAvailable(JUCE)
endif()

juce_add_plugin(GestureFoley
    PRODUCT_NAME "Gesture Foley"
    VERSION ${PROJECT_VERSION}
    COMPANY_NAME "The Richmond Studios"
    COMPANY_COPYRIGHT "Copyright (c) 2026 Atharva Bankar. All rights reserved."
    BUNDLE_ID com.therichmondstudios.gesturefoley
    PLUGIN_MANUFACTURER_CODE Trsl
    PLUGIN_CODE Gfly
    FORMATS AU VST3 Standalone
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    VST3_CATEGORIES Instrument Sampler
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    COPY_PLUGIN_AFTER_BUILD ${GF_COPY_AFTER_BUILD})

juce_add_binary_data(GestureFoleyData SOURCES Resources/taxonomy.json)

# Engine code shared by the plugin and the tests (no plugin or GUI dependencies).
set(GF_ENGINE_SOURCES
    Source/Taxonomy.cpp
    Source/Router.cpp
    Source/SampleLibrary.cpp
    Source/FallbackSynth.cpp
    Source/Engine.cpp)

target_sources(GestureFoley PRIVATE
    ${GF_ENGINE_SOURCES}
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/XYPad.cpp)

set(GF_DEFINITIONS
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)
if(GF_LINUX_MINIMAL)
    list(APPEND GF_DEFINITIONS JUCE_ALSA=0 JUCE_JACK=0 JUCE_USE_XRANDR=0 JUCE_USE_XINERAMA=0
        JUCE_USE_XCURSOR=0 JUCE_USE_XINPUT=0 JUCE_USE_XRENDER=0)
endif()

target_compile_definitions(GestureFoley PUBLIC ${GF_DEFINITIONS})

target_link_libraries(GestureFoley
    PRIVATE
        GestureFoleyData
        juce::juce_audio_utils
        juce::juce_audio_formats
        juce::juce_dsp
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

if(GF_BUILD_TESTS)
    juce_add_console_app(GestureFoleyTests PRODUCT_NAME "Gesture Foley Tests")
    target_sources(GestureFoleyTests PRIVATE ${GF_ENGINE_SOURCES} Tests/EngineTests.cpp)
    target_include_directories(GestureFoleyTests PRIVATE Source)
    target_compile_definitions(GestureFoleyTests PRIVATE ${GF_DEFINITIONS} JUCE_STANDALONE_APPLICATION=1)
    target_link_libraries(GestureFoleyTests
        PRIVATE
            GestureFoleyData
            juce::juce_audio_formats
            juce::juce_dsp
        PUBLIC
            juce::juce_recommended_config_flags
            juce::juce_recommended_warning_flags)
endif()

# Developer tool: loads the built VST3 like a DAW does and checks it (see Tests/HostCheck.cpp).
option(GF_BUILD_HOST_CHECK "Build the VST3 host check tool" OFF)
if(GF_BUILD_HOST_CHECK)
    juce_add_console_app(GestureFoleyHostCheck PRODUCT_NAME "Gesture Foley Host Check")
    target_sources(GestureFoleyHostCheck PRIVATE Tests/HostCheck.cpp)
    target_compile_definitions(GestureFoleyHostCheck PRIVATE ${GF_DEFINITIONS} JUCE_PLUGINHOST_VST3=1 JUCE_STANDALONE_APPLICATION=1 JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(GestureFoleyHostCheck
        PRIVATE juce::juce_audio_processors juce::juce_gui_basics
        PUBLIC juce::juce_recommended_config_flags)
endif()

# Developer tool: renders the plugin window to a PNG (see Tests/EditorSnapshot.cpp).
option(GF_BUILD_SNAPSHOT "Build the editor snapshot tool" OFF)
if(GF_BUILD_SNAPSHOT)
    juce_add_console_app(GestureFoleySnapshot PRODUCT_NAME "Gesture Foley Snapshot")
    target_sources(GestureFoleySnapshot PRIVATE Tests/EditorSnapshot.cpp)
    target_include_directories(GestureFoleySnapshot PRIVATE Source)
    target_compile_definitions(GestureFoleySnapshot PRIVATE JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(GestureFoleySnapshot PRIVATE GestureFoley juce::juce_audio_utils juce::juce_dsp)
endif()
