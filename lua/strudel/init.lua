---@mod strudel nvim-strudel - Live coding music in Neovim
---@brief [[
---nvim-strudel brings the Strudel live coding music environment to Neovim.
---It provides real-time visualization of active pattern elements and full
---playback control.
---@brief ]]

local M = {}

---@type boolean
local initialized = false

---Get the server command based on configuration and available options
---@return string[]|nil
local function get_server_cmd()
  local config = require('strudel.config').get()
  local utils = require('strudel.utils')

  -- 1. User override
  if config.server.cmd then
    return config.server.cmd
  end

  -- 2. Plugin directory (built via lazy.nvim build step)
  local plugin_root = utils.get_plugin_root()
  local server_path = plugin_root .. '/server/dist/index.js'
  if vim.fn.filereadable(server_path) == 1 then
    return { 'node', server_path }
  end

  return nil
end

---Setup the Strudel plugin
---@param opts? table User configuration options
function M.setup(opts)
  if initialized then
    return
  end

  -- Setup configuration
  local config = require('strudel.config')
  config.setup(opts)

  -- Setup highlight groups
  require('strudel.highlights').setup()

  -- Register commands
  require('strudel.commands').setup()

  -- Setup visualizer
  require('strudel.visualizer').setup()

  -- Setup LSP
  require('strudel.lsp').setup()

  -- Store server command for later use
  M._server_cmd = get_server_cmd

  initialized = true

  require('strudel.utils').debug('nvim-strudel initialized')
end

---Check if the plugin is initialized
---@return boolean
function M.is_initialized()
  return initialized
end

---Get the client module
---@return table
function M.client()
  return require('strudel.client')
end

---Get the visualizer module
---@return table
function M.visualizer()
  return require('strudel.visualizer')
end

---Get the LSP module
---@return table
function M.lsp()
  return require('strudel.lsp')
end

return M
