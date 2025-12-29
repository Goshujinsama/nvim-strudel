---@mod strudel.theory.chords Music theory chord definitions
---@brief [[
---Defines chord types and provides utilities for building and analyzing chords.
---Supports triads, seventh chords, and extended chords.
---@brief ]]

local scales = require('strudel.theory.scales')

local M = {}

---@class ChordType
---@field name string Short name (e.g., "maj7")
---@field full_name string Full name (e.g., "Major Seventh")
---@field intervals number[] Semitone intervals from root
---@field symbol string Symbol for display (e.g., "maj7", "m7")
---@field strudel_suffix string Suffix for Strudel chord() notation
---@field quality 'major'|'minor'|'diminished'|'augmented'|'dominant'|'suspended' Chord quality

---All supported chord types
---@type table<string, ChordType>
M.CHORD_TYPES = {
  -- Triads
  major = {
    name = 'maj',
    full_name = 'Major',
    intervals = { 0, 4, 7 },
    symbol = '',
    strudel_suffix = '',
    quality = 'major',
  },
  minor = {
    name = 'min',
    full_name = 'Minor',
    intervals = { 0, 3, 7 },
    symbol = 'm',
    strudel_suffix = 'm',
    quality = 'minor',
  },
  diminished = {
    name = 'dim',
    full_name = 'Diminished',
    intervals = { 0, 3, 6 },
    symbol = 'dim',
    strudel_suffix = 'dim',
    quality = 'diminished',
  },
  augmented = {
    name = 'aug',
    full_name = 'Augmented',
    intervals = { 0, 4, 8 },
    symbol = 'aug',
    strudel_suffix = 'aug',
    quality = 'augmented',
  },
  sus2 = {
    name = 'sus2',
    full_name = 'Suspended Second',
    intervals = { 0, 2, 7 },
    symbol = 'sus2',
    strudel_suffix = 'sus2',
    quality = 'suspended',
  },
  sus4 = {
    name = 'sus4',
    full_name = 'Suspended Fourth',
    intervals = { 0, 5, 7 },
    symbol = 'sus4',
    strudel_suffix = 'sus4',
    quality = 'suspended',
  },

  -- Seventh chords
  maj7 = {
    name = 'M7',
    full_name = 'Major Seventh',
    intervals = { 0, 4, 7, 11 },
    symbol = 'M7',
    strudel_suffix = 'M7',
    quality = 'major',
  },
  dom7 = {
    name = '7',
    full_name = 'Dominant Seventh',
    intervals = { 0, 4, 7, 10 },
    symbol = '7',
    strudel_suffix = '7',
    quality = 'dominant',
  },
  min7 = {
    name = 'm7',
    full_name = 'Minor Seventh',
    intervals = { 0, 3, 7, 10 },
    symbol = 'm7',
    strudel_suffix = 'm7',
    quality = 'minor',
  },
  dim7 = {
    name = 'dim7',
    full_name = 'Diminished Seventh',
    intervals = { 0, 3, 6, 9 },
    symbol = 'dim7',
    strudel_suffix = 'dim7',
    quality = 'diminished',
  },
  half_dim7 = {
    name = 'm7b5',
    full_name = 'Half-Diminished Seventh',
    intervals = { 0, 3, 6, 10 },
    symbol = 'm7b5',
    strudel_suffix = 'm7b5',
    quality = 'diminished',
  },
  min_maj7 = {
    name = 'mM7',
    full_name = 'Minor Major Seventh',
    intervals = { 0, 3, 7, 11 },
    symbol = 'mM7',
    strudel_suffix = 'mM7',
    quality = 'minor',
  },
  aug7 = {
    name = 'aug7',
    full_name = 'Augmented Seventh',
    intervals = { 0, 4, 8, 10 },
    symbol = 'aug7',
    strudel_suffix = 'aug7',
    quality = 'augmented',
  },
  aug_maj7 = {
    name = 'augM7',
    full_name = 'Augmented Major Seventh',
    intervals = { 0, 4, 8, 11 },
    symbol = 'augM7',
    strudel_suffix = 'augM7',
    quality = 'augmented',
  },

  -- Sixth chords
  maj6 = {
    name = '6',
    full_name = 'Major Sixth',
    intervals = { 0, 4, 7, 9 },
    symbol = '6',
    strudel_suffix = '6',
    quality = 'major',
  },
  min6 = {
    name = 'm6',
    full_name = 'Minor Sixth',
    intervals = { 0, 3, 7, 9 },
    symbol = 'm6',
    strudel_suffix = 'm6',
    quality = 'minor',
  },

  -- Extended chords
  dom9 = {
    name = '9',
    full_name = 'Dominant Ninth',
    intervals = { 0, 4, 7, 10, 14 },
    symbol = '9',
    strudel_suffix = '9',
    quality = 'dominant',
  },
  maj9 = {
    name = 'M9',
    full_name = 'Major Ninth',
    intervals = { 0, 4, 7, 11, 14 },
    symbol = 'M9',
    strudel_suffix = 'M9',
    quality = 'major',
  },
  min9 = {
    name = 'm9',
    full_name = 'Minor Ninth',
    intervals = { 0, 3, 7, 10, 14 },
    symbol = 'm9',
    strudel_suffix = 'm9',
    quality = 'minor',
  },
  dom11 = {
    name = '11',
    full_name = 'Dominant Eleventh',
    intervals = { 0, 4, 7, 10, 14, 17 },
    symbol = '11',
    strudel_suffix = '11',
    quality = 'dominant',
  },
  min11 = {
    name = 'm11',
    full_name = 'Minor Eleventh',
    intervals = { 0, 3, 7, 10, 14, 17 },
    symbol = 'm11',
    strudel_suffix = 'm11',
    quality = 'minor',
  },
  dom13 = {
    name = '13',
    full_name = 'Dominant Thirteenth',
    intervals = { 0, 4, 7, 10, 14, 21 },
    symbol = '13',
    strudel_suffix = '13',
    quality = 'dominant',
  },
  maj13 = {
    name = 'M13',
    full_name = 'Major Thirteenth',
    intervals = { 0, 4, 7, 11, 14, 21 },
    symbol = 'M13',
    strudel_suffix = 'M13',
    quality = 'major',
  },
  min13 = {
    name = 'm13',
    full_name = 'Minor Thirteenth',
    intervals = { 0, 3, 7, 10, 14, 21 },
    symbol = 'm13',
    strudel_suffix = 'm13',
    quality = 'minor',
  },

  -- Add chords
  add9 = {
    name = 'add9',
    full_name = 'Add Nine',
    intervals = { 0, 4, 7, 14 },
    symbol = 'add9',
    strudel_suffix = 'add9',
    quality = 'major',
  },
  min_add9 = {
    name = 'madd9',
    full_name = 'Minor Add Nine',
    intervals = { 0, 3, 7, 14 },
    symbol = 'madd9',
    strudel_suffix = 'madd9',
    quality = 'minor',
  },

  -- Power chord
  power = {
    name = '5',
    full_name = 'Power Chord',
    intervals = { 0, 7 },
    symbol = '5',
    strudel_suffix = '5',
    quality = 'major',
  },
}

---@class Chord
---@field root string Root note name
---@field root_pc number Root pitch class
---@field type string Chord type key
---@field chord_type ChordType Full chord type info
---@field notes string[] Note names in the chord
---@field pcs number[] Pitch classes in the chord

---Build a chord from root and type
---@param root string|number Root note (name or pitch class)
---@param chord_type_name string Chord type name from CHORD_TYPES
---@param octave? number Base octave (default 3)
---@return Chord|nil
function M.build_chord(root, chord_type_name, octave)
  local chord_type = M.CHORD_TYPES[chord_type_name]
  if not chord_type then
    return nil
  end

  octave = octave or 3

  local root_pc
  local root_name
  if type(root) == 'string' then
    root_pc = scales.note_name_to_pc(root)
    root_name = root:sub(1, 1):upper() .. root:sub(2):lower():gsub('s', '#')
    if not root_pc then
      return nil
    end
  else
    root_pc = root % 12
    root_name = scales.pc_to_note_name(root_pc)
  end

  local pcs = {}
  local notes = {}
  for _, interval in ipairs(chord_type.intervals) do
    local pc = (root_pc + interval) % 12
    table.insert(pcs, pc)
    -- Calculate actual note with octave
    local note_octave = octave + math.floor((root_pc + interval) / 12)
    table.insert(notes, scales.pc_to_note_name(pc) .. note_octave)
  end

  return {
    root = root_name,
    root_pc = root_pc,
    type = chord_type_name,
    chord_type = chord_type,
    notes = notes,
    pcs = pcs,
  }
end

---Get the full chord name (e.g., "Cmaj7", "F#m")
---@param chord Chord
---@return string
function M.chord_name(chord)
  return chord.root .. chord.chord_type.symbol
end

---Get the Strudel notation for a chord (for chord() function)
---@param chord Chord
---@return string
function M.chord_to_strudel(chord)
  return chord.root .. chord.chord_type.strudel_suffix
end

---Get the Strudel notation as note names (for note() function)
---@param chord Chord
---@return string
function M.chord_to_strudel_notes(chord)
  return table.concat(chord.notes, ' ')
end

---Convert chord to scale degrees relative to a key
---@param chord Chord
---@param key_root string|number Key root
---@param scale_name string Scale name
---@return string|nil Strudel n() notation or nil if notes don't fit scale
function M.chord_to_degrees(chord, key_root, scale_name)
  local key_pc
  if type(key_root) == 'string' then
    key_pc = scales.note_name_to_pc(key_root)
    if not key_pc then
      return nil
    end
  else
    key_pc = key_root % 12
  end

  local scale = scales.SCALES[scale_name]
  if not scale then
    return nil
  end

  local degrees = {}
  for _, interval in ipairs(chord.chord_type.intervals) do
    local pc = (chord.root_pc + interval) % 12
    local semitones_from_root = (pc - key_pc) % 12

    -- Find which scale degree this corresponds to
    local found = false
    for degree_idx, scale_interval in ipairs(scale.intervals) do
      if scale_interval == semitones_from_root then
        -- Convert to 0-indexed for Strudel n()
        table.insert(degrees, degree_idx - 1)
        found = true
        break
      end
    end

    if not found then
      -- Note is not in the scale, can't represent as pure degrees
      return nil
    end
  end

  return table.concat(degrees, ' ')
end

---Parse a chord symbol string
---@param chord_str string Chord symbol (e.g., "Cmaj7", "F#m", "Bb7")
---@return Chord|nil
function M.parse_chord(chord_str)
  -- Match root note (with optional accidental) and suffix
  local root, suffix = chord_str:match('^([A-Ga-g][#bsS]?)(.*)$')
  if not root then
    return nil
  end

  -- Normalize root
  root = root:sub(1, 1):upper() .. root:sub(2):lower():gsub('s', '#')

  -- Find matching chord type by suffix
  local matched_type = nil
  local matched_key = nil

  -- Try to match suffix against chord types (prefer longer matches)
  local best_match_len = 0
  for key, chord_type in pairs(M.CHORD_TYPES) do
    if suffix == chord_type.strudel_suffix and #chord_type.strudel_suffix > best_match_len then
      matched_type = chord_type
      matched_key = key
      best_match_len = #chord_type.strudel_suffix
    elseif suffix == chord_type.symbol and #chord_type.symbol > best_match_len then
      matched_type = chord_type
      matched_key = key
      best_match_len = #chord_type.symbol
    end
  end

  -- Default to major if no suffix
  if not matched_type and suffix == '' then
    matched_type = M.CHORD_TYPES.major
    matched_key = 'major'
  end

  if not matched_type then
    return nil
  end

  return M.build_chord(root, matched_key)
end

---Get the diatonic chord for a scale degree
---@param degree number Scale degree (1-7)
---@param root string|number Key root
---@param scale_name string Scale name
---@return Chord|nil
function M.diatonic_chord(degree, root, scale_name)
  local scale = scales.SCALES[scale_name]
  if not scale then
    return nil
  end

  local root_pc
  if type(root) == 'string' then
    root_pc = scales.note_name_to_pc(root)
    if not root_pc then
      return nil
    end
  else
    root_pc = root % 12
  end

  -- Get the root of this chord (the scale degree)
  local chord_root_pc = (root_pc + scale.intervals[degree]) % 12

  -- Stack thirds from the scale to determine chord quality
  local num_degrees = #scale.intervals

  -- Get interval to 3rd (2 scale degrees up)
  local third_degree = ((degree - 1 + 2) % num_degrees) + 1
  local third_interval = (scale.intervals[third_degree] - scale.intervals[degree]) % 12

  -- Get interval to 5th (4 scale degrees up)
  local fifth_degree = ((degree - 1 + 4) % num_degrees) + 1
  local fifth_interval = (scale.intervals[fifth_degree] - scale.intervals[degree]) % 12

  -- Get interval to 7th (6 scale degrees up) for seventh chords
  local seventh_degree = ((degree - 1 + 6) % num_degrees) + 1
  local seventh_interval = (scale.intervals[seventh_degree] - scale.intervals[degree]) % 12

  -- Determine chord type based on intervals
  local chord_type_name
  if third_interval == 4 and fifth_interval == 7 then
    -- Major third + perfect fifth = major
    if seventh_interval == 11 then
      chord_type_name = 'maj7'
    elseif seventh_interval == 10 then
      chord_type_name = 'dom7'
    else
      chord_type_name = 'major'
    end
  elseif third_interval == 3 and fifth_interval == 7 then
    -- Minor third + perfect fifth = minor
    if seventh_interval == 10 then
      chord_type_name = 'min7'
    elseif seventh_interval == 11 then
      chord_type_name = 'min_maj7'
    else
      chord_type_name = 'minor'
    end
  elseif third_interval == 3 and fifth_interval == 6 then
    -- Minor third + diminished fifth = diminished
    if seventh_interval == 9 then
      chord_type_name = 'dim7'
    elseif seventh_interval == 10 then
      chord_type_name = 'half_dim7'
    else
      chord_type_name = 'diminished'
    end
  elseif third_interval == 4 and fifth_interval == 8 then
    -- Major third + augmented fifth = augmented
    chord_type_name = 'augmented'
  else
    -- Default to major triad
    chord_type_name = 'major'
  end

  return M.build_chord(chord_root_pc, chord_type_name)
end

---Get all diatonic chords for a key
---@param root string|number Key root
---@param scale_name string Scale name
---@param use_sevenths? boolean Include seventh chords (default true)
---@return Chord[]
function M.get_diatonic_chords(root, scale_name, use_sevenths)
  if use_sevenths == nil then
    use_sevenths = true
  end

  local scale = scales.SCALES[scale_name]
  if not scale then
    return {}
  end

  local chords = {}
  for degree = 1, #scale.intervals do
    local chord = M.diatonic_chord(degree, root, scale_name)
    if chord then
      table.insert(chords, chord)
    end
  end

  return chords
end

---Get list of all chord type names
---@return string[]
function M.get_chord_type_names()
  local names = {}
  for name, _ in pairs(M.CHORD_TYPES) do
    table.insert(names, name)
  end
  table.sort(names)
  return names
end

---Identify chord quality from a set of pitch classes
---@param pcs number[] Pitch classes in the chord
---@return string|nil chord_type_name, number|nil root_pc
function M.identify_chord(pcs)
  if #pcs < 2 then
    return nil, nil
  end

  -- Sort pitch classes
  local sorted_pcs = {}
  for _, pc in ipairs(pcs) do
    table.insert(sorted_pcs, pc % 12)
  end
  table.sort(sorted_pcs)

  -- Remove duplicates
  local unique_pcs = { sorted_pcs[1] }
  for i = 2, #sorted_pcs do
    if sorted_pcs[i] ~= sorted_pcs[i - 1] then
      table.insert(unique_pcs, sorted_pcs[i])
    end
  end

  -- Try each pitch class as root
  local best_match = nil
  local best_root = nil
  local best_score = 0

  for _, root_pc in ipairs(unique_pcs) do
    -- Calculate intervals from this root
    local intervals = {}
    for _, pc in ipairs(unique_pcs) do
      table.insert(intervals, (pc - root_pc) % 12)
    end
    table.sort(intervals)

    -- Compare against each chord type
    for name, chord_type in pairs(M.CHORD_TYPES) do
      local chord_intervals = {}
      for _, i in ipairs(chord_type.intervals) do
        table.insert(chord_intervals, i % 12)
      end
      table.sort(chord_intervals)

      -- Count matching intervals
      local matches = 0
      for _, int1 in ipairs(intervals) do
        for _, int2 in ipairs(chord_intervals) do
          if int1 == int2 then
            matches = matches + 1
            break
          end
        end
      end

      -- Score based on matches and size similarity
      local score = matches / math.max(#intervals, #chord_intervals)

      if score > best_score then
        best_score = score
        best_match = name
        best_root = root_pc
      end
    end
  end

  if best_score >= 0.6 then
    return best_match, best_root
  end
  return nil, nil
end

return M
