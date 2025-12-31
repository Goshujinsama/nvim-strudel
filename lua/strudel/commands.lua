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
  
  -- Helper to check if any evaluated buffer still exists and is valid
  local function has_valid_evaluated_buffer()
    for bufnr, _ in pairs(evaluated_buffers) do
      if vim.api.nvim_buf_is_valid(bufnr) then
        return true
      end
    end
    return false
  end
  
  -- Stop when buffer is wiped (fully destroyed, not just unloaded)
  -- Note: We only use BufWipeout, not BufDelete, because BufDelete fires
  -- when buffers are unloaded (e.g., by oil.nvim) but the buffer may still exist
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
  
  -- Stop when window is closed and no evaluated buffers remain valid
  vim.api.nvim_create_autocmd('WinClosed', {
    group = wipeout_group,
    callback = function(args)
      -- Defer to let the window actually close first
      vim.schedule(function()
        if not has_valid_evaluated_buffer() and client.is_connected() then
          client.stop()
          utils.debug('No valid evaluated buffers remain, stopping playback')
        end
      end)
    end,
    desc = 'Stop Strudel playback when no evaluated buffers remain',
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

  -- Music Theory Commands

  -- :StrudelTheory - Open chord suggestions popup
  vim.api.nvim_create_user_command('StrudelTheory', function(opts)
    local cfg = config.get()
    if cfg.theory and cfg.theory.enabled == false then
      utils.warn('Music theory features are disabled. Set theory.enabled = true in config.')
      return
    end

    local theory_ui = require('strudel.theory_ui')
    local scope = opts.args ~= '' and opts.args or cfg.theory.default_scope or 'line'
    theory_ui.show({ scope = scope })
  end, {
    nargs = '?',
    complete = function()
      return { 'line', 'selection', 'buffer' }
    end,
    desc = 'Show chord suggestions based on pattern analysis',
  })

  -- :StrudelAnalyze - Show key/scale analysis
  vim.api.nvim_create_user_command('StrudelAnalyze', function(opts)
    local cfg = config.get()
    if cfg.theory and cfg.theory.enabled == false then
      utils.warn('Music theory features are disabled. Set theory.enabled = true in config.')
      return
    end

    local analyzer = require('strudel.theory.analyzer')
    local scope = opts.args ~= '' and opts.args or 'buffer'

    local result
    if scope == 'line' then
      result = analyzer.analyze_line(vim.api.nvim_get_current_line())
    elseif scope == 'selection' then
      local start_line = vim.fn.line("'<")
      local end_line = vim.fn.line("'>")
      if start_line > 0 and end_line > 0 then
        result = analyzer.analyze_selection(start_line, end_line)
      else
        result = analyzer.analyze_line(vim.api.nvim_get_current_line())
      end
    else
      result = analyzer.analyze_buffer()
    end

    if result then
      local msg = analyzer.format_result(result)
      utils.log('Detected: ' .. msg)

      -- Show alternatives if confidence is low
      if result.confidence < 0.7 and #result.all_matches > 1 then
        local alts = {}
        for i = 2, math.min(4, #result.all_matches) do
          local m = result.all_matches[i]
          local scale_name = m.scale_info and m.scale_info.name or m.scale
          table.insert(alts, string.format('%s %s (%d%%)', m.root, scale_name, math.floor(m.confidence * 100)))
        end
        if #alts > 0 then
          utils.log('Alternatives: ' .. table.concat(alts, ', '))
        end
      end
    else
      utils.warn('Could not detect key/scale')
    end
  end, {
    nargs = '?',
    complete = function()
      return { 'line', 'selection', 'buffer' }
    end,
    desc = 'Analyze patterns to detect key/scale',
  })

  -- :StrudelScales - Browse and insert scales
  vim.api.nvim_create_user_command('StrudelScales', function(opts)
    local cfg = config.get()
    if cfg.theory and cfg.theory.enabled == false then
      utils.warn('Music theory features are disabled. Set theory.enabled = true in config.')
      return
    end

    local scales = require('strudel.theory.scales')
    local root = opts.args ~= '' and opts.args or 'C'

    -- Validate root
    if not scales.note_name_to_pc(root) then
      utils.warn('Invalid root note: ' .. root)
      return
    end

    -- Normalize root
    root = root:sub(1, 1):upper() .. root:sub(2):lower():gsub('s', '#')

    local items = {}
    for name, scale in pairs(scales.SCALES) do
      local notes = scales.get_scale_notes(root, name)
      table.insert(items, {
        name = name,
        display_name = scale.name,
        notes = notes and table.concat(notes, ' ') or '',
        intervals = table.concat(scale.intervals, ' '),
      })
    end

    -- Sort by name
    table.sort(items, function(a, b)
      return a.display_name < b.display_name
    end)

    picker.pick({
      title = 'Scales (' .. root .. ')',
      items = items,
      format_item = function(item)
        return string.format('%-20s %s', item.display_name, item.notes)
      end,
      on_select = function(item)
        -- Insert as n() pattern with scale degrees
        local degrees = item.intervals
        vim.api.nvim_put({ string.format('n("%s")', degrees) }, 'c', true, true)
      end,
    })
  end, {
    nargs = '?',
    desc = 'Browse and insert scales (optionally specify root note)',
  })

  -- :StrudelChords - Browse and insert chord types
  vim.api.nvim_create_user_command('StrudelChords', function(opts)
    local cfg = config.get()
    if cfg.theory and cfg.theory.enabled == false then
      utils.warn('Music theory features are disabled. Set theory.enabled = true in config.')
      return
    end

    local chords = require('strudel.theory.chords')
    local scales = require('strudel.theory.scales')
    local root = opts.args ~= '' and opts.args or 'C'

    -- Validate root
    if not scales.note_name_to_pc(root) then
      utils.warn('Invalid root note: ' .. root)
      return
    end

    -- Normalize root
    root = root:sub(1, 1):upper() .. root:sub(2):lower():gsub('s', '#')

    local items = {}
    for name, chord_type in pairs(chords.CHORD_TYPES) do
      local chord = chords.build_chord(root, name)
      if chord then
        table.insert(items, {
          name = name,
          chord = chord,
          chord_type = chord_type,
          display = root .. chord_type.symbol,
          full_name = chord_type.full_name,
          notes = table.concat(chord.notes, ' '),
        })
      end
    end

    -- Sort by name
    table.sort(items, function(a, b)
      return a.full_name < b.full_name
    end)

    picker.pick({
      title = 'Chord Types (' .. root .. ')',
      items = items,
      format_item = function(item)
        return string.format('%-12s %-20s %s', item.display, item.full_name, item.notes)
      end,
      on_select = function(item)
        -- Insert as chord() pattern
        local strudel = chords.chord_to_strudel(item.chord)
        vim.api.nvim_put({ string.format('chord("%s")', strudel) }, 'c', true, true)
      end,
    })
  end, {
    nargs = '?',
    desc = 'Browse and insert chord types (optionally specify root note)',
  })

  utils.debug('Commands registered')
end

return M
