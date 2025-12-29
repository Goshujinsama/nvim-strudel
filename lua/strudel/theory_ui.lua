---@mod strudel.theory_ui Floating window UI for chord suggestions
---@brief [[
---Provides a floating window interface for viewing and inserting chord suggestions.
---@brief ]]

local M = {}

---@class TheoryUIState
---@field bufnr number|nil Floating window buffer
---@field winid number|nil Floating window ID
---@field ns_id number Namespace for highlights
---@field suggestions ChordSuggestion[] Current suggestions
---@field selected number Currently selected index (1-indexed)
---@field scope 'line'|'selection'|'buffer' Analysis scope
---@field analysis KeyAnalysisResult|nil Current analysis result
---@field source_bufnr number Source buffer we're suggesting for
---@field source_winid number Source window we're suggesting for
---@field source_cursor number[] Cursor position [row, col] in source

---@type TheoryUIState
local state = {
  bufnr = nil,
  winid = nil,
  ns_id = vim.api.nvim_create_namespace('strudel_theory_ui'),
  suggestions = {},
  selected = 1,
  scope = 'line',
  analysis = nil,
  source_bufnr = 0,
  source_winid = 0,
  source_cursor = { 1, 0 },
}

-- Scope cycle order
local SCOPES = { 'line', 'selection', 'buffer' }

---Get the next scope in cycle
---@param current string
---@return string
local function next_scope(current)
  for i, scope in ipairs(SCOPES) do
    if scope == current then
      return SCOPES[(i % #SCOPES) + 1]
    end
  end
  return 'line'
end

---Render the suggestions to the buffer
local function render()
  if not state.bufnr or not vim.api.nvim_buf_is_valid(state.bufnr) then
    return
  end

  vim.api.nvim_set_option_value('modifiable', true, { buf = state.bufnr })

  local lines = {}
  local highlights = {}

  -- Header with detected key
  local header
  if state.analysis then
    local confidence_pct = math.floor(state.analysis.confidence * 100)
    local scale_name = state.analysis.scale_info and state.analysis.scale_info.name or state.analysis.scale
    header = string.format(' %s %s (%d%%) [%s] ', state.analysis.root, scale_name, confidence_pct, state.scope)
  else
    header = string.format(' No key detected [%s] ', state.scope)
  end
  table.insert(lines, header)
  table.insert(highlights, { line = 1, hl = 'StrudelTheoryHeader' })

  -- Separator
  table.insert(lines, string.rep('─', 40))

  -- Instructions
  table.insert(lines, ' j/k:nav  c:chord  n:note  d:deg  s:scope')
  table.insert(highlights, { line = 3, hl = 'Comment' })

  -- Empty line
  table.insert(lines, '')

  -- Suggestions
  for i, suggestion in ipairs(state.suggestions) do
    local prefix = i == state.selected and '▶ ' or '  '
    local chord_line = string.format('%s%-8s %s', prefix, suggestion.chord, suggestion.function_name)

    -- Truncate if too long
    if #chord_line > 40 then
      chord_line = chord_line:sub(1, 37) .. '...'
    end

    table.insert(lines, chord_line)

    if i == state.selected then
      table.insert(highlights, { line = #lines, hl = 'StrudelTheorySelected' })
    else
      table.insert(highlights, { line = #lines, hl = 'StrudelTheoryChord' })
    end
  end

  -- Set buffer content
  vim.api.nvim_buf_set_lines(state.bufnr, 0, -1, false, lines)

  -- Apply highlights
  vim.api.nvim_buf_clear_namespace(state.bufnr, state.ns_id, 0, -1)
  for _, hl in ipairs(highlights) do
    vim.api.nvim_buf_add_highlight(state.bufnr, state.ns_id, hl.hl, hl.line - 1, 0, -1)
  end

  vim.api.nvim_set_option_value('modifiable', false, { buf = state.bufnr })
end

---Move selection up
local function select_prev()
  if state.selected > 1 then
    state.selected = state.selected - 1
    render()
  end
end

---Move selection down
local function select_next()
  if state.selected < #state.suggestions then
    state.selected = state.selected + 1
    render()
  end
end

---Insert the selected suggestion
---@param format 'chord'|'notes'|'degrees'
local function insert_selected(format)
  local suggestion = state.suggestions[state.selected]
  if not suggestion then
    return
  end

  local text
  if format == 'chord' then
    text = suggestion.strudel
  elseif format == 'notes' then
    text = suggestion.strudel_notes
  elseif format == 'degrees' then
    if suggestion.strudel_degrees then
      text = suggestion.strudel_degrees
    else
      -- Fallback to notes if no degrees available
      text = suggestion.strudel_notes
    end
  else
    text = suggestion.strudel
  end

  -- Close the popup
  M.close()

  -- Return to source window and insert
  if state.source_winid and vim.api.nvim_win_is_valid(state.source_winid) then
    vim.api.nvim_set_current_win(state.source_winid)
  end

  -- Insert at cursor
  vim.api.nvim_put({ text }, 'c', true, true)
end

---Cycle through analysis scopes
local function cycle_scope()
  state.scope = next_scope(state.scope)
  M.refresh()
end

---Setup keymaps for the floating window
local function setup_keymaps()
  if not state.bufnr then
    return
  end

  local opts = { buffer = state.bufnr, nowait = true, silent = true }

  -- Navigation
  vim.keymap.set('n', 'j', select_next, opts)
  vim.keymap.set('n', 'k', select_prev, opts)
  vim.keymap.set('n', '<Down>', select_next, opts)
  vim.keymap.set('n', '<Up>', select_prev, opts)
  vim.keymap.set('n', '<Tab>', select_next, opts)
  vim.keymap.set('n', '<S-Tab>', select_prev, opts)

  -- Insert actions
  vim.keymap.set('n', '<CR>', function()
    insert_selected('chord')
  end, opts)
  vim.keymap.set('n', 'c', function()
    insert_selected('chord')
  end, opts)
  vim.keymap.set('n', 'n', function()
    insert_selected('notes')
  end, opts)
  vim.keymap.set('n', 'd', function()
    insert_selected('degrees')
  end, opts)

  -- Scope toggle
  vim.keymap.set('n', 's', cycle_scope, opts)

  -- Close
  vim.keymap.set('n', 'q', M.close, opts)
  vim.keymap.set('n', '<Esc>', M.close, opts)
end

---Refresh suggestions with current scope
function M.refresh()
  local suggestions = require('strudel.theory.suggestions')

  -- Switch to source window for analysis
  local current_win = vim.api.nvim_get_current_win()
  if state.source_winid and vim.api.nvim_win_is_valid(state.source_winid) then
    vim.api.nvim_set_current_win(state.source_winid)
  end

  local new_suggestions, analysis = suggestions.suggest({
    scope = state.scope,
    bufnr = state.source_bufnr,
  })

  -- Switch back
  if vim.api.nvim_win_is_valid(current_win) then
    vim.api.nvim_set_current_win(current_win)
  end

  state.suggestions = new_suggestions
  state.analysis = analysis
  state.selected = 1

  render()
end

---Show the suggestion window
---@param opts? table Options: scope ('line'|'selection'|'buffer')
function M.show(opts)
  opts = opts or {}

  -- Store source context
  state.source_bufnr = vim.api.nvim_get_current_buf()
  state.source_winid = vim.api.nvim_get_current_win()
  state.source_cursor = vim.api.nvim_win_get_cursor(0)
  state.scope = opts.scope or 'line'

  -- Close existing window
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    vim.api.nvim_win_close(state.winid, true)
    state.winid = nil
  end

  -- Get suggestions
  local suggestions_mod = require('strudel.theory.suggestions')
  state.suggestions, state.analysis = suggestions_mod.suggest({
    scope = state.scope,
    bufnr = state.source_bufnr,
  })
  state.selected = 1

  if #state.suggestions == 0 then
    vim.notify('No chord suggestions available', vim.log.levels.INFO)
    return
  end

  -- Create buffer
  state.bufnr = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_option_value('buftype', 'nofile', { buf = state.bufnr })
  vim.api.nvim_set_option_value('bufhidden', 'wipe', { buf = state.bufnr })
  vim.api.nvim_set_option_value('filetype', 'strudel_theory', { buf = state.bufnr })

  -- Calculate window size
  local width = 42
  local height = math.min(#state.suggestions + 5, 20)

  -- Calculate position (near cursor)
  local win_config = {
    relative = 'cursor',
    row = 1,
    col = 0,
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded',
    title = ' Chord Suggestions ',
    title_pos = 'center',
    focusable = true,
  }

  -- Create window
  state.winid = vim.api.nvim_open_win(state.bufnr, true, win_config)

  -- Window options
  vim.api.nvim_set_option_value('cursorline', false, { win = state.winid })
  vim.api.nvim_set_option_value('wrap', false, { win = state.winid })
  vim.api.nvim_set_option_value('number', false, { win = state.winid })
  vim.api.nvim_set_option_value('relativenumber', false, { win = state.winid })
  vim.api.nvim_set_option_value('signcolumn', 'no', { win = state.winid })

  -- Render content
  render()

  -- Setup keymaps
  setup_keymaps()

  -- Auto-close on window leave
  vim.api.nvim_create_autocmd('WinLeave', {
    buffer = state.bufnr,
    once = true,
    callback = function()
      M.close()
    end,
  })
end

---Close the suggestion window
function M.close()
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    vim.api.nvim_win_close(state.winid, true)
  end
  state.winid = nil
  state.bufnr = nil
  state.suggestions = {}
  state.selected = 1
  state.analysis = nil
end

---Toggle the suggestion window
---@param opts? table Options passed to show()
function M.toggle(opts)
  if state.winid and vim.api.nvim_win_is_valid(state.winid) then
    M.close()
  else
    M.show(opts)
  end
end

---Check if window is open
---@return boolean
function M.is_open()
  return state.winid ~= nil and vim.api.nvim_win_is_valid(state.winid)
end

---Get current state (for debugging)
---@return TheoryUIState
function M.get_state()
  return state
end

return M
