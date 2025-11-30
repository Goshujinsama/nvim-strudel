# AGENTS.md - strudel.nvim

## Project Overview

**strudel.nvim** is a Neovim plugin that brings the [Strudel](https://strudel.cc/) live coding music environment to Neovim. It provides real-time visualization of active pattern elements using highlight groups and conceal characters, mirroring the web UI's visual feedback during playback.

### Goals
- Live code music patterns directly in Neovim
- Real-time visual feedback showing which code elements are currently producing sound
- Full playback control (start, pause, stop)
- Seamless integration with Neovim's editing experience

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Neovim                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    strudel.nvim (Lua)                     │  │
│  │  - Buffer management                                      │  │
│  │  - Highlight groups for active elements                   │  │
│  │  - Conceal characters for visualization                   │  │
│  │  - User commands (:StrudelPlay, :StrudelPause, :StrudelStop)│
│  │  - RPC/WebSocket client                                   │  │
│  └──────────────────────────┬────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │ WebSocket / JSON-RPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    strudel-server (Node.js)                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  - @strudel/core pattern evaluation                       │  │
│  │  - @strudel/webaudio for audio synthesis                  │  │
│  │  - Pattern event tracking (which elements are active)     │  │
│  │  - WebSocket server for Neovim communication              │  │
│  │  - Source map tracking (code position → sound events)     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
strudel.nvim/
├── AGENTS.md                 # This file
├── README.md                 # User documentation
├── LICENSE                   # AGPL-3.0 (matching Strudel)
│
├── lua/
│   └── strudel/
│       ├── init.lua          # Plugin entry point, setup()
│       ├── config.lua        # Configuration defaults and validation
│       ├── client.lua        # WebSocket/RPC client to backend
│       ├── commands.lua      # User commands registration
│       ├── highlights.lua    # Highlight group definitions
│       ├── visualizer.lua    # Real-time highlight/conceal updates
│       ├── picker.lua        # Picker abstraction (Snacks/Telescope)
│       └── utils.lua         # Shared utilities
│
├── plugin/
│   └── strudel.vim           # Auto-load plugin registration
│
├── server/
│   ├── package.json          # Node.js dependencies
│   ├── tsconfig.json         # TypeScript configuration
│   └── src/
│       ├── index.ts          # Server entry point
│       ├── strudel-engine.ts # Strudel pattern evaluation wrapper
│       ├── audio.ts          # Audio output management
│       ├── websocket.ts      # WebSocket server for Neovim
│       ├── source-map.ts     # Track code positions to events
│       └── types.ts          # Shared TypeScript types
│
├── samples/                  # Example Strudel patterns
│   └── demo.strudel
│
└── tests/
    ├── lua/                  # Lua plugin tests (plenary.nvim)
    └── server/               # Node.js server tests (vitest)
```

## Key Components

### Neovim Plugin (Lua)

#### `lua/strudel/init.lua`
- Main entry point with `setup(opts)` function
- Lazy-loads other modules on demand
- Manages plugin lifecycle

#### `lua/strudel/client.lua`
- WebSocket client using `vim.loop` (libuv bindings)
- Handles connection, reconnection, and message parsing
- Sends code updates to server
- Receives active element events from server

#### `lua/strudel/visualizer.lua`
- Creates and manages extmarks for highlighting
- Uses `nvim_buf_set_extmark` with `hl_group` for active elements
- Optionally uses conceal to show playhead/activity indicators
- Updates at ~60fps or on server events

#### `lua/strudel/highlights.lua`
Defines highlight groups:
- `StrudelActive` - Currently sounding element
- `StrudelPending` - Element about to sound
- `StrudelMuted` - Muted/inactive element
- `StrudelPlayhead` - Current cycle position indicator

#### `lua/strudel/commands.lua`
User commands:
- `:StrudelPlay` - Start/resume playback
- `:StrudelPause` - Pause playback
- `:StrudelStop` - Stop and reset
- `:StrudelEval` - Evaluate current buffer/selection
- `:StrudelConnect` - Connect to server
- `:StrudelStatus` - Show connection/playback status
- `:StrudelSamples` - Browse available samples via picker
- `:StrudelPatterns` - Browse saved patterns via picker

#### `lua/strudel/picker.lua`
Picker abstraction supporting multiple backends:
- **Snacks.nvim** (preferred) - Modern, fast picker
- **Telescope.nvim** - Fallback for users without Snacks
- Auto-detects available picker and uses appropriate backend
- Provides unified API for browsing samples, patterns, and sounds

### Backend Server (Node.js/TypeScript)

#### `server/src/strudel-engine.ts`
- Uses `@strudel/core` for pattern parsing and evaluation
- Uses `@strudel/webaudio` or `@strudel/superdough` for audio
- Tracks cycle position and active haps (events)

#### `server/src/source-map.ts`
- Maps source code positions (line, column) to pattern elements
- When a hap triggers, identifies which code produced it
- Critical for accurate visualization in the editor

#### `server/src/websocket.ts`
- WebSocket server (default port 37812)
- Protocol messages:
  - `eval` - Evaluate new code
  - `play` / `pause` / `stop` - Playback control
  - `active` - Server → client, list of active source positions
  - `cycle` - Current cycle number/position
  - `error` - Evaluation or runtime errors

## Communication Protocol

JSON-RPC style messages over WebSocket:

```typescript
// Client → Server
interface EvalMessage {
  type: 'eval';
  code: string;
  bufnr?: number;
}

interface ControlMessage {
  type: 'play' | 'pause' | 'stop';
}

// Server → Client
interface ActiveMessage {
  type: 'active';
  elements: Array<{
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    value?: string;  // The actual value being played
  }>;
  cycle: number;
}

interface ErrorMessage {
  type: 'error';
  message: string;
  line?: number;
  column?: number;
}

interface StatusMessage {
  type: 'status';
  playing: boolean;
  cycle: number;
  cps: number;  // cycles per second
}
```

## Strudel Integration Details

### Key Strudel Packages
- `@strudel/core` - Pattern language and evaluation
- `@strudel/webaudio` - Web Audio API synthesis
- `@strudel/mini` - Mini notation parser
- `@strudel/tonal` - Scales, chords, note names

### Pattern Evaluation
Strudel patterns are functions of time. The engine:
1. Parses the code (JavaScript with Strudel DSL)
2. Creates a Pattern object
3. Queries the pattern for events ("haps") in time windows
4. Each hap has a source location if properly tracked

### Source Location Tracking
The key challenge is mapping audio events back to source code. Approaches:
1. **AST annotation**: Parse code, annotate nodes with positions
2. **Runtime tracking**: Wrap pattern functions to record call sites
3. **Hybrid**: Use both for maximum accuracy

## Configuration Options

```lua
require('strudel').setup({
  -- Server connection
  server = {
    host = 'localhost',
    port = 37812,
    auto_start = true,  -- Start server if not running
  },
  
  -- Visualization
  highlight = {
    active = 'StrudelActive',
    pending = 'StrudelPending', 
    muted = 'StrudelMuted',
  },
  
  -- Conceal characters for playhead
  conceal = {
    enabled = true,
    char = '▶',
  },
  
  -- Picker backend: 'auto', 'snacks', or 'telescope'
  -- 'auto' prefers Snacks if available, falls back to Telescope
  picker = 'auto',
  
  -- Auto-evaluate on save
  auto_eval = false,
  
  -- File types to activate for
  filetypes = { 'strudel', 'javascript', 'typescript' },
})
```

## Development Guidelines

### Lua Code Style
- Use `vim.validate` for input validation
- Prefer `vim.api` over legacy Vim script calls
- Use `vim.schedule` for async operations
- Follow Neovim Lua style (snake_case)

### TypeScript Code Style
- Strict TypeScript with no implicit any
- Use ESM modules
- Prefer async/await over raw promises
- Document public APIs with JSDoc

### Testing
- Lua tests: Use plenary.nvim test harness
- TypeScript tests: Use vitest
- Integration tests: Spawn Neovim headless with embedded test patterns

### Error Handling
- Never crash Neovim on errors
- Show user-friendly error messages via `vim.notify`
- Log detailed errors for debugging
- Gracefully handle server disconnection

## Dependencies

### Runtime
- Neovim >= 0.9.0 (for modern extmark features)
- Node.js >= 18.0 (for Strudel packages)
- Audio output device

### Lua (Plugin)
- No external Lua dependencies (uses Neovim built-ins)

### Node.js (Server)
```json
{
  "dependencies": {
    "@strudel/core": "^1.0.0",
    "@strudel/mini": "^1.0.0",
    "@strudel/webaudio": "^1.0.0",
    "@strudel/tonal": "^1.0.0",
    "ws": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0",
    "@types/ws": "^8.0.0"
  }
}
```

## Future Enhancements

- [ ] Treesitter grammar for Strudel mini-notation
- [ ] Multiple buffer support (layered patterns)
- [ ] OSC output for external synths
- [ ] Recording/export functionality
- [ ] Pattern history/undo visualization
- [ ] Collaborative live coding (shared sessions)
- [ ] Integration with SuperCollider/Tidal for advanced synthesis

## References

- [Strudel Documentation](https://strudel.cc/learn/getting-started/)
- [Strudel Source Code](https://codeberg.org/uzu/strudel)
- [TidalCycles](https://tidalcycles.org/)
- [Neovim Lua Guide](https://neovim.io/doc/user/lua-guide.html)
- [Neovim API Reference](https://neovim.io/doc/user/api.html)

## License

AGPL-3.0 - Must match Strudel's license as this is a derivative work.
