---@class StrudelServerConfig
---@field host string
---@field port number
---@field auto_start boolean
---@field cmd? string[]

---@class StrudelHighlightConfig
---@field active string
---@field pending string
---@field muted string

---@class StrudelConcealConfig
---@field enabled boolean
---@field char string

---@class StrudelLspConfig
---@field enabled boolean
---@field cmd? string[] Custom LSP command

---@class StrudelAudioConfig
---@field output 'webaudio'|'osc' Audio output backend
---@field osc_host? string SuperDirt OSC host (default: 127.0.0.1)
---@field osc_port? number SuperDirt OSC port (default: 57120)
---@field auto_superdirt? boolean Auto-start SuperDirt if sclang available

---@class StrudelPianorollConfig
---@field height number Height of the pianoroll window
---@field display_cycles number Number of cycles to show
---@field mode 'auto'|'tracks'|'notes' Visualization mode

---@class StrudelConfig
---@field server StrudelServerConfig
---@field highlight StrudelHighlightConfig
---@field conceal StrudelConcealConfig
---@field lsp StrudelLspConfig
---@field audio StrudelAudioConfig
---@field pianoroll StrudelPianorollConfig
---@field picker 'auto'|'snacks'|'telescope'
---@field auto_eval boolean
---@field filetypes string[]

local M = {}

---@type StrudelConfig
M.defaults = {
  server = {
    host = '127.0.0.1',
    port = 37812,
    auto_start = true,
  },
  highlight = {
    active = 'StrudelActive',
    pending = 'StrudelPending',
    muted = 'StrudelMuted',
  },
  conceal = {
    enabled = true,
    char = '▶',
  },
  lsp = {
    enabled = true,           -- LSP for mini-notation completions/diagnostics
  },
  audio = {
    output = 'webaudio',      -- 'webaudio' (Node.js) or 'osc' (SuperDirt/SuperCollider)
    osc_host = '127.0.0.1',   -- SuperDirt OSC host
    osc_port = 57120,         -- SuperDirt OSC port
    auto_superdirt = true,    -- Auto-start SuperDirt if sclang available
  },
  pianoroll = {
    height = 10,              -- Height of pianoroll window
    display_cycles = 2,       -- Number of cycles to show
    mode = 'auto',            -- 'auto', 'tracks', or 'notes' (braille)
  },
  picker = 'auto',
  auto_eval = false,
  filetypes = { 'strudel', 'javascript', 'typescript' },
}

---@type StrudelConfig
M.options = {}

---@param opts? table
---@return StrudelConfig
function M.setup(opts)
  M.options = vim.tbl_deep_extend('force', {}, M.defaults, opts or {})
  return M.options
end

---@return StrudelConfig
function M.get()
  return M.options
end

return M
