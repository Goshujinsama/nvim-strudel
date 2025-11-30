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

---@class StrudelKeymapsConfig
---@field enabled boolean
---@field eval string Keymap to evaluate buffer/selection
---@field play string Keymap to start playback
---@field stop string Keymap to stop playback
---@field pause string Keymap to pause playback
---@field hush string Keymap to silence all (stop + clear)

---@class StrudelLspConfig
---@field enabled boolean
---@field cmd? string[] Custom LSP command

---@class StrudelConfig
---@field server StrudelServerConfig
---@field highlight StrudelHighlightConfig
---@field conceal StrudelConcealConfig
---@field keymaps StrudelKeymapsConfig
---@field lsp StrudelLspConfig
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
  keymaps = {
    enabled = false,          -- Disabled by default, users opt-in
    eval = '<C-CR>',          -- Ctrl+Enter to evaluate (like web UI)
    play = '<leader>sp',      -- Play/resume
    stop = '<leader>ss',      -- Stop
    pause = '<leader>sx',     -- Pause
    hush = '<leader>sh',      -- Hush (silence all)
  },
  lsp = {
    enabled = true,           -- LSP for mini-notation completions/diagnostics
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
