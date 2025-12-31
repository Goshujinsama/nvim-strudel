---@mod strudel.theory Music theory module for nvim-strudel
---@brief [[
---Provides music theory intelligence for Strudel patterns.
---Includes scale/chord definitions, pattern parsing, key detection,
---and chord suggestions.
---@brief ]]

local M = {}

-- Lazy load submodules
local function get_intervals()
  return require('strudel.theory.intervals')
end

local function get_scales()
  return require('strudel.theory.scales')
end

local function get_chords()
  return require('strudel.theory.chords')
end

local function get_parser()
  return require('strudel.theory.parser')
end

local function get_analyzer()
  return require('strudel.theory.analyzer')
end

local function get_suggestions()
  return require('strudel.theory.suggestions')
end

---@type boolean
local initialized = false

---Setup the theory module
function M.setup()
  if initialized then
    return
  end

  initialized = true

  -- Preload commonly used modules
  require('strudel.theory.scales')
  require('strudel.theory.chords')
end

---Check if module is initialized
---@return boolean
function M.is_initialized()
  return initialized
end

-- Export submodules
M.intervals = setmetatable({}, {
  __index = function(_, k)
    return get_intervals()[k]
  end,
})

M.scales = setmetatable({}, {
  __index = function(_, k)
    return get_scales()[k]
  end,
})

M.chords = setmetatable({}, {
  __index = function(_, k)
    return get_chords()[k]
  end,
})

M.parser = setmetatable({}, {
  __index = function(_, k)
    return get_parser()[k]
  end,
})

M.analyzer = setmetatable({}, {
  __index = function(_, k)
    return get_analyzer()[k]
  end,
})

M.suggestions = setmetatable({}, {
  __index = function(_, k)
    return get_suggestions()[k]
  end,
})

-- Utility functions

---Convert note name to MIDI number
---@param note string Note name with octave (e.g., "C4", "F#3")
---@return number|nil MIDI number
function M.note_to_midi(note)
  local name, octave = note:match('^([A-Ga-g][#bsS]?)(-?%d+)$')
  if not name or not octave then
    return nil
  end

  local pc = get_scales().note_name_to_pc(name)
  if not pc then
    return nil
  end

  return pc + (tonumber(octave) + 1) * 12
end

---Convert MIDI number to note name
---@param midi number MIDI number (0-127)
---@param prefer_flat? boolean Use flat names instead of sharp
---@return string Note name with octave
function M.midi_to_note(midi, prefer_flat)
  local pc = midi % 12
  local octave = math.floor(midi / 12) - 1
  return get_scales().pc_to_note_name(pc, prefer_flat) .. octave
end

---Convert note name to pitch class (0-11)
---@param note string Note name (e.g., "C", "F#", "Bb")
---@return number|nil Pitch class
function M.note_to_pc(note)
  return get_scales().note_name_to_pc(note)
end

---Convert pitch class to note name
---@param pc number Pitch class (0-11)
---@param prefer_flat? boolean Use flat names
---@return string Note name
function M.pc_to_note(pc, prefer_flat)
  return get_scales().pc_to_note_name(pc, prefer_flat)
end

---Analyze the current line for key/scale
---@param line? string Line to analyze (defaults to current line)
---@return table|nil Analysis result
function M.analyze_line(line)
  if not line then
    line = vim.api.nvim_get_current_line()
  end
  return get_analyzer().analyze_line(line)
end

---Analyze the current buffer for key/scale
---@param bufnr? number Buffer number (defaults to current)
---@return table|nil Analysis result
function M.analyze_buffer(bufnr)
  bufnr = bufnr or 0
  return get_analyzer().analyze_buffer(bufnr)
end

---Analyze a visual selection for key/scale
---@param start_line number Start line (1-indexed)
---@param end_line number End line (1-indexed)
---@param bufnr? number Buffer number
---@return table|nil Analysis result
function M.analyze_selection(start_line, end_line, bufnr)
  bufnr = bufnr or 0
  return get_analyzer().analyze_selection(start_line, end_line, bufnr)
end

---Get chord suggestions for the current context
---@param opts? table Options: scope ('line'|'selection'|'buffer')
---@return table[] Suggestions
function M.suggest_chords(opts)
  opts = opts or {}
  return get_suggestions().suggest(opts)
end

---Parse Strudel patterns from a line
---@param line string Line to parse
---@return table Parse result
function M.parse_line(line)
  return get_parser().parse_line(line)
end

return M
