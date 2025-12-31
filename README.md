# nvim-strudel

Live code music in Neovim with [Strudel](https://strudel.cc/).

nvim-strudel brings the Strudel live coding music environment to Neovim, providing real-time visualization of active pattern elements and full playback control.

## Features

- Live code music patterns directly in Neovim
- Real-time visual feedback showing which code elements are currently producing sound
- Full playback control (play, pause, stop, hush)
- Pianoroll visualization (auto-shows when playing, hides when stopped)
- LSP support for mini-notation (completions, hover, diagnostics)
- **Music theory intelligence** - key detection, chord suggestions, scale browser
- All default Strudel samples available (piano, drums, synths, etc.)

## Requirements

- Neovim >= 0.9.0
- Node.js >= 18.0
- Audio output device
- **SuperCollider** with **SuperDirt** (for audio synthesis)

### Installing Audio Dependencies

nvim-strudel uses OSC to send patterns to SuperDirt for audio synthesis. You need SuperCollider and JACK installed. SuperDirt is installed automatically on first run.

**Arch Linux:**
```bash
sudo pacman -S jack2-dbus supercollider sc3-plugins
```

**Fedora:**
```bash
sudo dnf install jack-audio-connection-kit-dbus supercollider supercollider-sc3-plugins
```

**Debian/Ubuntu:**
```bash
sudo apt install jackd2 supercollider sc3-plugins
```

**macOS (Homebrew):**
```bash
brew install jack supercollider
```

> **Note:** Installing JACK with D-Bus support (`jack2-dbus` or `jackd2`) is recommended. D-Bus allows PulseAudio/PipeWire to automatically release the audio device when JACK starts.

## Installation

### Using lazy.nvim

```lua
{
    'bathyalecho/nvim-strudel',
    ft = 'strudel',
    build = 'cd server && npm install && npm run build',
    keys = {
      { '<C-CR>', '<cmd>StrudelEval<cr>', ft = 'strudel', desc = 'Strudel: Eval' },
      { '<leader>ss', '<cmd>StrudelStop<cr>', ft = 'strudel', desc = 'Strudel: Stop' },
    },
    config = function()
      require('strudel').setup()
    end,
}
```

The `build` step compiles the backend server when the plugin is installed or updated.

## Quick Start

1. Open a `.strudel` file
2. Write a pattern: `s("bd sd bd sd").fast(2)`
3. Press `Ctrl+Enter` to play (or `:StrudelPlay`)

<details>
<summary><strong>All Configuration Options</strong></summary>

```lua
require('strudel').setup({
  -- Server connection
  server = {
    host = '127.0.0.1',
    port = 37812,
    auto_start = true,  -- Start server automatically on :StrudelConnect
  },

  -- Audio output backend
  audio = {
    output = 'osc',           -- 'osc' (default, SuperDirt) or 'webaudio' (Node.js)
    osc_host = '127.0.0.1',   -- SuperDirt OSC host
    osc_port = 57120,         -- SuperDirt OSC port
    auto_superdirt = true,    -- Auto-start SuperDirt if sclang available
  },

  -- Visualization highlights
  highlight = {
    active = 'StrudelActive',   -- Currently sounding element
    pending = 'StrudelPending', -- Element about to sound
    muted = 'StrudelMuted',     -- Muted element
  },

  -- Conceal characters for playhead
  conceal = {
    enabled = true,
    char = '▶',
  },

  -- LSP for mini-notation
  lsp = {
    enabled = true,
  },

  -- Pianoroll visualization
  pianoroll = {
    height = 10,
    display_cycles = 2,
    mode = 'auto',  -- 'auto', 'tracks', 'notes', or 'drums'
  },

  -- Music theory features
  theory = {
    enabled = true,              -- Enable music theory features
    default_scope = 'line',      -- 'line', 'selection', or 'buffer'
    show_degrees = true,         -- Show scale degrees in suggestions
    show_functions = true,       -- Show harmonic functions (tonic, dominant, etc.)
    include_secondary = true,    -- Include secondary dominants
    include_substitutions = true, -- Include chord substitutions
    include_borrowed = true,     -- Include borrowed chords
  },

  -- Picker backend: 'auto', 'snacks', or 'telescope'
  picker = 'auto',

  -- Auto-evaluate on save
  auto_eval = false,

  -- File types to activate for
  filetypes = { 'strudel', 'javascript', 'typescript' },
})
```

</details>

## Commands

| Command | Description |
|---------|-------------|
| `:StrudelPlay` | Start playback (auto-connects and auto-evals if needed) |
| `:StrudelPause` | Pause playback |
| `:StrudelStop` | Stop playback and reset |
| `:StrudelHush` | Stop and silence all sounds immediately |
| `:StrudelEval` | Evaluate current buffer or selection (auto-connects if needed) |
| `:StrudelConnect` | Connect to server (auto-starts server if needed) |
| `:StrudelDisconnect` | Disconnect and stop server |
| `:StrudelStatus` | Show connection, server, and pianoroll status |
| `:StrudelPianoroll` | Toggle pianoroll visualization |
| `:StrudelSamples` | Browse available samples |
| `:StrudelSounds` | Browse available sounds |
| `:StrudelBanks` | Browse sample banks |
| `:StrudelPatterns` | Browse saved patterns |
| `:StrudelTheory [scope]` | Open chord suggestions popup (line/selection/buffer) |
| `:StrudelAnalyze [scope]` | Detect key/scale from patterns |
| `:StrudelScales [root]` | Browse and insert scales |
| `:StrudelChords [root]` | Browse and insert chord types |

## Pianoroll

The pianoroll provides a visual representation of your pattern. It automatically shows when playback starts and hides when stopped.

- Toggle with `:StrudelPianoroll`
- Stays visible when paused
- Supports multiple visualization modes: `auto`, `tracks`, `notes`, `drums`
- Pattern code using `.pianoroll()` or `.punchcard()` auto-enables visualization

## Music Theory

nvim-strudel includes music theory intelligence that analyzes your patterns and suggests compatible chords.

### Key Detection

Run `:StrudelAnalyze` to detect the key and scale from your patterns:

```javascript
note("c3 e3 g3 b3")  // Detected: C Major (85% confidence)
n("0 2 4 5 7")       // Detected: C Major (based on scale degrees)
chord("<Am7 Dm7 G7 Cmaj7>")  // Detected: C Major (from chord progression)
```

### Chord Suggestions

Run `:StrudelTheory` to open a floating window with chord suggestions:

```
┌─ Chord Suggestions ─────────────────┐
│ C Major (85%) [line]                │
│─────────────────────────────────────│
│ j/k:nav  c:chord  n:note  d:deg     │
│                                     │
│ ▶ Cmaj7    I (tonic)                │
│   Dm7      ii (supertonic)          │
│   Em7      iii (mediant)            │
│   Fmaj7    IV (subdominant)         │
│   G7       V (dominant)             │
│   Am7      vi (submediant)          │
│   Bm7b5    vii (leading tone)       │
│   D7       V7/ii (secondary dom)    │
└─────────────────────────────────────┘
```

**Floating window keybindings:**

| Key | Action |
|-----|--------|
| `j/k` or arrows | Navigate suggestions |
| `c` or `<CR>` | Insert as `chord("...")` |
| `n` | Insert as `note("...")` |
| `d` | Insert as `n("...")` (scale degrees) |
| `s` | Cycle scope (line → selection → buffer) |
| `q` or `<Esc>` | Close |

### Scale and Chord Browsers

Browse and insert scales or chords with a picker:

```vim
:StrudelScales       " Browse all scales (default root: C)
:StrudelScales G     " Browse scales starting on G
:StrudelChords       " Browse all chord types (default root: C)
:StrudelChords F#    " Browse chords with F# root
```

### Suggested Keymaps

```lua
vim.keymap.set('n', '<leader>st', '<cmd>StrudelTheory<cr>', { desc = 'Chord suggestions' })
vim.keymap.set('v', '<leader>st', '<cmd>StrudelTheory selection<cr>', { desc = 'Chord suggestions (selection)' })
vim.keymap.set('n', '<leader>sa', '<cmd>StrudelAnalyze<cr>', { desc = 'Analyze key/scale' })
```

## Keymaps

No keymaps are set by default. For live coding, you'll want at minimum:
- **Eval** (`<C-CR>` or `<S-CR>`) - Evaluate and play pattern (the core live coding action)
- **Stop** (`<leader>ss`) - Stop playback

Define keymaps using lazy.nvim's `keys` spec:

```lua
{
  'bathyalecho/nvim-strudel',
  ft = 'strudel',
  build = 'cd server && npm install && npm run build',
  keys = {
    { '<C-CR>', '<cmd>StrudelEval<cr>', ft = 'strudel', desc = 'Strudel: Eval' },
    { '<leader>ss', '<cmd>StrudelStop<cr>', ft = 'strudel', desc = 'Strudel: Stop' },
    { '<leader>sp', '<cmd>StrudelPianoroll<cr>', ft = 'strudel', desc = 'Strudel: Pianoroll' },
    -- Optional extras:
    -- { '<leader>sx', '<cmd>StrudelPause<cr>', ft = 'strudel', desc = 'Strudel: Pause' },
    -- { '<leader>sh', '<cmd>StrudelHush<cr>', ft = 'strudel', desc = 'Strudel: Hush' },
  },
}
```

Or define keymaps manually:

```lua
vim.keymap.set('n', '<leader>se', '<cmd>StrudelEval<cr>', { desc = 'Strudel: Eval' })
```

## LSP (Language Server)

nvim-strudel includes an LSP server for mini-notation that provides:

- **Completions**: Sample names, notes, scales, and mini-notation operators
- **Hover**: Documentation for samples, notes, and Strudel functions
- **Diagnostics**: Bracket matching errors and unknown sample warnings

The LSP starts automatically for configured filetypes. To disable:

```lua
require('strudel').setup({
  lsp = { enabled = false },
})
```

## Audio Backends

nvim-strudel supports two audio backends:

### OSC/SuperDirt (Default)

The default backend sends OSC messages to SuperDirt running in SuperCollider. This provides the best performance and audio quality.

**Pros**: Lower CPU usage, better audio quality, access to SuperDirt effects
**Cons**: Requires SuperCollider installation (see [Requirements](#installing-audio-dependencies))

When you run `:StrudelPlay`, nvim-strudel will automatically:
- Start JACK on Linux if not already running
- Launch SuperDirt with optimized settings
- Install the SuperDirt quark if not already installed

### Web Audio Backend

An alternative backend using Node.js Web Audio API via `node-web-audio-api`. This works without SuperCollider but has higher CPU usage.

**Pros**: No external dependencies beyond Node.js
**Cons**: Higher CPU usage, potential memory growth with heavy effects

To use Web Audio instead of OSC:

```lua
require('strudel').setup({
  audio = {
    output = 'webaudio',
  },
})
```

### Troubleshooting Audio

**No sound from SuperDirt:**
- Check `:StrudelStatus` to verify OSC is connected
- Look for errors in the Neovim messages (`:messages`)
- Verify JACK is running: `jack_lsp` should list ports

**SuperDirt fails to start:**
- Ensure SuperCollider is installed: `which sclang`
- On Linux, ensure JACK can start: try `jackd -d alsa` manually
- Check audio device permissions (user may need to be in `audio` group)

## Running the Server Manually

The server auto-starts by default when you use `:StrudelConnect` or `:StrudelPlay`. To run manually:

```bash
cd server
node dist/index.js [options]
```

Command-line options:
- `--port <port>` - TCP server port (default: 37812)
- `--host <host>` - TCP server host (default: 127.0.0.1)
- `--osc` - Enable OSC output to SuperDirt
- `--osc-host <host>` - SuperDirt host (default: 127.0.0.1)
- `--osc-port <port>` - SuperDirt port (default: 57120)
- `--auto-superdirt` - Auto-start SuperDirt if sclang is available
- `--no-auto-superdirt` - Don't auto-start SuperDirt

## Highlighting

Active elements are highlighted as they play. By default, highlights link to standard Neovim groups so they respect your colorscheme:

| Highlight Group | Default Link | Purpose |
|-----------------|--------------|---------|
| `StrudelActive` | `Search` | Currently sounding element |
| `StrudelPending` | `Visual` | Element about to sound |
| `StrudelMuted` | `Comment` | Muted/inactive element |
| `StrudelPlayhead` | `WarningMsg` | Playhead indicator |
| `StrudelConnected` | `DiagnosticOk` | Connected status |
| `StrudelDisconnected` | `DiagnosticError` | Disconnected status |
| `StrudelError` | `DiagnosticUnderlineError` | Error underline |
| `StrudelTheoryHeader` | `Title` | Theory popup header |
| `StrudelTheoryChord` | `Function` | Chord names in popup |
| `StrudelTheorySelected` | `CursorLine` | Selected suggestion |

To customize, override in your config (after colorscheme loads):

```lua
vim.api.nvim_set_hl(0, 'StrudelActive', { bg = '#3d5c3d', bold = true })
vim.api.nvim_set_hl(0, 'StrudelPending', { link = 'CursorLine' })
```

## License

AGPL-3.0 - Required due to dependency on Strudel libraries.

## Acknowledgments

- [Strudel](https://strudel.cc/) by Felix Roos and contributors
- [TidalCycles](https://tidalcycles.org/) for the pattern language inspiration
- Michael Liebenow for the original repo of this fork
