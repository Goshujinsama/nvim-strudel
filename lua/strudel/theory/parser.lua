---@mod strudel.theory.parser Strudel pattern parser
---@brief [[
---Parses Strudel mini-notation patterns to extract musical information.
---Supports n(), note(), and chord() patterns.
---@brief ]]

local scales = require('strudel.theory.scales')
local chords = require('strudel.theory.chords')

local M = {}

---@class ParsedNote
---@field type 'midi'|'name'|'degree' Type of note notation
---@field value number|string The note value
---@field octave? number Octave (for named notes)
---@field pc? number Pitch class (0-11) if determinable

---@class ParsedChord
---@field root string Root note name
---@field type string Chord type suffix
---@field original string Original string from pattern
---@field chord? table Parsed chord object

---@class ParseResult
---@field notes ParsedNote[] Extracted notes
---@field chords ParsedChord[] Extracted chord names
---@field degrees number[] Raw degree numbers from n()
---@field source_type 'n'|'note'|'chord'|'mixed'|'unknown' Pattern function type
---@field raw_content string[] Raw content strings found

-- Patterns for extracting Strudel notation
local PATTERNS = {
  -- n("<-1 3 7>") or n("0 2 4 5 7")
  n_pattern = 'n%s*%(%s*["\']([^"\']+)["\']',
  n_pattern_template = 'n%s*%(%s*`([^`]+)`',

  -- note("c3 e3 g3") or note("<c3 e3 g3>")
  note_pattern = 'note%s*%(%s*["\']([^"\']+)["\']',
  note_pattern_template = 'note%s*%(%s*`([^`]+)`',

  -- chord("<Am7 Dm7 G7 Cmaj7>")
  chord_pattern = 'chord%s*%(%s*["\']([^"\']+)["\']',
  chord_pattern_template = 'chord%s*%(%s*`([^`]+)`',

  -- Individual degree (handles negative)
  degree = '(-?%d+)',

  -- Individual note name with octave
  note_name = '([a-gA-G][#bsS]?)(-?%d+)',

  -- Individual note name without octave
  note_name_no_octave = '([a-gA-G][#bsS]?)',

  -- Chord symbol (root + optional suffix)
  chord_symbol = '([A-Ga-g][#bsS]?)([a-zA-Z0-9]*)',
}

---Extract content from mini-notation, stripping sequence markers
---@param content string Raw content from pattern
---@return string[] Items in the pattern
local function extract_items(content)
  -- Remove sequence markers and split by whitespace
  local stripped = content:gsub('[<>%[%]%(%){}|*!/%%@~]', ' ')
  local items = {}

  for item in stripped:gmatch('%S+') do
    -- Skip rest markers
    if item ~= '~' and item ~= '-' then
      table.insert(items, item)
    end
  end

  return items
end

---Parse n() pattern content (scale degrees)
---@param content string Content inside n()
---@return ParsedNote[] notes, number[] degrees
local function parse_n_content(content)
  local items = extract_items(content)
  local notes = {}
  local degrees = {}

  for _, item in ipairs(items) do
    local degree = item:match('^(-?%d+)$')
    if degree then
      local deg_num = tonumber(degree)
      table.insert(degrees, deg_num)
      table.insert(notes, {
        type = 'degree',
        value = deg_num,
      })
    end
  end

  return notes, degrees
end

---Parse note() pattern content (note names)
---@param content string Content inside note()
---@return ParsedNote[] notes
local function parse_note_content(content)
  local items = extract_items(content)
  local notes = {}

  for _, item in ipairs(items) do
    -- Try note with octave first
    local name, octave = item:match('^([a-gA-G][#bsS]?)(-?%d+)$')
    if name and octave then
      -- Normalize note name
      name = name:sub(1, 1):upper() .. name:sub(2):lower():gsub('s', '#')
      local pc = scales.note_name_to_pc(name)
      table.insert(notes, {
        type = 'name',
        value = name,
        octave = tonumber(octave),
        pc = pc,
      })
    else
      -- Try note without octave
      name = item:match('^([a-gA-G][#bsS]?)$')
      if name then
        name = name:sub(1, 1):upper() .. name:sub(2):lower():gsub('s', '#')
        local pc = scales.note_name_to_pc(name)
        table.insert(notes, {
          type = 'name',
          value = name,
          pc = pc,
        })
      end
    end
  end

  return notes
end

---Parse chord() pattern content (chord symbols)
---@param content string Content inside chord()
---@return ParsedChord[] chords
local function parse_chord_content(content)
  local items = extract_items(content)
  local parsed_chords = {}

  for _, item in ipairs(items) do
    local root, suffix = item:match('^([A-Ga-g][#bsS]?)(.*)$')
    if root then
      -- Normalize root
      root = root:sub(1, 1):upper() .. root:sub(2):lower():gsub('s', '#')

      -- Try to parse the full chord
      local chord_obj = chords.parse_chord(item)

      table.insert(parsed_chords, {
        root = root,
        type = suffix,
        original = item,
        chord = chord_obj,
      })
    end
  end

  return parsed_chords
end

---Parse a single line for Strudel patterns
---@param line string Line to parse
---@return ParseResult
function M.parse_line(line)
  local result = {
    notes = {},
    chords = {},
    degrees = {},
    source_type = 'unknown',
    raw_content = {},
  }

  local found_n = false
  local found_note = false
  local found_chord = false

  -- Find all n() patterns
  for content in line:gmatch(PATTERNS.n_pattern) do
    found_n = true
    table.insert(result.raw_content, content)
    local notes, degrees = parse_n_content(content)
    for _, note in ipairs(notes) do
      table.insert(result.notes, note)
    end
    for _, deg in ipairs(degrees) do
      table.insert(result.degrees, deg)
    end
  end

  -- Also check template literals
  for content in line:gmatch(PATTERNS.n_pattern_template) do
    found_n = true
    table.insert(result.raw_content, content)
    local notes, degrees = parse_n_content(content)
    for _, note in ipairs(notes) do
      table.insert(result.notes, note)
    end
    for _, deg in ipairs(degrees) do
      table.insert(result.degrees, deg)
    end
  end

  -- Find all note() patterns
  for content in line:gmatch(PATTERNS.note_pattern) do
    found_note = true
    table.insert(result.raw_content, content)
    local notes = parse_note_content(content)
    for _, note in ipairs(notes) do
      table.insert(result.notes, note)
    end
  end

  for content in line:gmatch(PATTERNS.note_pattern_template) do
    found_note = true
    table.insert(result.raw_content, content)
    local notes = parse_note_content(content)
    for _, note in ipairs(notes) do
      table.insert(result.notes, note)
    end
  end

  -- Find all chord() patterns
  for content in line:gmatch(PATTERNS.chord_pattern) do
    found_chord = true
    table.insert(result.raw_content, content)
    local chords_parsed = parse_chord_content(content)
    for _, chord in ipairs(chords_parsed) do
      table.insert(result.chords, chord)
    end
  end

  for content in line:gmatch(PATTERNS.chord_pattern_template) do
    found_chord = true
    table.insert(result.raw_content, content)
    local chords_parsed = parse_chord_content(content)
    for _, chord in ipairs(chords_parsed) do
      table.insert(result.chords, chord)
    end
  end

  -- Determine source type
  local count = (found_n and 1 or 0) + (found_note and 1 or 0) + (found_chord and 1 or 0)
  if count > 1 then
    result.source_type = 'mixed'
  elseif found_n then
    result.source_type = 'n'
  elseif found_note then
    result.source_type = 'note'
  elseif found_chord then
    result.source_type = 'chord'
  end

  return result
end

---Parse multiple lines
---@param lines string[] Lines to parse
---@return ParseResult Combined result
function M.parse_lines(lines)
  local combined = {
    notes = {},
    chords = {},
    degrees = {},
    source_type = 'unknown',
    raw_content = {},
  }

  local found_types = {}

  for _, line in ipairs(lines) do
    local result = M.parse_line(line)

    for _, note in ipairs(result.notes) do
      table.insert(combined.notes, note)
    end
    for _, chord in ipairs(result.chords) do
      table.insert(combined.chords, chord)
    end
    for _, deg in ipairs(result.degrees) do
      table.insert(combined.degrees, deg)
    end
    for _, content in ipairs(result.raw_content) do
      table.insert(combined.raw_content, content)
    end

    if result.source_type ~= 'unknown' then
      found_types[result.source_type] = true
    end
  end

  -- Determine combined source type
  local type_count = 0
  local single_type = nil
  for t, _ in pairs(found_types) do
    type_count = type_count + 1
    single_type = t
  end

  if type_count > 1 then
    combined.source_type = 'mixed'
  elseif type_count == 1 then
    combined.source_type = single_type
  end

  return combined
end

---Parse a buffer
---@param bufnr? number Buffer number (0 for current)
---@return ParseResult
function M.parse_buffer(bufnr)
  bufnr = bufnr or 0
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  return M.parse_lines(lines)
end

---Parse a selection (line range)
---@param start_line number Start line (1-indexed)
---@param end_line number End line (1-indexed)
---@param bufnr? number Buffer number
---@return ParseResult
function M.parse_selection(start_line, end_line, bufnr)
  bufnr = bufnr or 0
  local lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)
  return M.parse_lines(lines)
end

---Get all pitch classes from a parse result
---@param result ParseResult
---@return number[] Unique pitch classes found
function M.get_pitch_classes(result)
  local pcs = {}
  local seen = {}

  -- From notes with pitch class
  for _, note in ipairs(result.notes) do
    if note.pc and not seen[note.pc] then
      seen[note.pc] = true
      table.insert(pcs, note.pc)
    end
  end

  -- From chords
  for _, chord in ipairs(result.chords) do
    if chord.chord then
      for _, pc in ipairs(chord.chord.pcs) do
        if not seen[pc] then
          seen[pc] = true
          table.insert(pcs, pc)
        end
      end
    end
  end

  table.sort(pcs)
  return pcs
end

---Check if a parse result has any musical content
---@param result ParseResult
---@return boolean
function M.has_content(result)
  return #result.notes > 0 or #result.chords > 0 or #result.degrees > 0
end

return M
