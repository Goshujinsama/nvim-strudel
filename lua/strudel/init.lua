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
    local cmd = { 'node', server_path }

    -- Add audio output configuration
    if config.audio then
      if config.audio.output == 'osc' then
        table.insert(cmd, '--osc')
        if config.audio.osc_host then
          table.insert(cmd, '--osc-host')
          table.insert(cmd, config.audio.osc_host)
        end
        if config.audio.osc_port then
          table.insert(cmd, '--osc-port')
          table.insert(cmd, tostring(config.audio.osc_port))
        end
        -- auto_superdirt defaults to true, only skip if explicitly false
        if config.audio.auto_superdirt ~= false then
          table.insert(cmd, '--auto-superdirt')
        end
      end
    end

    -- Add logging configuration
    if config.log and config.log.enabled then
      local log_dir = config.log.path and vim.fn.fnamemodify(config.log.path, ':h') or vim.fn.stdpath('state')
      local server_log_path = log_dir .. '/strudel-server.log'
      table.insert(cmd, '--log')
      table.insert(cmd, server_log_path)
      if config.log.level then
        table.insert(cmd, '--log-level')
        table.insert(cmd, config.log.level)
      end
    end

    return cmd
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

  -- Initialize pianoroll (registers callbacks for auto-show behavior)
  require('strudel.pianoroll').init()

  -- Register error handler to show server errors
  local client = require('strudel.client')
  local utils = require('strudel.utils')
  client.on('error', function(msg)
    utils.error('Server error: ' .. (msg.message or 'Unknown error'))
  end)

  -- Store server command for later use
  M._server_cmd = get_server_cmd

  -- Setup cleanup on Neovim exit
  -- Just disconnect - the server will detect "all clients disconnected" and shutdown itself
  -- This avoids blocking Neovim exit while waiting for JACK/SuperDirt cleanup
  local augroup = vim.api.nvim_create_augroup('StrudelCleanup', { clear = true })
  vim.api.nvim_create_autocmd('VimLeavePre', {
    group = augroup,
    callback = function()
      local client = require('strudel.client')
      local utils = require('strudel.utils')
      
      -- Close log file
      utils.close_log()
      
      -- Disconnect TCP client - this triggers server's "all clients disconnected" handler
      if client.is_connected() then
        utils.debug('Disconnecting client on Neovim exit')
        client.disconnect()
      end
      
      -- Clear the job reference without killing - server will shutdown on its own
      -- This prevents Neovim from waiting for the process
      utils._server_job = nil
    end,
  })

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
