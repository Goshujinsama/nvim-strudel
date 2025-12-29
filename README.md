# nvim-strudel

Live code music in Neovim with [Strudel](https://strudel.cc/).

nvim-strudel brings the Strudel live coding music environment to Neovim, providing real-time visualization of active pattern elements and full playback control.

## Features

- Live code music patterns directly in Neovim
- Real-time visual feedback showing which code elements are currently producing sound
- Full playback control (play, pause, stop, hush)
- Pianoroll visualization (auto-shows when playing, hides when stopped)
- LSP support for mini-notation (completions, hover, diagnostics)
- All default Strudel samples available (piano, drums, synths, etc.)

## Requirements

- Neovim >= 0.9.0
- Node.js >= 18.0
- Audio output device

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
    output = 'webaudio',      -- 'webaudio' (default) or 'osc' (SuperDirt)
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

## Pianoroll

The pianoroll provides a visual representation of your pattern. It automatically shows when playback starts and hides when stopped.

- Toggle with `:StrudelPianoroll`
- Stays visible when paused
- Supports multiple visualization modes: `auto`, `tracks`, `notes`, `drums`
- Pattern code using `.pianoroll()` or `.punchcard()` auto-enables visualization

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

### Web Audio (Default)

The default backend uses Node.js Web Audio API via `node-web-audio-api`. This works out of the box with no additional setup.

**Pros**: Zero configuration, works immediately  
**Cons**: Higher CPU usage, potential memory growth with heavy effects (tremolo, etc.)

### OSC/SuperDirt Backend

For better performance and professional audio quality, you can use SuperCollider with SuperDirt. This sends OSC messages to SuperDirt instead of synthesizing audio in Node.js.

**Pros**: Lower CPU, better audio quality, access to SuperDirt effects  
**Cons**: Requires SuperCollider installation

#### Configuration

Enable OSC output in your setup:

```lua
require('strudel').setup({
  audio = {
    output = 'osc',           -- Use SuperDirt instead of Web Audio
    osc_host = '127.0.0.1',   -- SuperDirt host (default)
    osc_port = 57120,         -- SuperDirt port (default)
    auto_superdirt = true,    -- Auto-start SuperDirt (default)
  },
})
```

When `auto_superdirt = true` (the default), nvim-strudel will automatically:
- Install the SuperDirt quark if not already installed
- Start JACK on Linux if not already running
- Launch SuperDirt with optimized settings

#### Installing SuperCollider

You only need to install SuperCollider and JACK. SuperDirt is installed automatically.

> **Note:** Installing JACK with D-Bus support (`jack2-dbus` or `jackd2`) is highly recommended. D-Bus allows PulseAudio/PipeWire to automatically release the audio device when JACK starts and route audio through JACK, avoiding conflicts.

**Arch Linux:**
```bash
sudo pacman -S jack2-dbus supercollider sc3-plugins
```

**Debian/Ubuntu:**
```bash
sudo apt install jackd2 supercollider sc3-plugins
```

**Fedora:**
```bash
sudo dnf install jack-audio-connection-kit-dbus supercollider supercollider-sc3-plugins
```

**macOS (Homebrew):**
```bash
brew install jack supercollider
```

#### Troubleshooting OSC

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
