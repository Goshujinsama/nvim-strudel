---@mod strudel.lsp LSP client for Strudel mini-notation
---@brief [[
---Configures and starts the Strudel LSP server for mini-notation support.
---Provides completions, hover, and diagnostics for mini-notation strings.
---@brief ]]

local M = {}

local utils = require('strudel.utils')
local config = require('strudel.config')

---@type number|nil
local client_id = nil

---Get the LSP server command
---@return string[]|nil
local function get_lsp_cmd()
  local cfg = config.get()

  -- 1. User override
  if cfg.lsp and cfg.lsp.cmd then
    return cfg.lsp.cmd
  end

  -- 2. Plugin directory (server built via lazy.nvim build step)
  local plugin_root = utils.get_plugin_root()
  local lsp_path = plugin_root .. '/server/dist/lsp.js'
  if vim.fn.filereadable(lsp_path) == 1 then
    return { 'node', lsp_path }
  end

  return nil
end

---Start the LSP client for a buffer
---@param bufnr? number Buffer number (defaults to current)
function M.start(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()

  local cfg = config.get()
  if cfg.lsp and cfg.lsp.enabled == false then
    return
  end

  local cmd = get_lsp_cmd()
  if not cmd then
    utils.debug('LSP server not found')
    return
  end

  -- Check if already attached
  local clients = vim.lsp.get_clients({ bufnr = bufnr, name = 'strudel' })
  if #clients > 0 then
    return
  end

  client_id = vim.lsp.start({
    name = 'strudel',
    cmd = cmd,
    root_dir = vim.fn.getcwd(),
    filetypes = cfg.filetypes,
    settings = {},
    capabilities = vim.lsp.protocol.make_client_capabilities(),
    on_attach = function(_, buf)
      utils.debug('Strudel LSP attached to buffer ' .. buf)
    end,
  }, {
    bufnr = bufnr,
  })

  if client_id then
    utils.debug('Strudel LSP started (client ' .. client_id .. ')')
  end
end

---Stop the LSP client
function M.stop()
  if client_id then
    vim.lsp.stop_client(client_id)
    client_id = nil
    utils.debug('Strudel LSP stopped')
  end
end

---Check if LSP is running
---@return boolean
function M.is_running()
  if not client_id then
    return false
  end
  local client = vim.lsp.get_client_by_id(client_id)
  return client ~= nil
end

---Setup autocmds to start LSP for matching filetypes
function M.setup()
  local cfg = config.get()

  -- Don't setup if LSP is disabled
  if cfg.lsp and cfg.lsp.enabled == false then
    return
  end

  local group = vim.api.nvim_create_augroup('StrudelLsp', { clear = true })

  vim.api.nvim_create_autocmd('FileType', {
    group = group,
    pattern = cfg.filetypes,
    callback = function(args)
      M.start(args.buf)
    end,
    desc = 'Start Strudel LSP for buffer',
  })

  -- Start for any existing buffers
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_is_loaded(bufnr) then
      local ft = vim.bo[bufnr].filetype
      for _, pattern in ipairs(cfg.filetypes) do
        if ft == pattern then
          M.start(bufnr)
          break
        end
      end
    end
  end

  utils.debug('LSP setup complete')
end

return M
