---@mod strudel.theory.suggestions Chord suggestion engine
---@brief [[
---Generates chord suggestions based on detected key/scale.
---Includes diatonic chords, secondary dominants, and common substitutions.
---@brief ]]

local scales = require('strudel.theory.scales')
local chords = require('strudel.theory.chords')
local analyzer = require('strudel.theory.analyzer')
local parser = require('strudel.theory.parser')

local M = {}

---@class ChordSuggestion
---@field chord string Full chord name (e.g., "CM7")
---@field strudel string Strudel chord() notation
---@field strudel_notes string Strudel note() notation with notes
---@field strudel_degrees string|nil Strudel n() notation with scale degrees (if applicable)
---@field degree number|nil Scale degree (1-7) for diatonic chords
---@field function_name string Harmonic function description
---@field category string Category: 'diatonic', 'secondary', 'substitution', 'borrowed'
---@field relevance number Relevance score (0-1)
---@field chord_obj table Full chord object

-- Roman numeral names for scale degrees
local DEGREE_NUMERALS = { 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII' }

-- Harmonic functions by degree (for major keys)
local MAJOR_FUNCTIONS = {
  [1] = 'tonic',
  [2] = 'supertonic',
  [3] = 'mediant',
  [4] = 'subdominant',
  [5] = 'dominant',
  [6] = 'submediant',
  [7] = 'leading tone',
}

-- Harmonic functions for minor keys
local MINOR_FUNCTIONS = {
  [1] = 'tonic',
  [2] = 'supertonic',
  [3] = 'mediant',
  [4] = 'subdominant',
  [5] = 'dominant',
  [6] = 'submediant',
  [7] = 'subtonic',
}

---Get harmonic function name for a scale degree
---@param degree number Scale degree (1-7)
---@param scale_name string Scale name
---@return string Function name
local function get_harmonic_function(degree, scale_name)
  local is_minor = scale_name:match('minor') or scale_name == 'dorian' or scale_name == 'phrygian'
      or scale_name == 'aeolian' or scale_name == 'locrian'

  if is_minor then
    return MINOR_FUNCTIONS[degree] or ''
  else
    return MAJOR_FUNCTIONS[degree] or ''
  end
end

---Generate diatonic chord suggestions
---@param root string Key root
---@param scale_name string Scale name
---@return ChordSuggestion[]
function M.get_diatonic_suggestions(root, scale_name)
  local suggestions = {}
  local diatonic = chords.get_diatonic_chords(root, scale_name, true)

  for degree, chord in ipairs(diatonic) do
    local chord_name = chords.chord_name(chord)
    local strudel = chords.chord_to_strudel(chord)
    local strudel_notes = chords.chord_to_strudel_notes(chord)
    local strudel_degrees = chords.chord_to_degrees(chord, root, scale_name)

    local function_name = get_harmonic_function(degree, scale_name)
    local numeral = DEGREE_NUMERALS[degree]

    -- Adjust numeral for minor chords (lowercase)
    if chord.chord_type.quality == 'minor' or chord.chord_type.quality == 'diminished' then
      numeral = numeral:lower()
    end

    -- Base relevance on degree importance
    local relevance = 0.8
    if degree == 1 then
      relevance = 1.0 -- Tonic is most relevant
    elseif degree == 5 then
      relevance = 0.95 -- Dominant is very relevant
    elseif degree == 4 then
      relevance = 0.9 -- Subdominant is quite relevant
    end

    table.insert(suggestions, {
      chord = chord_name,
      strudel = strudel,
      strudel_notes = strudel_notes,
      strudel_degrees = strudel_degrees,
      degree = degree,
      function_name = string.format('%s (%s)', numeral, function_name),
      category = 'diatonic',
      relevance = relevance,
      chord_obj = chord,
    })
  end

  return suggestions
end

---Generate secondary dominant suggestions
---@param root string Key root
---@param scale_name string Scale name
---@return ChordSuggestion[]
function M.get_secondary_dominant_suggestions(root, scale_name)
  local suggestions = {}
  local scale = scales.SCALES[scale_name]
  if not scale then
    return suggestions
  end

  local root_pc = scales.note_name_to_pc(root)
  if not root_pc then
    return suggestions
  end

  -- Get diatonic chords to find targets
  local diatonic = chords.get_diatonic_chords(root, scale_name, true)

  for degree, target_chord in ipairs(diatonic) do
    -- Only create secondary dominants to major/minor chords (not to I or vii°)
    if degree > 1 and degree < 7 then
      local quality = target_chord.chord_type.quality
      if quality == 'major' or quality == 'minor' then
        -- Secondary dominant is a P5 above the target
        local sec_dom_root = (target_chord.root_pc + 7) % 12
        local sec_dom = chords.build_chord(sec_dom_root, 'dom7')

        if sec_dom then
          local chord_name = chords.chord_name(sec_dom)
          local strudel = chords.chord_to_strudel(sec_dom)
          local strudel_notes = chords.chord_to_strudel_notes(sec_dom)

          local numeral = DEGREE_NUMERALS[degree]
          if quality == 'minor' then
            numeral = numeral:lower()
          end

          table.insert(suggestions, {
            chord = chord_name,
            strudel = strudel,
            strudel_notes = strudel_notes,
            strudel_degrees = nil,
            degree = nil,
            function_name = string.format('V7/%s (secondary dominant)', numeral),
            category = 'secondary',
            relevance = 0.6,
            chord_obj = sec_dom,
          })
        end
      end
    end
  end

  return suggestions
end

---Generate common chord substitutions
---@param root string Key root
---@param scale_name string Scale name
---@return ChordSuggestion[]
function M.get_substitution_suggestions(root, scale_name)
  local suggestions = {}
  local root_pc = scales.note_name_to_pc(root)
  if not root_pc then
    return suggestions
  end

  -- Tritone substitution for V7
  local dominant_pc = (root_pc + 7) % 12
  local tritone_sub_pc = (dominant_pc + 6) % 12
  local tritone_sub = chords.build_chord(tritone_sub_pc, 'dom7')

  if tritone_sub then
    table.insert(suggestions, {
      chord = chords.chord_name(tritone_sub),
      strudel = chords.chord_to_strudel(tritone_sub),
      strudel_notes = chords.chord_to_strudel_notes(tritone_sub),
      strudel_degrees = nil,
      degree = nil,
      function_name = 'bII7 (tritone sub for V7)',
      category = 'substitution',
      relevance = 0.5,
      chord_obj = tritone_sub,
    })
  end

  -- Neapolitan chord (bII)
  local neapolitan_pc = (root_pc + 1) % 12
  local neapolitan = chords.build_chord(neapolitan_pc, 'major')

  if neapolitan then
    table.insert(suggestions, {
      chord = chords.chord_name(neapolitan),
      strudel = chords.chord_to_strudel(neapolitan),
      strudel_notes = chords.chord_to_strudel_notes(neapolitan),
      strudel_degrees = nil,
      degree = nil,
      function_name = 'bII (Neapolitan)',
      category = 'substitution',
      relevance = 0.4,
      chord_obj = neapolitan,
    })
  end

  return suggestions
end

---Generate borrowed chord suggestions (modal interchange)
---@param root string Key root
---@param scale_name string Scale name
---@return ChordSuggestion[]
function M.get_borrowed_suggestions(root, scale_name)
  local suggestions = {}
  local root_pc = scales.note_name_to_pc(root)
  if not root_pc then
    return suggestions
  end

  -- Determine parallel mode to borrow from
  local borrow_from
  if scale_name == 'major' or scale_name == 'ionian' then
    borrow_from = 'natural_minor'
  elseif scale_name == 'natural_minor' or scale_name == 'aeolian' then
    borrow_from = 'major'
  else
    return suggestions -- Skip for other modes
  end

  -- Get diatonic chords from both modes
  local current_chords = chords.get_diatonic_chords(root, scale_name, true)
  local borrowed_chords = chords.get_diatonic_chords(root, borrow_from, true)

  -- Find chords that differ
  for degree = 1, math.min(#current_chords, #borrowed_chords) do
    local current = current_chords[degree]
    local borrowed = borrowed_chords[degree]

    -- Check if the chord type differs
    if current.type ~= borrowed.type then
      local chord_name = chords.chord_name(borrowed)
      local strudel = chords.chord_to_strudel(borrowed)
      local strudel_notes = chords.chord_to_strudel_notes(borrowed)

      local numeral = DEGREE_NUMERALS[degree]
      if borrowed.chord_type.quality == 'minor' or borrowed.chord_type.quality == 'diminished' then
        numeral = numeral:lower()
      end

      -- Add flat if the root is lowered
      local current_root_pc = current.root_pc
      local borrowed_root_pc = borrowed.root_pc
      if (borrowed_root_pc - root_pc) % 12 < (current_root_pc - root_pc) % 12 then
        numeral = 'b' .. numeral
      end

      table.insert(suggestions, {
        chord = chord_name,
        strudel = strudel,
        strudel_notes = strudel_notes,
        strudel_degrees = nil,
        degree = degree,
        function_name = string.format('%s (borrowed from %s)', numeral, borrow_from:gsub('_', ' ')),
        category = 'borrowed',
        relevance = 0.45,
        chord_obj = borrowed,
      })
    end
  end

  return suggestions
end

---Get all chord suggestions for a key
---@param analysis_result KeyAnalysisResult
---@param opts? table Options: include_secondary, include_substitutions, include_borrowed
---@return ChordSuggestion[]
function M.suggest_for_key(analysis_result, opts)
  opts = opts or {}
  opts.include_secondary = opts.include_secondary ~= false
  opts.include_substitutions = opts.include_substitutions ~= false
  opts.include_borrowed = opts.include_borrowed ~= false

  local suggestions = {}

  -- Always include diatonic chords
  local diatonic = M.get_diatonic_suggestions(analysis_result.root, analysis_result.scale)
  for _, s in ipairs(diatonic) do
    table.insert(suggestions, s)
  end

  -- Secondary dominants
  if opts.include_secondary then
    local secondary = M.get_secondary_dominant_suggestions(analysis_result.root, analysis_result.scale)
    for _, s in ipairs(secondary) do
      table.insert(suggestions, s)
    end
  end

  -- Substitutions
  if opts.include_substitutions then
    local subs = M.get_substitution_suggestions(analysis_result.root, analysis_result.scale)
    for _, s in ipairs(subs) do
      table.insert(suggestions, s)
    end
  end

  -- Borrowed chords
  if opts.include_borrowed then
    local borrowed = M.get_borrowed_suggestions(analysis_result.root, analysis_result.scale)
    for _, s in ipairs(borrowed) do
      table.insert(suggestions, s)
    end
  end

  -- Adjust relevance based on analysis confidence
  local confidence_factor = analysis_result.confidence
  for _, s in ipairs(suggestions) do
    s.relevance = s.relevance * confidence_factor
  end

  -- Sort by relevance
  table.sort(suggestions, function(a, b)
    return a.relevance > b.relevance
  end)

  return suggestions
end

---Main suggest function - analyzes context and returns suggestions
---@param opts? table Options: scope ('line'|'selection'|'buffer'), bufnr
---@return ChordSuggestion[], KeyAnalysisResult|nil
function M.suggest(opts)
  opts = opts or {}
  local scope = opts.scope or 'line'
  local bufnr = opts.bufnr or 0

  local analysis

  if scope == 'line' then
    local line = vim.api.nvim_get_current_line()
    analysis = analyzer.analyze_line(line)
  elseif scope == 'selection' then
    -- Get visual selection range
    local start_line = vim.fn.line("'<")
    local end_line = vim.fn.line("'>")
    if start_line > 0 and end_line > 0 then
      analysis = analyzer.analyze_selection(start_line, end_line, bufnr)
    else
      -- Fallback to current line
      local line = vim.api.nvim_get_current_line()
      analysis = analyzer.analyze_line(line)
    end
  elseif scope == 'buffer' then
    analysis = analyzer.analyze_buffer(bufnr)
  end

  if not analysis then
    -- Default to C major if nothing detected
    analysis = {
      root = 'C',
      root_pc = 0,
      scale = 'major',
      scale_info = scales.SCALES.major,
      confidence = 0.1,
      all_matches = {},
      pitch_classes = {},
      note_count = 0,
      source_type = 'unknown',
    }
  end

  local suggestions = M.suggest_for_key(analysis, opts)
  return suggestions, analysis
end

---Get common chord progressions for a key
---@param root string Key root
---@param scale_name string Scale name
---@return table[] Array of { name, chords[] }
function M.get_common_progressions(root, scale_name)
  local diatonic = chords.get_diatonic_chords(root, scale_name, true)

  if scale_name == 'major' or scale_name == 'ionian' then
    return {
      {
        name = 'I - IV - V - I',
        chords = { diatonic[1], diatonic[4], diatonic[5], diatonic[1] },
      },
      {
        name = 'I - V - vi - IV',
        chords = { diatonic[1], diatonic[5], diatonic[6], diatonic[4] },
      },
      {
        name = 'ii - V - I',
        chords = { diatonic[2], diatonic[5], diatonic[1] },
      },
      {
        name = 'I - vi - IV - V',
        chords = { diatonic[1], diatonic[6], diatonic[4], diatonic[5] },
      },
      {
        name = 'vi - IV - I - V',
        chords = { diatonic[6], diatonic[4], diatonic[1], diatonic[5] },
      },
    }
  elseif scale_name:match('minor') then
    return {
      {
        name = 'i - iv - V - i',
        chords = { diatonic[1], diatonic[4], diatonic[5], diatonic[1] },
      },
      {
        name = 'i - VI - III - VII',
        chords = { diatonic[1], diatonic[6], diatonic[3], diatonic[7] },
      },
      {
        name = 'i - iv - VII - III',
        chords = { diatonic[1], diatonic[4], diatonic[7], diatonic[3] },
      },
    }
  end

  return {}
end

return M
