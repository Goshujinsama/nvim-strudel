# nvim-strudel Setup Guide for NixOS

This guide covers setting up nvim-strudel on NixOS, which requires special handling for native dependencies.

## Initial Setup

### 1. Install the Plugin

Add to your lazy.nvim config:

```lua
{
  'Goshujinsama/nvim-strudel',
  ft = 'strudel',
  build = function()
    -- Build server
    vim.fn.system('cd ' .. vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server && nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install" && npm run build')

    -- Create wrapper script
    local wrapper_path = vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server/strudel-server-wrapper.sh'
    local wrapper_content = [[#!/usr/bin/env bash
# Wrapper script for nvim-strudel server on NixOS
ALSA_LIB=$(find /nix/store -name "libasound.so.2" 2>/dev/null | head -1)
if [ -n "$ALSA_LIB" ]; then
    export LD_LIBRARY_PATH="$(dirname "$ALSA_LIB"):$LD_LIBRARY_PATH"
fi
JACK_LIB=$(find /nix/store -name "libjack.so.0" 2>/dev/null | head -1)
if [ -n "$JACK_LIB" ]; then
    export LD_LIBRARY_PATH="$(dirname "$JACK_LIB"):$LD_LIBRARY_PATH"
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/dist/index.js" "$@"
]]

    local file = io.open(wrapper_path, 'w')
    if file then
      file:write(wrapper_content)
      file:close()
      vim.fn.system('chmod +x ' .. wrapper_path)
    end
  end,
  keys = {
    { '<C-CR>', '<cmd>StrudelEval<cr>', ft = 'strudel', desc = 'Strudel: Eval' },
    { '<leader>ss', '<cmd>StrudelStop<cr>', ft = 'strudel', desc = 'Strudel: Stop' },
  },
  config = function()
    require('strudel').setup({
      server = {
        cmd = {
          vim.fn.stdpath('data') .. '/lazy/nvim-strudel/server/strudel-server-wrapper.sh'
        },
        host = '127.0.0.1',
        port = 37812,
        auto_start = true,
      },
      audio = {
        output = 'webaudio',  -- or 'osc' for SuperCollider/SuperDirt
      },
    })
  end,
}
```

### 2. Create the Wrapper Script (Required!)

**Important:** The build function may not create the wrapper script automatically. Create it manually:

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
cat > strudel-server-wrapper.sh << 'EOF'
#!/usr/bin/env bash
# Wrapper script for nvim-strudel server on NixOS
# Sets up library paths for native dependencies

# Find ALSA library in nix store
ALSA_LIB=$(find /nix/store -name "libasound.so.2" 2>/dev/null | head -1)
if [ -n "$ALSA_LIB" ]; then
    ALSA_DIR=$(dirname "$ALSA_LIB")
    export LD_LIBRARY_PATH="${ALSA_DIR}:$LD_LIBRARY_PATH"
fi

# Find JACK library in nix store (optional, for better audio)
JACK_LIB=$(find /nix/store -name "libjack.so.0" 2>/dev/null | head -1)
if [ -n "$JACK_LIB" ]; then
    JACK_DIR=$(dirname "$JACK_LIB")
    export LD_LIBRARY_PATH="${JACK_DIR}:$LD_LIBRARY_PATH"
fi

# Run the actual server
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/dist/index.js" "$@"
EOF

chmod +x strudel-server-wrapper.sh
```

**Verify it was created:**
```bash
ls -lh ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
# Should show: -rwxr-xr-x ... strudel-server-wrapper.sh
```

### 3. Build the Server

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install"
npm run build
```

## When Updating the Plugin

After running `:Lazy sync` or updating nvim-strudel:

```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server

# Rebuild the server
nix-shell -p gcc gnumake python3 nodejs alsa-lib pkg-config --run "npm install"
npm run build

# The wrapper script should still exist, but if not, recreate it (see step 2 above)
```

## Quick Start Usage

1. Create a file with `.strudel` extension
2. Write a pattern:
   ```javascript
   s("bd sd bd sd").fast(2)
   ```
3. Press `Ctrl+Enter` to play (or `:StrudelPlay`)
4. Press `<leader>ss` to stop

## Common Commands

| Command | Description |
|---------|-------------|
| `:StrudelPlay` | Start playback |
| `:StrudelStop` | Stop playback |
| `:StrudelPause` | Pause playback |
| `:StrudelHush` | Immediately silence all sounds |
| `:StrudelEval` | Evaluate current buffer/selection |
| `:StrudelStatus` | Show server status |
| `:StrudelPianoroll` | Toggle piano roll visualization |
| `:StrudelSamples` | Browse available samples |

## Troubleshooting

### Server won't start

Check the error with:
```vim
:messages
```

### "libasound.so.2: cannot open shared object file"

The wrapper script isn't working. Verify it exists and is executable:
```bash
ls -la ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
```

If missing, recreate it (see step 2 above).

### Server exits with code 1

Run the server manually to see the error:
```bash
cd ~/.local/share/nvim/lazy/nvim-strudel/server
./strudel-server-wrapper.sh
```

### No sound output

- Verify PipeWire is running: `pw-cli info 0`
- Check server logs in `:messages`
- Ensure audio device isn't muted

### "Server not found"

The server hasn't been built. Run the build commands (see step 3 above).

### "cmd is not executable" or "invalid value for argument"

The wrapper script is missing or not executable:

```bash
# Check if wrapper exists
ls -lh ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh

# If missing, create it (see step 2 above)
# If exists but not executable:
chmod +x ~/.local/share/nvim/lazy/nvim-strudel/server/strudel-server-wrapper.sh
```

## Using SuperCollider/SuperDirt (Optional)

For better audio quality and lower CPU usage:

1. Install SuperCollider on NixOS:
   ```nix
   environment.systemPackages = with pkgs; [
     supercollider
   ];
   ```

   Note: sc3-plugins is not available in nixpkgs. SuperCollider will work with its built-in plugins. For additional plugins, see the section below.

2. Install SuperDirt (SuperCollider will auto-install this when needed, or manually):
   ```bash
   # Start SuperCollider IDE
   scide

   # In the SuperCollider IDE, run:
   Quarks.install("SuperDirt");
   ```

3. Update your nvim-strudel config:
   ```lua
   require('strudel').setup({
     audio = {
       output = 'osc',
       osc_host = '127.0.0.1',
       osc_port = 57120,
       auto_superdirt = true,
     },
     -- rest of config...
   })
   ```

## Installing SuperCollider Plugins (sc3-plugins)

sc3-plugins provides additional UGens (unit generators) for SuperCollider. Here's how to install them on NixOS:

### Method 1: Build from Source (Recommended)

```bash
# Enter a nix-shell with build dependencies
nix-shell -p git cmake gcc supercollider fftw libsndfile pkg-config

# Clone sc3-plugins repository
cd ~/Documents  # or wherever you want to build
git clone --recursive https://github.com/supercollider/sc3-plugins.git
cd sc3-plugins

# Create build directory
mkdir build && cd build

# Configure with cmake (pointing to SuperCollider installation)
cmake -DCMAKE_BUILD_TYPE=Release \
      -DSC_PATH=/nix/store/$(ls /nix/store | grep supercollider | head -1) \
      -DCMAKE_INSTALL_PREFIX=$HOME/.local/share/SuperCollider/Extensions \
      ..

# Build (this may take a while)
make -j$(nproc)

# Install
make install
```

### Method 2: Download Pre-built Binaries

```bash
# Download the latest release from GitHub
cd ~/Downloads
wget https://github.com/supercollider/sc3-plugins/releases/download/Version-3.13.0/sc3-plugins-3.13.0-Linux-x86_64.tar.gz

# Extract to SuperCollider extensions directory
mkdir -p ~/.local/share/SuperCollider/Extensions
tar -xzf sc3-plugins-3.13.0-Linux-x86_64.tar.gz -C ~/.local/share/SuperCollider/Extensions
```

### Verify Installation

Start SuperCollider and run:
```supercollider
// Check if sc3-plugins are loaded
ServerTree.tree;

// Test a sc3-plugin UGen (should not error)
{ PitchShift.ar(SinOsc.ar(440), 0.1, 2) }.play;
```

If it plays without errors, sc3-plugins are installed correctly!

### Common sc3-plugins UGens

- **PitchShift**: Real-time pitch shifting
- **GVerb**: Reverb
- **Greyhole**: Reverb effect
- **JPverb**: Algorithmic reverb
- **MembraneCircle**, **MembraneHexagon**: Physical modeling

## Why NixOS Needs Special Setup

NixOS doesn't have system-wide libraries in standard paths. The `midi` and `node-web-audio-api` packages require:

- **Build time**: gcc, make, python3, alsa-lib headers
- **Runtime**: libasound.so.2 (ALSA library)

The wrapper script sets `LD_LIBRARY_PATH` to include the Nix store paths for these libraries.

## Resources

- [nvim-strudel GitHub](https://github.com/Goshujinsama/nvim-strudel)
- [Strudel Documentation](https://strudel.cc/)
- [TidalCycles Tutorial](https://tidalcycles.org/docs/) (similar pattern syntax)

## Notes

- The wrapper script persists across plugin updates (not tracked by git)
- Server build must be re-run after each plugin update
- The `server.cmd` function in config ensures the wrapper is always used
