local config = require('strudel.config')
local client = require('strudel.client')
local utils = require('strudel.utils')

local M = {}

---@type number?
local ns_id = nil

---@type table<number, number[]> Buffer ID -> extmark IDs
local extmarks = {}

---@type number? The buffer that was last evaluated (where highlights should go)
local evaluated_bufnr = nil

---@type boolean Whether setup() has been called
local setup_done = false

---@type function[] Unsubscribe functions for client callbacks
local unsubscribers = {}

---@type number Last time cleanup_invalid_buffers ran (for throttling)
local last_cleanup_time = 0

---@type number Minimum seconds between cleanup runs
local CLEANUP_INTERVAL = 5

---Get or create the namespace
---@return number
local function get_namespace()
  if not ns_id then
    ns_id = vim.api.nvim_create_namespace('strudel')
  end
  return ns_id
end

---Clear all extmarks in a buffer
---@param bufnr number
local function clear_buffer(bufnr)
  local ns = get_namespace()
  vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
  extmarks[bufnr] = {}
end

---Clear all extmarks in all buffers
function M.clear_all()
  local ns = get_namespace()
  for bufnr, _ in pairs(extmarks) do
    if vim.api.nvim_buf_is_valid(bufnr) then
      vim.api.nvim_buf_clear_namespace(bufnr, ns, 0, -1)
    end
  end
  extmarks = {}
end

---Remove entries for closed/invalid buffers from extmarks table
---Call this periodically to prevent memory leaks (throttled to run at most every CLEANUP_INTERVAL seconds)
function M.cleanup_invalid_buffers()
  local now = vim.uv.now() / 1000 -- Convert ms to seconds
  if now - last_cleanup_time < CLEANUP_INTERVAL then
    return -- Skip if we ran recently
  end
  last_cleanup_time = now

  for bufnr, _ in pairs(extmarks) do
    if not vim.api.nvim_buf_is_valid(bufnr) then
      extmarks[bufnr] = nil
    end
  end
end

---Set the buffer that should receive highlights
---@param bufnr number
function M.set_evaluated_buffer(bufnr)
  evaluated_bufnr = bufnr
  utils.debug('Visualizer: evaluated buffer set to ' .. bufnr)
end

---Get the currently evaluated buffer
---@return number?
function M.get_evaluated_buffer()
  return evaluated_bufnr
end

---Highlight active elements in a buffer
---@param bufnr number
---@param elements table[]
function M.highlight_active(bufnr, elements)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    utils.debug('Invalid buffer: ' .. bufnr)
    return
  end

  local cfg = config.get()
  local ns = get_namespace()

  -- Clear previous highlights
  clear_buffer(bufnr)

  local marks = {}
  local line_count = vim.api.nvim_buf_line_count(bufnr)

  for _, elem in ipairs(elements) do
    -- Server sends 1-based line/column, Neovim uses 0-based
    -- endCol from server is exclusive (points past last char)
    local start_line = (elem.startLine or 1) - 1
    local start_col = (elem.startCol or 1) - 1
    local end_line = (elem.endLine or elem.startLine or 1) - 1
    local end_col = (elem.endCol or (start_col + 2)) - 1  -- Convert to 0-based

    -- Validate line numbers
    if start_line >= 0 and start_line < line_count and end_line < line_count then
      -- Clamp columns to actual line length
      local line_text = vim.api.nvim_buf_get_lines(bufnr, start_line, start_line + 1, false)[1] or ''
      local line_len = #line_text
      start_col = math.min(start_col, line_len)
      end_col = math.min(end_col, line_len)

      if start_col < end_col then
        utils.debug(string.format('Setting extmark: line=%d, col=%d-%d', start_line, start_col, end_col))
        local ok, mark_id = pcall(vim.api.nvim_buf_set_extmark, bufnr, ns, start_line, start_col, {
          end_row = end_line,
          end_col = end_col,
          hl_group = cfg.highlight.active,
          priority = 100,
        })

        if ok then
          table.insert(marks, mark_id)
        else
          utils.debug('Failed to set extmark: ' .. tostring(mark_id))
        end
      end
    end
  end

  extmarks[bufnr] = marks
  utils.debug('Set ' .. #marks .. ' extmarks')
end

---Setup event handlers for the visualizer
---Safe to call multiple times; will only register handlers once
function M.setup()
  -- Prevent duplicate setup
  if setup_done then
    utils.debug('Visualizer already setup, skipping')
    return
  end
  setup_done = true

  -- Listen for active element updates from the server
  local unsub_active = client.on('active', function(msg)
    utils.debug('Visualizer received active event with ' .. #(msg.elements or {}) .. ' elements')
    local elements = msg.elements or {}
    -- Only apply highlights to the buffer that was evaluated
    -- This prevents highlights from appearing in unrelated buffers
    if evaluated_bufnr and vim.api.nvim_buf_is_valid(evaluated_bufnr) then
      M.highlight_active(evaluated_bufnr, elements)
    end
    -- Periodically cleanup invalid buffer entries
    M.cleanup_invalid_buffers()
  end)
  table.insert(unsubscribers, unsub_active)

  -- Clear highlights when disconnected
  local unsub_disconnect = client.on('disconnect', function()
    M.clear_all()
  end)
  table.insert(unsubscribers, unsub_disconnect)

  -- Clear highlights on stop
  local unsub_status = client.on('status', function(msg)
    if msg.playing == false then
      M.clear_all()
    end
  end)
  table.insert(unsubscribers, unsub_status)

  utils.debug('Visualizer setup complete')
end

---Teardown visualizer and unregister all callbacks
function M.teardown()
  -- Unsubscribe all callbacks
  for _, unsub in ipairs(unsubscribers) do
    unsub()
  end
  unsubscribers = {}

  -- Clear all highlights
  M.clear_all()

  -- Reset state
  setup_done = false
  evaluated_bufnr = nil

  utils.debug('Visualizer teardown complete')
end

return M
