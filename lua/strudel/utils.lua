local M = {}

-- Log levels for filtering
local LOG_LEVELS = {
  debug = 1,
  info = 2,
  warn = 3,
  error = 4,
}

-- Log file handle (lazy initialized)
local log_file = nil
local log_path = nil

---Get the default log path (XDG state directory)
---@return string
local function get_default_log_path()
  local state_dir = vim.fn.stdpath('state')
  return state_dir .. '/strudel.log'
end

---Initialize log file if logging is enabled
---@return file*|nil
local function get_log_file()
  local config = require('strudel.config').get()
  if not config.log or not config.log.enabled then
    return nil
  end

  -- Already opened
  if log_file then
    return log_file
  end

  -- Determine path
  log_path = config.log.path or get_default_log_path()

  -- Ensure parent directory exists
  local parent = vim.fn.fnamemodify(log_path, ':h')
  if vim.fn.isdirectory(parent) == 0 then
    vim.fn.mkdir(parent, 'p')
  end

  -- Open file in append mode
  local f, err = io.open(log_path, 'a')
  if not f then
    vim.notify('[strudel] Failed to open log file: ' .. (err or 'unknown error'), vim.log.levels.ERROR)
    return nil
  end

  log_file = f

  -- Write session header
  log_file:write('\n--- Strudel session started: ' .. os.date('%Y-%m-%d %H:%M:%S') .. ' ---\n')
  log_file:flush()

  return log_file
end

---Write to log file if enabled
---@param level string Log level name
---@param msg string Message to log
local function write_log(level, msg)
  local f = get_log_file()
  if not f then
    return
  end

  local config = require('strudel.config').get()
  local min_level = config.log and config.log.level or 'debug'

  -- Filter by level
  if LOG_LEVELS[level] < LOG_LEVELS[min_level] then
    return
  end

  local timestamp = os.date('%H:%M:%S')
  local line = string.format('[%s] [%s] %s\n', timestamp, level:upper(), msg)
  f:write(line)
  f:flush()
end

---Close log file (call on exit)
function M.close_log()
  if log_file then
    log_file:write('--- Session ended: ' .. os.date('%Y-%m-%d %H:%M:%S') .. ' ---\n')
    log_file:close()
    log_file = nil
  end
end

---Get the current log file path
---@return string|nil
function M.get_log_path()
  local config = require('strudel.config').get()
  if config.log and config.log.enabled then
    return config.log.path or get_default_log_path()
  end
  return nil
end

---Get the root path of the plugin
---@return string
function M.get_plugin_root()
  -- This file is at: <plugin_root>/lua/strudel/utils.lua
  -- So we need to go up 3 levels: utils.lua -> strudel -> lua -> plugin_root
  local source = debug.getinfo(1, 'S').source:sub(2)
  return vim.fn.fnamemodify(source, ':h:h:h')
end

---Log a message with the strudel prefix
---@param msg string
---@param level? integer
function M.log(msg, level)
  level = level or vim.log.levels.INFO
  vim.notify('[strudel] ' .. msg, level)
  -- Also write to file
  local level_name = 'info'
  if level == vim.log.levels.DEBUG then
    level_name = 'debug'
  elseif level == vim.log.levels.WARN then
    level_name = 'warn'
  elseif level == vim.log.levels.ERROR then
    level_name = 'error'
  end
  write_log(level_name, msg)
end

---Log an error message
---@param msg string
function M.error(msg)
  M.log(msg, vim.log.levels.ERROR)
end

---Log a warning message
---@param msg string
function M.warn(msg)
  M.log(msg, vim.log.levels.WARN)
end

---Log a debug message (only if debug mode is enabled)
---@param msg string
function M.debug(msg)
  -- Always write to log file if enabled
  write_log('debug', msg)
  -- Only show in Neovim if debug mode is on
  if vim.g.strudel_debug then
    M.log('[DEBUG] ' .. msg, vim.log.levels.DEBUG)
  end
end

---Log info message (for file logging without notification)
---@param msg string
function M.info(msg)
  write_log('info', msg)
end

---Check if a module is available
---@param name string
---@return boolean
function M.has_module(name)
  local ok = pcall(require, name)
  return ok
end

---Defer execution to the next event loop iteration
---@param fn function
function M.defer(fn)
  vim.schedule(fn)
end

---Create a debounced function
---@param fn function
---@param ms number
---@return function
function M.debounce(fn, ms)
  local timer = vim.uv.new_timer()
  return function(...)
    local args = { ... }
    timer:stop()
    timer:start(ms, 0, function()
      timer:stop()
      vim.schedule(function()
        fn(unpack(args))
      end)
    end)
  end
end

---Server process handle
---@type integer|nil
M._server_job = nil

---Start the strudel server process
---@param cmd string[] Command and arguments to run
---@param on_start? function Callback when server starts
---@return boolean success
function M.start_server(cmd, on_start)
  if M._server_job then
    M.debug('Server already running')
    return true
  end

  if not cmd or #cmd == 0 then
    M.error('No server command configured')
    return false
  end

  M.log('Starting server: ' .. table.concat(cmd, ' '))

  local stdout_chunks = {}
  local stderr_chunks = {}
  local started = false

  M._server_job = vim.fn.jobstart(cmd, {
    -- Detach so Neovim doesn't wait for server on exit
    -- Server will shutdown when TCP client disconnects
    detach = true,
    on_stdout = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          table.insert(stdout_chunks, line)
          M.debug('[server] ' .. line)
          -- Detect when server is ready
          if not started and line:match('listening on') then
            started = true
            if on_start then
              vim.schedule(on_start)
            end
          end
        end
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          table.insert(stderr_chunks, line)
          M.debug('[server:err] ' .. line)
        end
      end
    end,
    on_exit = function(_, code)
      M._server_job = nil
      if code ~= 0 then
        M.warn('Server exited with code ' .. code)
      else
        M.debug('Server stopped')
      end
    end,
  })

  if M._server_job <= 0 then
    M.error('Failed to start server')
    M._server_job = nil
    return false
  end

  return true
end

---Stop the strudel server process
---@param signal? string Signal to send ('term' or 'kill', default 'term')
function M.stop_server(signal)
  if M._server_job then
    signal = signal or 'term'
    if signal == 'kill' then
      vim.fn.jobstop(M._server_job)
    else
      -- Send SIGTERM for graceful shutdown
      vim.fn.jobstop(M._server_job)
    end
    M._server_job = nil
    M.log('Server stopped')
  end
end

---Check if the server process is running (either started by us or externally)
---@return boolean
function M.is_server_running()
  -- If we started it, it's running
  if M._server_job ~= nil then
    return true
  end

  -- Check if something is listening on the port
  local config = require('strudel.config').get()
  local port = config.server.port

  -- Try to connect briefly to see if port is in use
  local handle = vim.uv.new_tcp()
  if not handle then
    return false
  end

  local is_running = false
  local checked = false

  handle:connect(config.server.host, port, function(err)
    if not err then
      is_running = true
    end
    checked = true
    if not handle:is_closing() then
      handle:close()
    end
  end)

  -- Wait briefly for the check (with timeout)
  local start = vim.uv.now()
  while not checked and (vim.uv.now() - start) < 100 do
    vim.uv.run('nowait')
  end

  if not checked and not handle:is_closing() then
    handle:close()
  end

  return is_running
end

return M
