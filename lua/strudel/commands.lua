local utils = require('strudel.utils')
local config = require('strudel.config')

local M = {}

---Register all user commands
function M.setup()
  local client = require('strudel.client')
  local picker = require('strudel.picker')
  local visualizer = require('strudel.visualizer')

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
    -- Tell visualizer which buffer should receive highlights
    visualizer.set_evaluated_buffer(bufnr)
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
      -- Tell visualizer which buffer should receive highlights
      visualizer.set_evaluated_buffer(bufnr)
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
    local pianoroll = require('strudel.pianoroll')
    local connected = client.is_connected() and 'Connected' or 'Disconnected'
    local server = utils.is_server_running() and 'Running' or 'Not running'
    local piano = pianoroll.is_enabled() and 'Enabled' or 'Disabled'
    utils.log('Connection: ' .. connected .. ' | Server: ' .. server .. ' | Pianoroll: ' .. piano)
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

  -- :StrudelPianoroll - Toggle pianoroll visualization
  vim.api.nvim_create_user_command('StrudelPianoroll', function(opts)
    local pianoroll = require('strudel.pianoroll')
    
    if opts.args and opts.args ~= '' then
      -- Mode argument provided: set mode
      local mode = opts.args
      if mode == 'toggle' then
        pianoroll.toggle()
      elseif mode == 'open' then
        pianoroll.open()
      elseif mode == 'close' then
        pianoroll.close()
      elseif mode == 'smooth' then
        pianoroll.set_smooth(true)
      elseif mode == 'nosmooth' or mode == 'jump' then
        pianoroll.set_smooth(false)
      elseif mode == 'auto' or mode == 'tracks' or mode == 'notes' or mode == 'drums' then
        pianoroll.set_mode(mode)
        utils.log('Pianoroll mode: ' .. mode)
      else
        utils.warn('Unknown mode: ' .. mode .. ' (use: auto, tracks, notes, drums, smooth, nosmooth, toggle, open, close)')
      end
    else
      pianoroll.toggle()
    end
  end, {
    nargs = '?',
    complete = function()
      return { 'auto', 'tracks', 'notes', 'drums', 'smooth', 'nosmooth', 'toggle', 'open', 'close' }
    end,
    desc = 'Toggle Strudel pianoroll or set mode (auto/tracks/notes/drums/smooth/nosmooth)',
  })

  -- Setup handlers to stop playback when strudel buffer is closed
  local wipeout_group = vim.api.nvim_create_augroup('StrudelBufWipeout', { clear = true })
  
  -- Helper to check if any window is showing an evaluated buffer
  local function has_evaluated_buffer_window()
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      local buf = vim.api.nvim_win_get_buf(win)
      if evaluated_buffers[buf] then
        return true
      end
    end
    return false
  end
  
  -- Stop when buffer is wiped
  vim.api.nvim_create_autocmd('BufWipeout', {
    group = wipeout_group,
    callback = function(args)
      if evaluated_buffers[args.buf] then
        evaluated_buffers[args.buf] = nil
        
        -- Check if any evaluated buffers remain
        local has_remaining = false
        for _ in pairs(evaluated_buffers) do
          has_remaining = true
          break
        end
        
        if not has_remaining and client.is_connected() then
          client.stop()
          utils.debug('Last strudel buffer closed, stopping playback')
        end
      end
    end,
    desc = 'Stop Strudel playback when buffer is wiped',
  })
  
  -- Stop when window is closed and no windows with evaluated buffers remain
  vim.api.nvim_create_autocmd('WinClosed', {
    group = wipeout_group,
    callback = function(args)
      -- Defer to let the window actually close first
      vim.schedule(function()
        if not has_evaluated_buffer_window() and client.is_connected() then
          client.stop()
          utils.debug('No strudel windows remain, stopping playback')
        end
      end)
    end,
    desc = 'Stop Strudel playback when no strudel windows remain',
  })

  -- :StrudelLog - Open log file
  vim.api.nvim_create_user_command('StrudelLog', function(opts)
    local log_path = utils.get_log_path()
    if log_path then
      local arg = opts.args or ''
      if arg == 'server' then
        -- Open server log
        local server_log = vim.fn.fnamemodify(log_path, ':h') .. '/strudel-server.log'
        if vim.fn.filereadable(server_log) == 1 then
          vim.cmd('edit ' .. vim.fn.fnameescape(server_log))
        else
          utils.warn('Server log not found: ' .. server_log)
        end
      elseif arg == 'client' or arg == '' then
        -- Open client log (default)
        vim.cmd('edit ' .. vim.fn.fnameescape(log_path))
      elseif arg == 'both' then
        -- Open both in splits
        vim.cmd('edit ' .. vim.fn.fnameescape(log_path))
        local server_log = vim.fn.fnamemodify(log_path, ':h') .. '/strudel-server.log'
        if vim.fn.filereadable(server_log) == 1 then
          vim.cmd('vsplit ' .. vim.fn.fnameescape(server_log))
        end
      else
        utils.warn('Unknown argument: ' .. arg .. ' (use: client, server, both)')
      end
    else
      utils.warn('Logging is not enabled. Set log.enabled = true in config.')
    end
  end, {
    nargs = '?',
    complete = function()
      return { 'client', 'server', 'both' }
    end,
    desc = 'Open Strudel log file (client/server/both)',
  })

  utils.debug('Commands registered')
end

return M
