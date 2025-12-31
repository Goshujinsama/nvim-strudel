local utils = require('strudel.utils')
local config = require('strudel.config')

local M = {}

---@class StrudelClient
---@field connected boolean
---@field handle? uv_tcp_t
---@field buffer_chunks string[] Table-based buffer chunks for efficient parsing
---@field callbacks table<string, function[]>

---@type StrudelClient
local state = {
  connected = false,
  handle = nil,
  buffer_chunks = {}, -- Table-based buffer for better performance
  callbacks = {},
}

---Register a callback for an event type
---@param event string
---@param callback function
---@return function unsubscribe function to remove the callback
function M.on(event, callback)
  state.callbacks[event] = state.callbacks[event] or {}
  table.insert(state.callbacks[event], callback)

  -- Return unsubscribe function
  return function()
    M.off(event, callback)
  end
end

---Unregister a callback for an event type
---@param event string
---@param callback function
function M.off(event, callback)
  local callbacks = state.callbacks[event]
  if not callbacks then
    return
  end
  for i = #callbacks, 1, -1 do
    if callbacks[i] == callback then
      table.remove(callbacks, i)
      break
    end
  end
end

---Register a one-time callback that auto-removes after being called
---@param event string
---@param callback function
---@return function unsubscribe function to remove the callback
function M.once(event, callback)
  local wrapper
  wrapper = function(data)
    M.off(event, wrapper)
    callback(data)
  end
  return M.on(event, wrapper)
end

---Clear all callbacks for an event type, or all callbacks if no event specified
---@param event? string
function M.clear_callbacks(event)
  if event then
    state.callbacks[event] = {}
  else
    state.callbacks = {}
  end
end

---Emit an event to all registered callbacks
---@param event string
---@param data any
local function emit(event, data)
  local callbacks = state.callbacks[event] or {}
  for _, cb in ipairs(callbacks) do
    local ok, err = pcall(cb, data)
    if not ok then
      utils.error('Callback error for ' .. event .. ': ' .. tostring(err))
    end
  end
end

---Parse a JSON message from the server
---@param data string
---@return table?
local function parse_message(data)
  local ok, msg = pcall(vim.json.decode, data)
  if ok and msg then
    return msg
  end
  return nil
end

---Handle incoming data from the server
---@param data string
local function on_data(data)
  -- Use table-based buffering to avoid string concatenation overhead
  table.insert(state.buffer_chunks, data)

  -- Only concatenate when we need to parse (when we have a newline)
  if not data:find('\n') then
    return
  end

  -- Concatenate all chunks
  local buffer = table.concat(state.buffer_chunks)
  state.buffer_chunks = {}

  -- Messages are newline-delimited JSON
  while true do
    local newline_pos = buffer:find('\n')
    if not newline_pos then
      break
    end

    local line = buffer:sub(1, newline_pos - 1)
    buffer = buffer:sub(newline_pos + 1)

    local msg = parse_message(line)
    if msg and msg.type then
      emit(msg.type, msg)
    end
  end

  -- Store any remaining data back in chunks
  if #buffer > 0 then
    table.insert(state.buffer_chunks, buffer)
  end
end

---Actually perform the TCP connection after DNS resolution
---@param ip string
---@param port number
---@param display_host string
local function do_connect(ip, port, display_host)
  local handle = vim.uv.new_tcp()
  if not handle then
    utils.error('Failed to create TCP handle')
    return
  end

  state.handle = handle

  handle:connect(ip, port, function(err)
    if err then
      vim.schedule(function()
        utils.error('Connection failed: ' .. tostring(err))
        emit('disconnect', { error = err })
      end)
      return
    end

    state.connected = true

    vim.schedule(function()
      utils.log('Connected to server at ' .. display_host .. ':' .. port)
      emit('connect', {})
    end)

    handle:read_start(function(read_err, data)
      if read_err then
        vim.schedule(function()
          utils.error('Read error: ' .. tostring(read_err))
          M.disconnect()
        end)
        return
      end

      if data then
        vim.schedule(function()
          on_data(data)
        end)
      else
        -- Connection closed
        vim.schedule(function()
          M.disconnect()
        end)
      end
    end)
  end)
end

---Connect to the Strudel server
---@param host? string
---@param port? number
---@return boolean
function M.connect(host, port)
  local cfg = config.get()
  host = host or cfg.server.host
  port = port or cfg.server.port

  if state.connected then
    utils.warn('Already connected')
    return true
  end

  -- Resolve hostname to IP address
  vim.uv.getaddrinfo(host, nil, { family = 'inet' }, function(err, addresses)
    if err or not addresses or #addresses == 0 then
      vim.schedule(function()
        utils.error('Failed to resolve hostname: ' .. host .. ' (' .. tostring(err) .. ')')
      end)
      return
    end

    local ip = addresses[1].addr
    vim.schedule(function()
      do_connect(ip, port, host)
    end)
  end)

  return true
end

---Disconnect from the server
function M.disconnect()
  if state.handle then
    if not state.handle:is_closing() then
      state.handle:close()
    end
    state.handle = nil
  end

  local was_connected = state.connected
  state.connected = false
  state.buffer_chunks = {}

  if was_connected then
    utils.log('Disconnected from server')
    emit('disconnect', {})
  end
end

---Send a message to the server
---@param msg table
---@return boolean
function M.send(msg)
  if not state.connected or not state.handle then
    utils.error('Not connected to server')
    return false
  end

  local data = vim.json.encode(msg) .. '\n'

  state.handle:write(data, function(err)
    if err then
      vim.schedule(function()
        utils.error('Write error: ' .. tostring(err))
      end)
    end
  end)

  return true
end

---Send code for evaluation
---@param code string
---@param bufnr? number
---@return boolean
function M.eval(code, bufnr)
  return M.send({
    type = 'eval',
    code = code,
    bufnr = bufnr,
  })
end

---Send play command
---@return boolean
function M.play()
  return M.send({ type = 'play' })
end

---Send pause command
---@return boolean
function M.pause()
  return M.send({ type = 'pause' })
end

---Send stop command
---@return boolean
function M.stop()
  return M.send({ type = 'stop' })
end

---Send hush command (stop and silence all)
---@return boolean
function M.hush()
  return M.send({ type = 'hush' })
end

---Send shutdown command to server
---@return boolean
function M.shutdown()
  return M.send({ type = 'shutdown' })
end

---Request samples list from server
---@param callback fun(samples: string[])
function M.get_samples(callback)
  if not state.connected then
    utils.error('Not connected to server')
    return
  end

  -- Use once() so callback auto-removes after being called
  M.once('samples', function(msg)
    callback(msg.samples or {})
  end)

  -- Request samples
  M.send({ type = 'getSamples' })
end

---Request synth sounds list from server
---@param callback fun(sounds: string[])
function M.get_sounds(callback)
  if not state.connected then
    utils.error('Not connected to server')
    return
  end

  -- Use once() so callback auto-removes after being called
  M.once('sounds', function(msg)
    callback(msg.sounds or {})
  end)

  M.send({ type = 'getSounds' })
end

---Request sample banks list from server
---@param callback fun(banks: string[])
function M.get_banks(callback)
  if not state.connected then
    utils.error('Not connected to server')
    return
  end

  -- Use once() so callback auto-removes after being called
  M.once('banks', function(msg)
    callback(msg.banks or {})
  end)

  M.send({ type = 'getBanks' })
end

---Check if connected
---@return boolean
function M.is_connected()
  return state.connected
end

---Get current connection state
---@return StrudelClient
function M.get_state()
  return vim.deepcopy(state)
end

return M
