local utils = require('strudel.utils')
local config = require('strudel.config')

local M = {}

---Setup keymaps for a buffer
---@param bufnr number
local function setup_buffer_keymaps(bufnr)
  local cfg = config.get()
  if not cfg.keymaps.enabled then
    return
  end

  local opts = { buffer = bufnr, silent = true }

  -- Eval: Ctrl+Enter (works in normal and visual mode)
  if cfg.keymaps.eval and cfg.keymaps.eval ~= '' then
    vim.keymap.set('n', cfg.keymaps.eval, '<cmd>StrudelEval<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Evaluate buffer' }))
    vim.keymap.set('v', cfg.keymaps.eval, ':StrudelEval<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Evaluate selection' }))
    vim.keymap.set('i', cfg.keymaps.eval, '<cmd>StrudelEval<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Evaluate buffer' }))
  end

  -- Play
  if cfg.keymaps.play and cfg.keymaps.play ~= '' then
    vim.keymap.set('n', cfg.keymaps.play, '<cmd>StrudelPlay<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Play' }))
  end

  -- Stop
  if cfg.keymaps.stop and cfg.keymaps.stop ~= '' then
    vim.keymap.set('n', cfg.keymaps.stop, '<cmd>StrudelStop<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Stop' }))
  end

  -- Pause
  if cfg.keymaps.pause and cfg.keymaps.pause ~= '' then
    vim.keymap.set('n', cfg.keymaps.pause, '<cmd>StrudelPause<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Pause' }))
  end

  -- Hush (silence all)
  if cfg.keymaps.hush and cfg.keymaps.hush ~= '' then
    vim.keymap.set('n', cfg.keymaps.hush, '<cmd>StrudelHush<cr>', vim.tbl_extend('force', opts, { desc = 'Strudel: Hush (silence)' }))
  end

  utils.debug('Keymaps set for buffer ' .. bufnr)
end

---Setup autocmds for filetype-based keymaps
local function setup_filetype_autocmds()
  local cfg = config.get()
  if not cfg.keymaps.enabled then
    return
  end

  local group = vim.api.nvim_create_augroup('StrudelKeymaps', { clear = true })

  vim.api.nvim_create_autocmd('FileType', {
    group = group,
    pattern = cfg.filetypes,
    callback = function(args)
      setup_buffer_keymaps(args.buf)
    end,
    desc = 'Setup Strudel keymaps for buffer',
  })

  -- Also setup for any existing buffers with matching filetypes
  for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      local ft = vim.bo[bufnr].filetype
      for _, pattern in ipairs(cfg.filetypes) do
        if ft == pattern then
          setup_buffer_keymaps(bufnr)
          break
        end
      end
    end
  end
end

---Register all user commands
function M.setup()
  local client = require('strudel.client')
  local picker = require('strudel.picker')

  -- Track which buffers have been evaluated
  local evaluated_buffers = {}

  -- Helper to ensure connected, calls callback when ready
  -- Returns true if already connected, false if connecting async
  local function ensure_connected(callback)
    if client.is_connected() then
      if callback then callback() end
      return true
    end

    local cfg = config.get()

    -- Auto-start server if configured
    if cfg.server.auto_start and not utils.is_server_running() then
      local strudel = require('strudel')
      local server_cmd = strudel._server_cmd and strudel._server_cmd()

      if server_cmd then
        utils.log('Starting server...')
        utils.start_server(server_cmd, function()
          -- Connect after server starts
          vim.defer_fn(function()
            client.connect()
            -- Wait a bit for connection to establish, then callback
            if callback then
              vim.defer_fn(callback, 200)
            end
          end, 500)
        end)
        return false
      else
        utils.error('Server not found. Run: cd server && npm install && npm run build')
        return false
      end
    end

    -- Server running but not connected - just connect
    utils.log('Connecting...')
    client.connect()
    if callback then
      vim.defer_fn(callback, 200)
    end
    return false
  end

  -- Helper to eval current buffer
  local function eval_buffer(bufnr)
    bufnr = bufnr or vim.api.nvim_get_current_buf()
    local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
    local code = table.concat(lines, '\n')
    client.eval(code, bufnr)
    evaluated_buffers[bufnr] = true
    return true
  end

  -- :StrudelPlay - Start/resume playback (auto-connects and auto-evals if needed)
  vim.api.nvim_create_user_command('StrudelPlay', function()
    local function do_play()
      local bufnr = vim.api.nvim_get_current_buf()
      if not evaluated_buffers[bufnr] then
        utils.log('Evaluating buffer...')
        eval_buffer(bufnr)
        -- Small delay to let eval complete before play
        vim.defer_fn(function()
          client.play()
        end, 100)
      else
        client.play()
      end
    end

    ensure_connected(do_play)
  end, {
    desc = 'Start/resume Strudel playback',
  })

  -- :StrudelPause - Pause playback
  vim.api.nvim_create_user_command('StrudelPause', function()
    if not client.is_connected() then
      utils.warn('Not connected')
      return
    end
    client.pause()
  end, {
    desc = 'Pause Strudel playback',
  })

  -- :StrudelStop - Stop and reset
  vim.api.nvim_create_user_command('StrudelStop', function()
    if not client.is_connected() then
      utils.warn('Not connected')
      return
    end
    client.stop()
  end, {
    desc = 'Stop Strudel playback',
  })

  -- :StrudelEval - Evaluate current buffer or selection (auto-connects if needed)
  vim.api.nvim_create_user_command('StrudelEval', function(opts)
    local function do_eval()
      local bufnr = vim.api.nvim_get_current_buf()
      local code

      if opts.range > 0 then
        -- Get selected lines
        local lines = vim.api.nvim_buf_get_lines(bufnr, opts.line1 - 1, opts.line2, false)
        code = table.concat(lines, '\n')
      else
        -- Get entire buffer
        local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
        code = table.concat(lines, '\n')
      end

      client.eval(code, bufnr)
      evaluated_buffers[bufnr] = true
      utils.log('Evaluating...')
    end

    ensure_connected(do_eval)
  end, {
    range = true,
    desc = 'Evaluate Strudel code',
  })

  -- :StrudelConnect - Connect to server
  vim.api.nvim_create_user_command('StrudelConnect', function()
    ensure_connected(function()
      utils.log('Connected')
    end)
  end, {
    desc = 'Connect to Strudel server',
  })

  -- :StrudelDisconnect - Disconnect from server (stops server if we started it)
  vim.api.nvim_create_user_command('StrudelDisconnect', function()
    client.disconnect()
    -- If we auto-started the server, stop it too
    if utils.is_server_running() then
      utils.stop_server()
    end
  end, {
    desc = 'Disconnect from Strudel server',
  })

  -- :StrudelStatus - Show connection/playback status
  vim.api.nvim_create_user_command('StrudelStatus', function()
    local connected = client.is_connected() and 'Connected' or 'Disconnected'
    local server = utils.is_server_running() and 'Running' or 'Not running'
    utils.log('Connection: ' .. connected .. ' | Server: ' .. server)
  end, {
    desc = 'Show Strudel status',
  })

  -- :StrudelSamples - Browse available samples
  vim.api.nvim_create_user_command('StrudelSamples', function()
    picker.samples()
  end, {
    desc = 'Browse Strudel samples',
  })

  -- :StrudelSounds - Browse synth sounds
  vim.api.nvim_create_user_command('StrudelSounds', function()
    picker.sounds()
  end, {
    desc = 'Browse Strudel synth sounds',
  })

  -- :StrudelBanks - Browse sample banks
  vim.api.nvim_create_user_command('StrudelBanks', function()
    picker.banks()
  end, {
    desc = 'Browse Strudel sample banks',
  })

  -- :StrudelPatterns - Browse saved patterns
  vim.api.nvim_create_user_command('StrudelPatterns', function()
    picker.patterns()
  end, {
    desc = 'Browse saved Strudel patterns',
  })

  -- :StrudelHush - Stop playback and silence all
  vim.api.nvim_create_user_command('StrudelHush', function()
    if not client.is_connected() then
      utils.warn('Not connected')
      return
    end
    client.hush()
  end, {
    desc = 'Stop and silence all Strudel patterns',
  })

  -- Setup filetype-based keymaps
  setup_filetype_autocmds()

  utils.debug('Commands registered')
end

return M
