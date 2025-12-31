# Changelog

All notable changes to nvim-strudel will be documented in this file.

## [1.1.0] - 2025-12-31

### Added
- **Music theory intelligence** - Key detection, chord suggestions, scale browser
  - `:StrudelTheory` - Floating window with chord suggestions based on detected key
  - `:StrudelAnalyze` - Detect key/scale from patterns (notes, chords, scale degrees)
  - `:StrudelScales` / `:StrudelChords` - Browse and insert scales/chords via picker
  - Supports secondary dominants, chord substitutions, and borrowed chords
- Smart audio routing: synth sounds go to Web Audio, samples go to OSC when both are available
- Warning when unknown drum machine bank is used
- Parallel `$:` pattern syntax now works correctly

### Fixed
- Fixed differing Pattern classes causing `stack(...).punchcard()` and similar to fail
- Fixed pianoroll rendering issues
- Reduced API calls and throttled buffer cleanup to improve performance
- Fixed memory management issues in client, visualizer, and sample manager
- Removed verbose logging that could impact performance

### Changed
- Default audio backend changed to `webaudio` (Node.js) instead of `osc`
- OSC-specific config options (`osc_host`, `osc_port`, `auto_superdirt`) only apply when using OSC backend

### Contributors
- Thanks to [@bathyalecho](https://github.com/bathyalecho) for the music theory feature, memory management fixes, and performance improvements

## [1.0.0] - 2025-12-29

First stable release with full feature set.

### Added
- OSC/SuperDirt backend for high-quality audio synthesis
- OSC timetag scheduling for precise SuperDirt timing
- Soundfont support with proper ADSR envelopes
- Sample cache validation to detect stale/corrupted caches
- On-demand sample loading for OSC mode
- Client-initiated server shutdown for graceful termination
- File logging infrastructure for debugging

### Fixed
- SuperDirt startup issues (Server.killAll, SC syntax errors)
- Soundfont sustain using note duration instead of sustain level
- Cached soundfonts not loading in SuperDirt from Neovim
- JACK shutdown reliability when Neovim exits
- Pianoroll crashes with nil note_range
- Playback stopping when switching buffers or using oil.nvim
- Pianoroll cursor flicker and visual artifacts
- Pianoroll note overlap and random highlight issues

### Changed
- Server process detached so Neovim doesn't wait on exit

## [0.9.0] - 2025-12-20

### Added
- MIDI output support via Web MIDI API polyfill (node-midi/RtMidi)
- MIDI input for CC control (`midin()`)
- Test utilities: `test-pattern.mjs`, `osc-sniffer.mjs`, `test-long.mjs`
- `--osc` and `--verbose` flags for pattern testing

### Fixed
- MIDI port cleanup on shutdown
- MIDI input auto-open when onmidimessage is set
- LSP false positives for voicing modes, register(), and core Pattern methods

## [0.8.0] - 2025-12-18

### Added
- Node.js Web Audio API support with worklet polyfills
- Drum machine bank support with alias resolution
- Improved process lifecycle management

### Changed
- Updated README with better keymaps, OSC docs, and JACK D-Bus recommendation

## [0.7.0] - 2025-12-15

### Added
- Pianoroll auto-show/hide behavior (shows on play, hides on stop, stays on pause)
- Smooth scrolling pianoroll visualization
- Braille pianoroll mode for notes and drums

### Fixed
- Pianoroll highlight column offsets for UTF-8 border characters
- Pianoroll state management (pause vs stop distinction)
- Cycle position caching when paused

## [0.6.0] - 2025-12-12

### Added
- Complete LSP documentation for all Strudel functions (500+)
- Auto-generated function documentation from Strudel JSDoc
- LSP uses TCP connection for samples/banks validation

### Changed
- Refactored LSP architecture for better sample/bank awareness

## [0.5.0] - 2025-12-10

### Added
- Animated ASCII pianoroll visualization
- `hush()` and `setcps()` exposed to eval scope
- Expanded LSP function coverage to 120+ functions

### Fixed
- LSP startup issues
- Converted plugin to pure Lua (removed Vim script)

## [0.4.0] - 2025-12-08

### Added
- LSP server for mini-notation (completions, hover, diagnostics, signature help)
- Code actions for common patterns
- Dynamic sample name completions

## [0.3.0] - 2025-12-05

### Added
- ZZFX chip sounds (retro/chiptune style)
- Drum machine bank aliases for short names (e.g., "808" -> "RolandTR808")
- Picker abstraction with Snacks.nvim and Telescope support

## [0.2.0] - 2025-12-03

### Added
- Complete audio implementation with Web Audio polyfills
- Timing fixes for accurate pattern playback
- Mason integration for backend server management

## [0.1.0] - 2025-12-01

### Added
- Initial implementation
- Project architecture and AGENTS.md
- Basic Strudel pattern evaluation
- Real-time visualization with highlight groups
- Playback control commands (play, pause, stop, hush, eval)
- WebSocket/TCP client for Neovim-server communication
